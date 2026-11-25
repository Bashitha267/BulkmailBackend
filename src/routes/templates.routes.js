import { Router } from 'express';
import { db, saveStore } from '../data/store.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (_req, res) => {
  res.json({ success: true, templates: db.templates });
});

router.post('/', (req, res) => {
  const { name, category, icon, subject, previewText, heading, body, ctaLabel, ctaUrl, ctaColor, blocks } = req.body || {};
  if (!name) {
    return res.status(400).json({ success: false, message: 'Template name is required.' });
  }

  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString().slice(-4)}`;
  const newTemplate = {
    id,
    name: name.trim(),
    category: category || 'Newsletter',
    icon: icon || '✉️',
    subject: subject || `${name.trim()}, {{firstName}}`,
    previewText: previewText || 'Preview text for your subscribers',
    heading: heading || 'Hello {{firstName}}',
    body: body || 'Write your email message here...',
    ctaLabel: ctaLabel || 'Read more',
    ctaUrl: ctaUrl || 'https://example.com',
    ctaColor: ctaColor || '#111111',
    blocks: blocks || undefined,
  };

  db.templates.push(newTemplate);
  saveStore();

  return res.status(201).json({ success: true, template: newTemplate });
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const tpl = db.templates.find((t) => t.id === id);
  if (!tpl) {
    return res.status(404).json({ success: false, message: 'Template not found.' });
  }

  const fields = ['name', 'category', 'icon', 'subject', 'previewText', 'heading', 'body', 'ctaLabel', 'ctaUrl', 'ctaColor', 'blocks'];
  for (const key of fields) {
    if (req.body[key] !== undefined) {
      tpl[key] = req.body[key];
    }
  }

  saveStore();
  return res.json({ success: true, template: tpl });
});

export default router;
