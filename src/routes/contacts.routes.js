import { Router } from 'express';
import { query, one, tx, parseJson } from '../config/db.js';
import { env } from '../config/env.js';
import { requireAuth, editorsWrite, asyncRoute, httpError } from '../middleware/auth.js';
import { chunk, initialsOf, isValidEmail, normalizeEmail, randomHex, slugify, splitName } from '../lib/util.js';
import { serializeContact, groupsFor, recordContactEvent, setContactStatus } from '../services/contacts.service.js';
import { compileSegment, serializeSegment } from '../services/segments.service.js';
import { enrollOnGroupJoin } from '../services/automations.service.js';
import { audit, getSettings, saveSetting } from '../services/settings.service.js';
import { renderEmail } from '../services/render.service.js';
import { sendEmail } from '../services/ses.service.js';
import { sendingAllowance } from '../services/worker.service.js';

const router = Router();
router.use(requireAuth, editorsWrite);

const STATUS_FILTERS = {
  receivable: "c.status = 'Subscribed'",
  unsubscribed: "c.status = 'Unsubscribed'",
  bounced: "c.status = 'Bounced'",
  complained: "c.status = 'Complained'",
};

async function buildFilter(q) {
  const where = ['1 = 1'];
  const params = [];
  if (STATUS_FILTERS[q.status]) where.push(STATUS_FILTERS[q.status]);
  if (q.q) {
    const like = `%${String(q.q).trim().replace(/[%_\\]/g, '\\$&')}%`;
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.city LIKE ?)');
    params.push(like, like, like);
  }
  if (q.groupId) {
    where.push('EXISTS (SELECT 1 FROM contact_groups g WHERE g.contact_id = c.id AND g.group_id = ?)');
    params.push(String(q.groupId));
  }
  if (q.segmentId) {
    const seg = await one('SELECT * FROM segments WHERE id = ?', [String(q.segmentId)]);
    if (seg) {
      const compiled = compileSegment(serializeSegment(seg));
      where.push(compiled.sql);
      params.push(...compiled.params);
    }
  }
  return { sql: where.join(' AND '), params };
}

export async function contactCounts() {
  const [row] = await query(
    `SELECT COUNT(*) AS total, SUM(status = 'Subscribed') AS receivable, SUM(status = 'Unsubscribed') AS unsubscribed,
            SUM(status = 'Bounced') AS bounced, SUM(status = 'Complained') AS complained FROM contacts`
  );
  const [{ g }] = await query('SELECT (SELECT COUNT(*) FROM groups_list) + (SELECT COUNT(*) FROM segments) AS g');
  return {
    total: Number(row.total) || 0,
    receivable: Number(row.receivable) || 0,
    unsubscribed: Number(row.unsubscribed) || 0,
    bounced: Number(row.bounced) || 0,
    complained: Number(row.complained) || 0,
    groupsAndSegments: Number(g) || 0,
  };
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = await buildFilter(req.query);
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM contacts c WHERE ${filter.sql}`, filter.params);
    const rows = await query(
      `SELECT c.* FROM contacts c WHERE ${filter.sql} ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`,
      [...filter.params, pageSize, (page - 1) * pageSize]
    );
    const groups = await groupsFor(rows.map((r) => r.id));
    res.json({
      success: true,
      contacts: rows.map((r) => serializeContact(r, groups.get(r.id))),
      total: Number(n),
      page,
      pageSize,
      counts: await contactCounts(),
    });
  })
);

router.get(
  '/counts',
  asyncRoute(async (_req, res) => res.json({ success: true, counts: await contactCounts() }))
);

function csvCell(v) {
  const s = String(v ?? '');
  // Leading = + - @ would run as a formula when opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

router.get(
  '/export.csv',
  asyncRoute(async (req, res) => {
    const filter = await buildFilter(req.query);
    const settings = await getSettings();
    const custom = settings.fields.filter((f) => !f.builtIn);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(
      `${['Email', 'First name', 'Last name', 'City', 'Plan', ...custom.map((f) => f.name), 'Status', 'Groups', 'Consent source', 'Added']
        .map(csvCell)
        .join(',')}\n`
    );
    let offset = 0;
    for (;;) {
      const rows = await query(
        `SELECT c.* FROM contacts c WHERE ${filter.sql} ORDER BY c.created_at, c.id LIMIT 1000 OFFSET ?`,
        [...filter.params, offset]
      );
      if (!rows.length) break;
      const groups = await groupsFor(rows.map((r) => r.id));
      for (const r of rows) {
        const c = serializeContact(r, groups.get(r.id));
        res.write(
          `${[
            c.email,
            c.firstName,
            c.lastName,
            c.city,
            c.plan,
            ...custom.map((f) => c.customFields[f.key] ?? ''),
            c.status,
            c.groups.map((g) => g.name).join('; '),
            c.consent.source,
            new Date(c.createdAt).toISOString().slice(0, 10),
          ]
            .map(csvCell)
            .join(',')}\n`
        );
      }
      offset += rows.length;
    }
    await audit(req.user.name, `exported ${offset} contacts`);
    res.end();
  })
);

router.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Contact not found.');
    const groups = (await groupsFor([row.id])).get(row.id);
    const events = await query(
      `SELECT e.id, e.type, e.title, e.detail, e.created_at, e.campaign_id FROM events e
       WHERE e.contact_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
      [row.id]
    );
    const segments = [];
    for (const seg of (await query('SELECT * FROM segments ORDER BY name')).map(serializeSegment)) {
      const compiled = compileSegment(seg);
      const [hit] = await query(`SELECT 1 AS hit FROM contacts c WHERE c.id = ? AND ${compiled.sql}`, [row.id, ...compiled.params]);
      if (hit) segments.push({ id: seg.id, name: seg.name });
    }
    res.json({
      success: true,
      contact: serializeContact(row, groups),
      segments,
      activity: events.map((e) => ({
        id: e.id,
        type: e.type,
        title: e.title,
        detail: e.detail,
        at: e.created_at,
        campaignId: e.campaign_id,
      })),
    });
  })
);

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------
function cleanFields(input, settings) {
  const out = {};
  const allowed = new Set(settings.fields.filter((f) => !f.builtIn).map((f) => f.key));
  for (const [k, v] of Object.entries(input || {})) {
    if (allowed.has(k) && v !== undefined && v !== null) out[k] = String(v).slice(0, 255);
  }
  return out;
}

async function validGroupIds(idsOrNames) {
  if (!Array.isArray(idsOrNames) || !idsOrNames.length) return [];
  const vals = idsOrNames.map(String);
  const rows = await query('SELECT id FROM groups_list WHERE id IN (?) OR name IN (?)', [vals, vals]);
  return rows.map((r) => r.id);
}

export async function addToGroups(contactIds, groupIds, db = null) {
  if (!contactIds.length || !groupIds.length) return;
  const values = contactIds.flatMap((c) => groupIds.map((g) => [c, g]));
  const q = db ? (s, p) => db.query(s, p) : query;
  for (const part of chunk(values, 1000)) {
    await q('INSERT IGNORE INTO contact_groups (contact_id, group_id) VALUES ?', [part]);
  }
}

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const email = normalizeEmail(b.email);
    if (!isValidEmail(email)) throw httpError(400, 'Enter a valid email address.');
    if (await one('SELECT id FROM contacts WHERE email = ?', [email])) throw httpError(409, 'Someone with this email is already in your contacts.');

    const settings = await getSettings();
    const name = String(b.name || [b.firstName, b.lastName].filter(Boolean).join(' ') || email.split('@')[0]).trim().slice(0, 190);
    const { first, last } = b.firstName !== undefined ? { first: b.firstName, last: b.lastName || '' } : splitName(name);
    const id = `${slugify(email.split('@')[0], 40)}-${randomHex(4)}`;
    const groupIds = await validGroupIds(b.groupIds?.length ? b.groupIds : b.groups);
    const consentSource = typeof b.consent === 'string' ? b.consent : b.consent?.source || 'Added manually';
    const record = {
      source: String(consentSource).slice(0, 120),
      agreedTo: b.consent?.agreedTo || 'Marketing email',
      signedUp: b.consent?.when || null,
      addedBy: req.user.name,
      addedAt: new Date().toISOString(),
      doubleOptIn: false,
    };

    await query(
      `INSERT INTO contacts (id, name, initials, email, city, plan, consent, consent_date, status, first_name, last_name,
        custom_fields_json, consent_record_json, unsub_token, last_activity, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Subscribed', ?, ?, ?, ?, ?, 'Added', UTC_TIMESTAMP())`,
      [
        id,
        name,
        initialsOf(name, email),
        email,
        String(b.city || '').slice(0, 100),
        String(b.plan || '').slice(0, 40),
        record.source,
        new Date().toISOString().slice(0, 10),
        String(first).slice(0, 120),
        String(last).slice(0, 120),
        JSON.stringify(cleanFields(b.customFields, settings)),
        JSON.stringify(record),
        randomHex(16),
      ]
    );
    await addToGroups([id], groupIds);
    await recordContactEvent(id, { type: 'added', title: `Added by ${req.user.name}`, detail: record.source });
    await enrollOnGroupJoin([id], groupIds);
    const row = await one('SELECT * FROM contacts WHERE id = ?', [id]);
    res.status(201).json({ success: true, contact: serializeContact(row, (await groupsFor([id])).get(id)) });
  })
);

/**
 * CSV import. The browser parses and maps columns; this validates everything
 * again, skips existing emails (never changing their status) and records consent.
 */
router.post(
  '/import',
  asyncRoute(async (req, res) => {
    const { contacts: rows, groupIds: rawGroups, consent, newFields } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, 'The file has no rows to import.');
    if (rows.length > 50000) throw httpError(400, 'Import at most 50,000 rows at a time.');

    let settings = await getSettings({ fresh: true });
    if (Array.isArray(newFields) && newFields.length) {
      const fields = [...settings.fields];
      for (const f of newFields) {
        const key = slugify(f.key || f.name).replace(/-/g, '_').slice(0, 40);
        if (key && !fields.some((x) => x.key === key)) fields.push({ key, name: String(f.name || key).slice(0, 60), type: 'text' });
      }
      settings = await saveSetting('fields', fields);
    }

    const invalid = [];
    const seen = new Set();
    const clean = [];
    rows.forEach((r, i) => {
      const email = normalizeEmail(r.email);
      if (!isValidEmail(email)) {
        invalid.push({ row: i + 2, email: String(r.email || '').slice(0, 190) });
        return;
      }
      if (seen.has(email)) return;
      seen.add(email);
      clean.push({ ...r, email });
    });

    const existing = new Set();
    for (const part of chunk([...seen], 1000)) {
      for (const r of await query('SELECT email FROM contacts WHERE email IN (?)', [part])) existing.add(r.email);
    }
    const fresh = clean.filter((r) => !existing.has(r.email));
    const fallbackGroups = rows[0]?.groups;
    const groupIds = await validGroupIds(rawGroups?.length ? rawGroups : fallbackGroups);
    const importSource = typeof consent === 'string' ? consent : consent?.source || rows[0]?.consent || 'CSV import';
    const record = JSON.stringify({
      source: String(importSource).slice(0, 120),
      agreedTo: consent?.agreedTo || 'Marketing email',
      signedUp: consent?.when || null,
      importedBy: req.user.name,
      importedAt: new Date().toISOString(),
      doubleOptIn: false,
    });

    const ids = [];
    await tx(async (conn) => {
      for (const part of chunk(fresh, 500)) {
        const values = part.map((r) => {
          const name = String(r.name || [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email.split('@')[0])
            .trim()
            .slice(0, 190);
          const split = r.firstName !== undefined ? { first: r.firstName || '', last: r.lastName || '' } : splitName(name);
          const id = `${slugify(r.email.split('@')[0], 40)}-${randomHex(4)}`;
          ids.push(id);
          return [
            id,
            name,
            initialsOf(name, r.email),
            r.email,
            String(r.city || '').slice(0, 100),
            String(r.plan || '').slice(0, 40),
            String(consent.source).slice(0, 120),
            String(consent.when || new Date().toISOString().slice(0, 10)).slice(0, 60),
            'Subscribed',
            String(split.first).slice(0, 120),
            String(split.last).slice(0, 120),
            JSON.stringify(cleanFields(r.customFields, settings)),
            record,
            randomHex(16),
            'Imported',
          ];
        });
        await conn.query(
          `INSERT IGNORE INTO contacts (id, name, initials, email, city, plan, consent, consent_date, status,
            first_name, last_name, custom_fields_json, consent_record_json, unsub_token, last_activity) VALUES ?`,
          [values]
        );
      }
      await addToGroups(ids, groupIds, conn);
      for (const part of chunk(ids, 500)) {
        await conn.query('INSERT INTO events (type, contact_id, title, detail) VALUES ?', [
          part.map((id) => ['imported', id, `Imported by ${req.user.name}`, String(consent.source).slice(0, 120)]),
        ]);
      }
    });
    await enrollOnGroupJoin(ids, groupIds);
    await audit(req.user.name, `imported ${ids.length} contacts`);

    res.status(201).json({
      success: true,
      imported: ids.length,
      duplicates: rows.length - invalid.length - ids.length,
      invalid: invalid.length,
      invalidRows: invalid.slice(0, 500),
    });
  })
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Contact not found.');
    const b = req.body || {};
    const settings = await getSettings();
    const sets = [];
    const params = [];
    const set = (col, val) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };

    if (b.email !== undefined) {
      const email = normalizeEmail(b.email);
      if (!isValidEmail(email)) throw httpError(400, 'Enter a valid email address.');
      if (email !== row.email && (await one('SELECT id FROM contacts WHERE email = ?', [email]))) {
        throw httpError(409, 'Another contact already uses this email.');
      }
      set('email', email);
    }
    if (b.firstName !== undefined || b.lastName !== undefined || b.name !== undefined) {
      const first = b.firstName ?? row.first_name;
      const last = b.lastName ?? row.last_name;
      const name = String(b.name || [first, last].filter(Boolean).join(' ') || row.name).slice(0, 190);
      set('first_name', String(first).slice(0, 120));
      set('last_name', String(last).slice(0, 120));
      set('name', name);
      set('initials', initialsOf(name, row.email));
    }
    if (b.city !== undefined) set('city', String(b.city).slice(0, 100));
    if (b.plan !== undefined) set('plan', String(b.plan).slice(0, 40));
    if (b.customFields !== undefined) set('custom_fields_json', JSON.stringify(cleanFields(b.customFields, settings)));
    if (sets.length) await query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id]);

    if (Array.isArray(b.groupIds)) {
      const wanted = await validGroupIds(b.groupIds);
      const current = (await query('SELECT group_id FROM contact_groups WHERE contact_id = ?', [row.id])).map((r) => r.group_id);
      const added = wanted.filter((g) => !current.includes(g));
      const removed = current.filter((g) => !wanted.includes(g));
      if (removed.length) await query('DELETE FROM contact_groups WHERE contact_id = ? AND group_id IN (?)', [row.id, removed]);
      await addToGroups([row.id], added);
      if (added.length || removed.length) {
        await recordContactEvent(row.id, { type: 'groups', title: `Groups changed by ${req.user.name}` });
        await enrollOnGroupJoin([row.id], added);
      }
    }
    const fresh = await one('SELECT * FROM contacts WHERE id = ?', [row.id]);
    res.json({ success: true, contact: serializeContact(fresh, (await groupsFor([row.id])).get(row.id)) });
  })
);

router.post(
  '/:id/unsubscribe',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT id, name FROM contacts WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Contact not found.');
    await setContactStatus(row.id, 'Unsubscribed', { reason: `By ${req.user.name}` });
    await audit(req.user.name, `unsubscribed ${row.name}`);
    res.json({ success: true });
  })
);

router.post(
  '/:id/resubscribe',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT id, name, status FROM contacts WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Contact not found.');
    if (row.status === 'Complained') {
      throw httpError(409, 'People who marked you as spam can’t be resubscribed by the team. They can sign up again themselves.');
    }
    await setContactStatus(row.id, 'Subscribed', { reason: `By ${req.user.name}` });
    await audit(req.user.name, `resubscribed ${row.name}`);
    res.json({ success: true });
  })
);

router.post(
  '/:id/send-email',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT * FROM contacts WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Contact not found.');

    const b = req.body || {};
    const settings = await getSettings();
    const allowance = await sendingAllowance(settings);
    if (allowance.remaining < 1) {
      throw httpError(429, 'You’ve reached today’s sending limit.');
    }

    const defaultSender = settings.senders.find((s) => s.isDefault) || settings.senders[0];
    const fromEmail = normalizeEmail(b.fromEmail || defaultSender?.email || env.aws.fromEmail || '');
    const fromName = String(b.fromName || settings.general.fromName || env.aws.fromName || settings.general.teamName || '').trim().slice(0, 120);
    const replyTo = b.replyTo !== undefined ? normalizeEmail(b.replyTo) : normalizeEmail(settings.general.replyTo || '');
    if (!fromEmail || !isValidEmail(fromEmail)) {
      throw httpError(400, 'Choose a valid sender email in Settings first.');
    }

    let tpl = null;
    if (b.templateId) {
      tpl = await one('SELECT * FROM templates WHERE id = ?', [String(b.templateId)]);
      if (!tpl) throw httpError(400, 'Selected template no longer exists.');
    }

    const subject = String(b.subject || tpl?.subject || '').trim().slice(0, 255);
    if (!subject) throw httpError(400, 'Enter an email subject.');

    const rawBody = String(b.body || '').trim();
    let blocks = [];
    if (tpl && !rawBody) {
      blocks = parseJson(tpl.blocks_json, []) || [];
    } else {
      if (!rawBody) throw httpError(400, 'Write a message or choose a template.');
      blocks = rawBody
        .split(/\n{2,}/)
        .map((chunkText) => chunkText.trim())
        .filter(Boolean)
        .map((chunkText) => ({ type: 'text', text: chunkText }));
    }

    const previewText = String(b.previewText ?? tpl?.preview_text ?? '').trim().slice(0, 255);
    const contactObj = serializeContact(row);
    const rendered = renderEmail({
      blocks,
      subject,
      previewText,
      contact: contactObj,
      settings,
      unsubToken: row.unsub_token,
    });

    const result = await sendEmail({
      settings,
      to: row.email,
      fromName,
      fromEmail,
      replyTo,
      ...rendered,
    });

    await query('UPDATE contacts SET sent_count = sent_count + 1 WHERE id = ?', [row.id]);
    await recordContactEvent(row.id, {
      type: 'sent',
      title: `Sent email: ${rendered.subject}`,
      detail: `From ${fromEmail}${result.simulated ? ' (simulated)' : ''}`,
      activity: `Sent email: ${rendered.subject}`,
    });
    await audit(req.user.name, `sent direct email to ${row.email}`);

    res.json({
      success: true,
      simulated: result.simulated,
      messageId: result.messageId,
      subject: rendered.subject,
    });
  })
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await one('SELECT id, name, email FROM contacts WHERE id = ?', [req.params.id]);
    if (!row) throw httpError(404, 'Contact not found.');
    await tx(async (conn) => {
      await conn.query('DELETE FROM contact_groups WHERE contact_id = ?', [row.id]);
      await conn.query('DELETE FROM events WHERE contact_id = ?', [row.id]);
      await conn.query('DELETE FROM automation_runs WHERE contact_id = ?', [row.id]);
      await conn.query(
        "UPDATE campaign_recipients SET status = IF(status IN ('pending','held'), 'skipped', status), contact_id = NULL WHERE contact_id = ?",
        [row.id]
      );
      await conn.query('DELETE FROM contacts WHERE id = ?', [row.id]);
    });
    await audit(req.user.name, `deleted contact ${row.email}`);
    res.json({ success: true });
  })
);

export default router;
