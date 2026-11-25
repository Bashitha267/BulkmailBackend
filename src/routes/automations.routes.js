import { Router } from 'express';
import { query, one } from '../config/db.js';
import { requireAuth, editorsWrite, asyncRoute, httpError } from '../middleware/auth.js';
import { newId } from '../lib/util.js';
import { serializeAutomation, automationStats } from '../services/automations.service.js';
import { audit } from '../services/settings.service.js';

const router = Router();
router.use(requireAuth, editorsWrite);

function cleanSteps(steps) {
  if (!Array.isArray(steps)) throw httpError(400, 'Steps must be a list.');
  return steps.slice(0, 20).map((s) => {
    if (s.type === 'send') return { type: 'send', templateId: s.templateId ? String(s.templateId) : null, subject: String(s.subject || '').slice(0, 255) };
    if (s.type === 'wait') return { type: 'wait', days: Math.min(365, Math.max(0, Number(s.days) || 1)) };
    if (s.type === 'condition') return { type: 'condition', check: s.check === 'not_opened_previous' ? 'not_opened_previous' : 'not_clicked_previous' };
    throw httpError(400, `Unknown step type ${s.type}.`);
  });
}

async function withStats(row) {
  return serializeAutomation(row, await automationStats(row.id));
}

router.get(
  '/',
  asyncRoute(async (_req, res) => {
    const rows = await query('SELECT * FROM automations ORDER BY created_at, name');
    res.json({ success: true, automations: await Promise.all(rows.map(withStats)) });
  })
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 160);
    if (!name) throw httpError(400, 'Give the automation a name.');
    const id = newId(name, 120);
    await query("INSERT INTO automations (id, name, trigger_type, trigger_group_id, steps_json, active) VALUES (?, ?, 'group_join', ?, ?, 0)", [
      id,
      name,
      b.triggerGroupId || null,
      JSON.stringify(cleanSteps(b.steps || [{ type: 'send', templateId: null, subject: '' }])),
    ]);
    res.status(201).json({ success: true, automation: await withStats(await one('SELECT * FROM automations WHERE id = ?', [id])) });
  })
);

router.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT * FROM automations WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Automation not found.');
    const b = req.body || {};
    await query('UPDATE automations SET name = ?, trigger_group_id = ?, steps_json = COALESCE(?, steps_json) WHERE id = ?', [
      String(b.name ?? row.name).slice(0, 160),
      b.triggerGroupId !== undefined ? b.triggerGroupId || null : row.trigger_group_id,
      b.steps !== undefined ? JSON.stringify(cleanSteps(b.steps)) : null,
      row.id,
    ]);
    res.json({ success: true, automation: await withStats(await one('SELECT * FROM automations WHERE id = ?', [row.id])) });
  })
);

router.patch(
  '/:id/toggle',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT * FROM automations WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Automation not found.');
    const turningOn = !row.active;
    if (turningOn) {
      const a = serializeAutomation(row);
      if (!a.triggerGroupId) throw httpError(400, 'Choose which group starts this automation first.');
      const missing = a.steps.findIndex((s) => s.type === 'send' && !s.templateId);
      if (missing >= 0) throw httpError(400, `Step ${missing + 1} has no email chosen yet.`);
      if (!a.steps.some((s) => s.type === 'send')) throw httpError(400, 'Add at least one email step.');
    }
    await query('UPDATE automations SET active = ?, activated_at = IF(?, UTC_TIMESTAMP(), activated_at) WHERE id = ?', [
      turningOn ? 1 : 0,
      turningOn ? 1 : 0,
      row.id,
    ]);
    await audit(req.user.name, `turned ${turningOn ? 'on' : 'off'} ${row.name}`);
    res.json({ success: true, automation: await withStats(await one('SELECT * FROM automations WHERE id = ?', [row.id])) });
  })
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT name FROM automations WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Automation not found.');
    await query('DELETE FROM automation_runs WHERE automation_id = ?', [req.params.id]);
    await query('DELETE FROM automations WHERE id = ?', [req.params.id]);
    await audit(req.user.name, `deleted the automation ${row.name}`);
    res.json({ success: true });
  })
);

export default router;
