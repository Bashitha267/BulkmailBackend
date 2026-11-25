import { parseJson } from '../config/db.js';
import { DEFAULT_SETTINGS, defaultBlocks } from './defaults.js';
import { initialsOf, isValidEmail, normalizeEmail, randomHex, slugify, splitName, toInt } from './util.js';

/**
 * Copies a legacy workspace snapshot (the old JSON blob format) into the
 * relational tables. Uses INSERT IGNORE everywhere so it is safe to re-run.
 * Returns counts of what was written.
 */
export async function importWorkspaceSnapshot(db, data) {
  const counts = { contacts: 0, groups: 0, templates: 0, campaigns: 0, recipients: 0, segments: 0, automations: 0 };
  if (!data || typeof data !== 'object') return counts;

  // ---- groups (by name, since contacts reference groups by name) ------------
  const groupIdByName = new Map();
  const [existingGroups] = await db.query('SELECT id, name FROM groups_list');
  for (const g of existingGroups) groupIdByName.set(g.name.toLowerCase(), g.id);

  async function ensureGroup(name, extra = {}) {
    const key = String(name || '').trim();
    if (!key) return null;
    if (groupIdByName.has(key.toLowerCase())) return groupIdByName.get(key.toLowerCase());
    const id = extra.id || slugify(key);
    await db.query(
      'INSERT IGNORE INTO groups_list (id, name, description, default_template) VALUES (?, ?, ?, ?)',
      [id, key, extra.description || '', extra.defaultTemplate || '']
    );
    groupIdByName.set(key.toLowerCase(), id);
    counts.groups += 1;
    return id;
  }

  for (const g of data.groups || []) await ensureGroup(g.name, g);

  // ---- contacts -------------------------------------------------------------
  for (const c of data.contacts || []) {
    const email = normalizeEmail(c.email);
    if (!isValidEmail(email)) continue;
    const { first, last } = splitName(c.name);
    const status = ['Subscribed', 'Unsubscribed', 'Bounced', 'Complained'].includes(c.status) ? c.status : 'Subscribed';
    const id = c.id || slugify(email);
    const [res] = await db.query(
      `INSERT IGNORE INTO contacts
        (id, name, initials, email, city, plan, groups_json, consent, consent_date, last_activity, status,
         stats_json, consent_record_json, activity_json, first_name, last_name, unsub_token,
         sent_count, open_count, click_count, custom_fields_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        c.name || email,
        c.initials || initialsOf(c.name, email),
        email,
        c.city && c.city !== '—' ? c.city : '',
        c.plan || '',
        c.consent || 'Imported',
        c.consentDate || '',
        c.lastActivity || '',
        status,
        c.consentRecord ? JSON.stringify(c.consentRecord) : null,
        first,
        last,
        randomHex(16),
        toInt(c.stats?.received),
        toInt(c.stats?.opened),
        toInt(c.stats?.clicked),
        c.customFields ? JSON.stringify(c.customFields) : null,
      ]
    );
    if (res.affectedRows === 0) continue;
    counts.contacts += 1;

    for (const groupName of c.groups || []) {
      const gid = await ensureGroup(groupName);
      if (gid) await db.query('INSERT IGNORE INTO contact_groups (contact_id, group_id) VALUES (?, ?)', [id, gid]);
    }
    for (const a of (c.activity || []).slice(0, 50).reverse()) {
      await db.query('INSERT INTO events (type, contact_id, title, detail) VALUES (?, ?, ?, ?)', [
        a.type || 'note',
        id,
        String(a.title || '').slice(0, 255),
        a.time ? `Before upgrade: ${a.time}`.slice(0, 500) : '',
      ]);
    }
  }

  // ---- templates ------------------------------------------------------------
  for (const t of data.templates || []) {
    const blocks = Array.isArray(t.blocks) && t.blocks.length ? t.blocks : defaultBlocks(t);
    const [res] = await db.query(
      `INSERT IGNORE INTO templates
        (id, name, category, icon, subject, preview_text, heading, body, cta_label, cta_url, cta_color, blocks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id || slugify(t.name),
        t.name || 'Untitled template',
        t.category || 'Newsletter',
        t.icon || '',
        t.subject || '',
        t.previewText || '',
        t.heading || '',
        t.body || '',
        t.ctaLabel || '',
        t.ctaUrl || '',
        t.ctaColor || '#111111',
        JSON.stringify(blocks),
      ]
    );
    counts.templates += res.affectedRows;
  }

  // ---- campaigns ------------------------------------------------------------
  for (const c of data.campaigns || []) {
    const id = c.id || slugify(c.title);
    const progress = c.progress || {};
    const stats = c.stats || {};
    const sent = toInt(progress.sent ?? c.sent);
    const delivered = toInt(stats.delivered ?? c.delivered ?? sent);
    const pct = (v) => (v ? Number(String(v).replace('%', '')) / 100 : 0);
    const opened = toInt(stats.opened ?? Math.round(delivered * pct(c.openedRate)));
    const clicked = toInt(Math.round(delivered * pct(c.clickedRate)));
    const queue = Array.isArray(c.queue) ? c.queue : [];

    // Old scheduled dates were free text and old "Sending" campaigns were not
    // tracked per person, so nothing is resumed automatically after the upgrade.
    let status = c.status || 'Draft';
    let note = '';
    if (status === 'Scheduled') {
      status = 'Draft';
      note = 'Schedule needs to be set again after the upgrade.';
    } else if (status === 'Sending') {
      status = 'Paused';
      note = 'Paused during the upgrade. Review before resuming.';
    }
    const legacy = queue.length === 0 && ['Paused', 'Completed', 'Cancelled'].includes(status) ? 1 : 0;
    const groupIds = [];
    const groupPart = String(c.subtitle || '').split('·')[0];
    for (const name of groupPart.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (groupIdByName.has(name.toLowerCase())) groupIds.push(groupIdByName.get(name.toLowerCase()));
    }

    const [res] = await db.query(
      `INSERT IGNORE INTO campaigns
        (id, month, day, title, subtitle, description, status, subject_a, subject_b, ab_test, preview_text,
         from_name, from_email, reply_to, recipients_count, scheduled_date, group_ids_json, template_id,
         total_count, sent_count, delivered_count, opened_count, clicked_count, bounced_count,
         complaint_count, failed_count, unsubscribed_count, legacy, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        c.month || '',
        String(c.day ?? ''),
        c.title || 'Untitled campaign',
        c.subtitle || '',
        note || c.description || '',
        status,
        c.subjectA || c.subject || '',
        c.subjectB || '',
        c.abTest ? 1 : 0,
        c.previewText || '',
        c.fromName || '',
        c.fromEmail || '',
        c.replyTo || '',
        toInt(c.recipientsCount ?? progress.total),
        c.scheduledDate || '',
        JSON.stringify(groupIds),
        c.templateId || null,
        toInt(progress.total ?? c.recipientsCount ?? sent),
        sent,
        delivered,
        opened,
        clicked,
        toInt(stats.bounced ?? c.bounced),
        toInt(stats.complaints ?? c.complaints),
        toInt(stats.failed),
        toInt(c.unsubscribed),
        legacy,
        sent > 0 ? new Date() : null,
        status === 'Completed' ? new Date() : null,
      ]
    );
    if (res.affectedRows === 0) continue;
    counts.campaigns += 1;
    if (note) {
      await db.query('INSERT INTO events (type, campaign_id, title) VALUES (?, ?, ?)', ['upgrade', id, note]);
    }
    for (const item of queue) {
      const email = normalizeEmail(item.email);
      if (!isValidEmail(email)) continue;
      const qStatus = { pending: 'pending', sent: 'sent', failed: 'failed', cancelled: 'cancelled' }[item.status] || 'pending';
      const [r] = await db.query(
        `INSERT IGNORE INTO campaign_recipients (campaign_id, contact_id, email, name, status, error, sent_at)
         VALUES (?, (SELECT id FROM contacts WHERE email = ? LIMIT 1), ?, ?, ?, ?, ?)`,
        [id, email, email, item.name || '', qStatus, item.error || null, item.sentAt ? new Date(item.sentAt) : null]
      );
      counts.recipients += r.affectedRows;
    }
  }

  // ---- segments -------------------------------------------------------------
  const knownSegmentRules = {
    'engaged-30': {
      matchType: 'any',
      rules: [
        { field: 'opened_any', op: 'in_last_days', value: 30 },
        { field: 'clicked_any', op: 'in_last_days', value: 30 },
      ],
    },
    'no-open-bf': {
      matchType: 'all',
      rules: [{ field: 'campaign', op: 'not_opened', value: 'black-friday-early-access' }],
    },
    'pro-colombo': {
      matchType: 'all',
      rules: [
        { field: 'plan', op: 'is', value: 'Pro' },
        { field: 'city', op: 'is', value: 'Colombo' },
      ],
    },
  };
  for (const s of data.segments || []) {
    const known = knownSegmentRules[s.id] || { matchType: s.matchType || 'all', rules: s.rules || [] };
    const [res] = await db.query(
      'INSERT IGNORE INTO segments (id, name, match_type, rules_json) VALUES (?, ?, ?, ?)',
      [s.id || slugify(s.name), s.name || 'Segment', known.matchType, JSON.stringify(known.rules)]
    );
    counts.segments += res.affectedRows;
  }

  // ---- automations (imported switched OFF; the old ones never really ran) --
  for (const a of data.automations || []) {
    const triggerGroup = /Customers/i.test(a.trigger || '') ? 'customers' : 'newsletter';
    const gid = groupIdByName.get(triggerGroup) || null;
    const steps =
      a.id === 'welcome'
        ? [
            { type: 'send', templateId: 'welcome-series', subject: 'Welcome to {{teamName}}' },
            { type: 'wait', days: 3 },
            { type: 'condition', check: 'not_clicked_previous' },
            { type: 'send', templateId: null, subject: '3 tips to get started' },
          ]
        : [{ type: 'send', templateId: null, subject: a.name || '' }];
    const [res] = await db.query(
      `INSERT IGNORE INTO automations (id, name, trigger_type, trigger_group_id, steps_json, active)
       VALUES (?, ?, 'group_join', ?, ?, 0)`,
      [a.id || slugify(a.name), a.name || 'Automation', gid, JSON.stringify(steps)]
    );
    counts.automations += res.affectedRows;
  }

  // ---- settings -------------------------------------------------------------
  const s = data.settings || {};
  const settingsRows = {
    ses: {
      ...DEFAULT_SETTINGS.ses,
      sendRate: toInt(s.ses?.sendRate, DEFAULT_SETTINGS.ses.sendRate),
      retries: toInt(s.ses?.retries, DEFAULT_SETTINGS.ses.retries),
      dailyLimit: toInt(s.ses?.dailyLimit, DEFAULT_SETTINGS.ses.dailyLimit),
    },
    compliance: { ...DEFAULT_SETTINGS.compliance, ...(s.compliance || {}) },
    fields: mergeFields(s.fields),
    domains: (s.domains || []).map((d) => ({ name: d.name, addedAt: new Date().toISOString(), dkimTokens: [], records: {} })),
    senders: (s.senders || []).map((x) => ({ email: x.email, isDefault: Boolean(x.isDefault), verified: false })),
  };
  for (const [key, value] of Object.entries(settingsRows)) {
    await db.query('INSERT IGNORE INTO app_settings (setting_key, value_json) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }

  for (const entry of (s.auditLog || []).slice().reverse()) {
    const [actor, ...rest] = String(entry.action || '').split(' ');
    await db.query('INSERT INTO audit_log (actor, action) VALUES (?, ?)', [actor || 'System', rest.join(' ') || entry.action]);
  }

  return counts;
}

function mergeFields(legacyFields) {
  const out = [...DEFAULT_SETTINGS.fields];
  for (const f of legacyFields || []) {
    const key = f.id === 'lastPurchase' ? 'lastPurchase' : slugify(f.id || f.name).replace(/-/g, '_');
    if (out.some((x) => x.key === key)) continue;
    const type = /date/i.test(f.type) ? 'date' : /choice/i.test(f.type) ? 'choice' : /number/i.test(f.type) ? 'number' : 'text';
    const options = type === 'choice' ? String(f.type).split(':')[1]?.split(',').map((o) => o.trim()).filter(Boolean) : undefined;
    out.push({ key, name: f.name, type, ...(options ? { options } : {}) });
  }
  return out;
}

export async function readLegacySnapshot(db) {
  const [rows] = await db.query("SELECT state_value FROM workspace_state WHERE state_key = 'main' LIMIT 1");
  return rows.length ? parseJson(rows[0].state_value, null) : null;
}
