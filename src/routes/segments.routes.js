import { Router } from 'express';
import { query, one } from '../config/db.js';
import { requireAuth, editorsWrite, asyncRoute, httpError } from '../middleware/auth.js';
import { newId } from '../lib/util.js';
import { compileRule, countSegment, serializeSegment } from '../services/segments.service.js';
import { audit } from '../services/settings.service.js';

const router = Router();
router.use(requireAuth, editorsWrite);

function readDefinition(body) {
  const rules = Array.isArray(body?.rules) ? body.rules.slice(0, 20) : [];
  const bad = rules.find((r) => !compileRule(r));
  if (bad) throw httpError(400, `This condition isn’t valid: ${JSON.stringify(bad)}`);
  return {
    matchType: body?.matchType === 'any' ? 'any' : 'all',
    rules,
    onlyReceivable: body?.onlyReceivable !== false,
  };
}

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const segments = (await query('SELECT * FROM segments ORDER BY created_at, name')).map(serializeSegment);
    for (const s of segments) s.count = (await countSegment(s, { sampleSize: 0 })).count;
    res.json({ success: true, segments });
  })
);

router.post(
  '/preview',
  asyncRoute(async (req, res) => {
    const def = readDefinition(req.body);
    const { count, sample } = await countSegment(def, { sampleSize: 3 });
    res.json({ success: true, count, sample: sample.map((s) => s.name || s.email) });
  })
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 160);
    if (!name) throw httpError(400, 'Give the segment a name.');
    const def = readDefinition(req.body);
    if (!def.rules.length) throw httpError(400, 'Add at least one condition.');
    const id = newId(name, 120);
    await query('INSERT INTO segments (id, name, match_type, rules_json, only_receivable) VALUES (?, ?, ?, ?, ?)', [
      id,
      name,
      def.matchType,
      JSON.stringify(def.rules),
      def.onlyReceivable ? 1 : 0,
    ]);
    await audit(req.user.name, `created the segment ${name}`);
    const seg = serializeSegment(await one('SELECT * FROM segments WHERE id = ?', [id]));
    seg.count = (await countSegment(seg, { sampleSize: 0 })).count;
    res.status(201).json({ success: true, segment: seg });
  })
);

router.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT * FROM segments WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Segment not found.');
    const def = readDefinition(req.body);
    if (!def.rules.length) throw httpError(400, 'Add at least one condition.');
    await query('UPDATE segments SET name = ?, match_type = ?, rules_json = ?, only_receivable = ? WHERE id = ?', [
      String(req.body?.name || row.name).slice(0, 160),
      def.matchType,
      JSON.stringify(def.rules),
      def.onlyReceivable ? 1 : 0,
      row.id,
    ]);
    const seg = serializeSegment(await one('SELECT * FROM segments WHERE id = ?', [row.id]));
    seg.count = (await countSegment(seg, { sampleSize: 0 })).count;
    res.json({ success: true, segment: seg });
  })
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT name FROM segments WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Segment not found.');
    await query('DELETE FROM segments WHERE id = ?', [req.params.id]);
    await audit(req.user.name, `deleted the segment ${row.name}`);
    res.json({ success: true });
  })
);

export default router;
