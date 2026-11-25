import { Router } from 'express';
import { query, one, parseJson } from '../config/db.js';
import { requireAuth, editorsWrite, asyncRoute, httpError } from '../middleware/auth.js';
import { newId } from '../lib/util.js';
import { defaultBlocks } from '../lib/defaults.js';
import { renderEmail } from '../services/render.service.js';
import { getSettings, audit } from '../services/settings.service.js';

const router = Router();
router.use(requireAuth, editorsWrite);

const BLOCK_TYPES = new Set(['heading', 'text', 'button', 'image', 'columns', 'divider']);

export function cleanBlocks(blocks) {
  if (!Array.isArray(blocks)) return null;
  return blocks
    .filter((b) => b && BLOCK_TYPES.has(b.type))
    .slice(0, 60)
    .map((b, i) => {
      const s = (v, n = 5000) => String(v ?? '').slice(0, n);
      const base = { id: s(b.id || `b${i + 1}`, 40), type: b.type };
      switch (b.type) {
        case 'heading':
        case 'text':
          return { ...base, text: s(b.text) };
        case 'button':
          return { ...base, label: s(b.label, 120), url: s(b.url, 1000), color: s(b.color || '#111111', 20), corners: ['square', 'rounded', 'pill'].includes(b.corners) ? b.corners : 'rounded' };
        case 'image':
          return { ...base, url: s(b.url, 1000), alt: s(b.alt, 255), link: s(b.link, 1000) };
        case 'columns':
          return { ...base, left: s(b.left), right: s(b.right) };
        default:
          return base;
      }
    });
}

export function serializeTemplate(t) {
  const blocks =
    parseJson(t.blocks_json, null) ||
    defaultBlocks({ heading: t.heading, body: t.body, ctaLabel: t.cta_label, ctaUrl: t.cta_url, ctaColor: t.cta_color });
  return {
    id: t.id,
    name: t.name,
    category: t.category || 'Newsletter',
    subject: t.subject || '',
    previewText: t.preview_text || '',
    blocks,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const rows = await query('SELECT * FROM templates ORDER BY created_at, name');
    res.json({ success: true, templates: rows.map(serializeTemplate) });
  })
);

router.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const t = await one('SELECT * FROM templates WHERE id = ?', [req.params.id]);
    if (!t) throw httpError(404, 'Template not found.');
    res.json({ success: true, template: serializeTemplate(t) });
  })
);

/** Renders blocks to HTML and plain text for the editor's HTML / Plain text tabs. */
router.post(
  '/render',
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    const email = renderEmail({
      blocks: cleanBlocks(req.body?.blocks) || [],
      subject: String(req.body?.subject || ''),
      previewText: String(req.body?.previewText || ''),
      contact: req.body?.contact || { firstName: 'Jane', name: 'Jane Doe', email: 'jane@example.com' },
      settings,
      isTest: true,
    });
    res.json({ success: true, ...email });
  })
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 160);
    if (!name) throw httpError(400, 'Give the template a name.');
    let source = null;
    if (b.duplicateOf) source = await one('SELECT * FROM templates WHERE id = ?', [b.duplicateOf]);
    const base = source ? serializeTemplate(source) : null;
    const id = newId(name, 120);
    const blocks = cleanBlocks(b.blocks) || base?.blocks || defaultBlocks();
    await query(
      'INSERT INTO templates (id, name, category, icon, subject, preview_text, blocks_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, String(b.category || base?.category || 'Newsletter').slice(0, 60), '', String(b.subject ?? base?.subject ?? '').slice(0, 255), String(b.previewText ?? base?.previewText ?? '').slice(0, 255), JSON.stringify(blocks)]
    );
    await audit(req.user.name, `created the template ${name}`);
    res.status(201).json({ success: true, template: serializeTemplate(await one('SELECT * FROM templates WHERE id = ?', [id])) });
  })
);

router.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const t = await one('SELECT * FROM templates WHERE id = ?', [req.params.id]);
    if (!t) throw httpError(404, 'Template not found.');
    const b = req.body || {};
    const blocks = b.blocks !== undefined ? cleanBlocks(b.blocks) : null;
    await query('UPDATE templates SET name = ?, category = ?, subject = ?, preview_text = ?, blocks_json = COALESCE(?, blocks_json) WHERE id = ?', [
      String(b.name ?? t.name).slice(0, 160),
      String(b.category ?? t.category).slice(0, 60),
      String(b.subject ?? t.subject).slice(0, 255),
      String(b.previewText ?? t.preview_text).slice(0, 255),
      blocks ? JSON.stringify(blocks) : null,
      t.id,
    ]);
    res.json({ success: true, template: serializeTemplate(await one('SELECT * FROM templates WHERE id = ?', [t.id])) });
  })
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const t = await one('SELECT name FROM templates WHERE id = ?', [req.params.id]);
    if (!t) throw httpError(404, 'Template not found.');
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM campaigns WHERE template_id = ? AND status IN ('Scheduled','Sending','Starting')", [req.params.id]);
    if (Number(n)) throw httpError(409, 'A scheduled or sending campaign uses this template. Wait until it finishes.');
    await query('DELETE FROM templates WHERE id = ?', [req.params.id]);
    await audit(req.user.name, `deleted the template ${t.name}`);
    res.json({ success: true });
  })
);

export default router;
