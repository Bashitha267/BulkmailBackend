import { query, parseJson } from '../config/db.js';

export function serializeContact(row, groups = []) {
  return {
    id: row.id,
    name: row.name,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    initials: row.initials,
    email: row.email,
    city: row.city || '',
    plan: row.plan || '',
    status: row.status,
    groups,
    consent: {
      source: row.consent || '',
      date: row.consent_date || '',
      record: parseJson(row.consent_record_json, null),
    },
    customFields: parseJson(row.custom_fields_json, {}) || {},
    preferences: parseJson(row.preferences_json, null),
    stats: { received: row.sent_count || 0, opened: row.open_count || 0, clicked: row.click_count || 0 },
    lastActivity: row.last_activity || '',
    lastActivityAt: row.last_activity_at,
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
  };
}

/** Loads group memberships for many contacts with one query. */
export async function groupsFor(contactIds) {
  const map = new Map(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return map;
  const rows = await query(
    `SELECT cg.contact_id, g.id, g.name FROM contact_groups cg
     JOIN groups_list g ON g.id = cg.group_id WHERE cg.contact_id IN (?) ORDER BY g.name`,
    [contactIds]
  );
  for (const r of rows) map.get(r.contact_id)?.push({ id: r.id, name: r.name });
  return map;
}

/** Adds a timeline entry and updates the contact's "last activity". */
export async function recordContactEvent(contactId, { type, title, campaignId = null, detail = '', activity = null }, db = null) {
  if (!contactId) return;
  const q = db ? (sql, p) => db.query(sql, p) : query;
  await q('INSERT INTO events (type, contact_id, campaign_id, title, detail) VALUES (?, ?, ?, ?, ?)', [
    type,
    contactId,
    campaignId,
    String(title).slice(0, 255),
    String(detail || '').slice(0, 500),
  ]);
  if (activity) {
    await q('UPDATE contacts SET last_activity = ?, last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [activity, contactId]);
  }
}

const STATUS_COPY = {
  Unsubscribed: { title: 'Unsubscribed', activity: 'Unsubscribed' },
  Bounced: { title: 'Email bounced, stopped sending', activity: 'Bounced' },
  Complained: { title: 'Marked an email as spam, stopped sending', activity: 'Marked as spam' },
  Subscribed: { title: 'Subscribed again', activity: 'Resubscribed' },
};

/**
 * Changes a contact's status. Suppressing (anything but Subscribed) also takes
 * them out of every pending send and automation straight away.
 */
export async function setContactStatus(contactId, status, { reason = '', campaignId = null } = {}) {
  const res = await query(
    'UPDATE contacts SET status = ?, status_changed_at = UTC_TIMESTAMP() WHERE id = ? AND status <> ?',
    [status, contactId, status]
  );
  if (res.affectedRows === 0) return false;
  const copy = STATUS_COPY[status] || { title: `Status changed to ${status}`, activity: status };
  await recordContactEvent(contactId, { type: status.toLowerCase(), title: copy.title, detail: reason, campaignId, activity: copy.activity });

  if (status !== 'Subscribed') {
    await query(
      "UPDATE campaign_recipients SET status = 'skipped', error = ? WHERE contact_id = ? AND status IN ('pending', 'held')",
      [`Skipped: ${status.toLowerCase()}`, contactId]
    );
    await query("UPDATE automation_runs SET status = 'exited' WHERE contact_id = ? AND status = 'active'", [contactId]);
  }
  return true;
}

export const RECEIVABLE_SQL = "c.status = 'Subscribed'";
