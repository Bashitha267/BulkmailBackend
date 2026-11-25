import { Router } from 'express';
import { query, one, tx } from '../config/db.js';
import { requireAuth, editorsWrite, asyncRoute, httpError } from '../middleware/auth.js';
import { newId } from '../lib/util.js';
import { audit } from '../services/settings.service.js';
import { enrollOnGroupJoin } from '../services/automations.service.js';
import { addToGroups } from './contacts.routes.js';

const router = Router();
router.use(requireAuth, editorsWrite);

export async function listGroups() {
  const rows = await query(
    `SELECT g.id, g.name, g.description, g.created_at,
       COUNT(c.id) AS total, COALESCE(SUM(c.status = 'Subscribed'), 0) AS can_receive
     FROM groups_list g
     LEFT JOIN contact_groups cg ON cg.group_id = g.id
     LEFT JOIN contacts c ON c.id = cg.contact_id
     GROUP BY g.id, g.name, g.description, g.created_at
     ORDER BY g.created_at, g.name`
  );
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description || '',
    total: Number(g.total),
    canReceive: Number(g.can_receive),
    createdAt: g.created_at,
  }));
}

router.get('/', asyncRoute(async (_req, res) => res.json({ success: true, groups: await listGroups() })));

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) throw httpError(400, 'Give the group a name.');
    if (await one('SELECT id FROM groups_list WHERE LOWER(name) = LOWER(?)', [name])) {
      throw httpError(409, 'A group with this name already exists.');
    }
    const id = newId(name, 120);
    await query('INSERT INTO groups_list (id, name, description, default_template) VALUES (?, ?, ?, ?)', [
      id,
      name,
      String(req.body?.description || '').slice(0, 255),
      '',
    ]);
    const contactIds = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(String) : [];
    if (contactIds.length) {
      await addToGroups(contactIds, [id]);
      await enrollOnGroupJoin(contactIds, [id]);
    }
    await audit(req.user.name, `created the group ${name}`);
    res.status(201).json({ success: true, group: (await listGroups()).find((g) => g.id === id) });
  })
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const g = await one('SELECT * FROM groups_list WHERE id = ?', [req.params.id]);
    if (!g) throw httpError(404, 'Group not found.');
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) : g.name;
    if (!name) throw httpError(400, 'Give the group a name.');
    await query('UPDATE groups_list SET name = ?, description = ? WHERE id = ?', [
      name,
      req.body?.description !== undefined ? String(req.body.description).slice(0, 255) : g.description,
      g.id,
    ]);
    res.json({ success: true, group: (await listGroups()).find((x) => x.id === g.id) });
  })
);

/** Adds contacts to a group (e.g. bulk action from the contacts table). */
router.post(
  '/:id/members',
  asyncRoute(async (req, res) => {
    const g = await one('SELECT id FROM groups_list WHERE id = ?', [req.params.id]);
    if (!g) throw httpError(404, 'Group not found.');
    const ids = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(String) : [];
    await addToGroups(ids, [g.id]);
    await enrollOnGroupJoin(ids, [g.id]);
    res.json({ success: true });
  })
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const g = await one('SELECT * FROM groups_list WHERE id = ?', [req.params.id]);
    if (!g) throw httpError(404, 'Group not found.');
    // Contacts stay; only the group and memberships go.
    await tx(async (conn) => {
      await conn.query('DELETE FROM contact_groups WHERE group_id = ?', [g.id]);
      await conn.query('DELETE FROM groups_list WHERE id = ?', [g.id]);
      await conn.query('UPDATE automations SET active = 0, trigger_group_id = NULL WHERE trigger_group_id = ?', [g.id]);
    });
    await audit(req.user.name, `deleted the group ${g.name}`);
    res.json({ success: true });
  })
);

export default router;
