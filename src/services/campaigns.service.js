import { query, one, parseJson, tx } from '../config/db.js';
import { compileSegment, loadSegments } from './segments.service.js';
import { getSettings, saveSetting } from './settings.service.js';
import { isLive } from './ses.service.js';
import { defaultBlocks } from '../lib/defaults.js';

export const ACTIVE_STATUSES = ['Sending', 'Starting'];

export function serializeCampaign(row, live = {}) {
  const total = row.total_count || 0;
  const sent = row.sent_count || 0;
  const delivered = row.delivered_count || 0;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    note: row.description || '',
    subjectA: row.subject_a || '',
    subjectB: row.subject_b || '',
    abTest: Boolean(row.ab_test),
    abSplitPct: row.ab_split_pct,
    abWaitHours: row.ab_wait_hours,
    abDecideAt: row.ab_decide_at,
    abWinner: row.ab_winner,
    previewText: row.preview_text || '',
    fromName: row.from_name || '',
    fromEmail: row.from_email || '',
    replyTo: row.reply_to || '',
    templateId: row.template_id,
    blocks: parseJson(row.blocks_json, null),
    topic: row.topic,
    groupIds: parseJson(row.group_ids_json, []) || [],
    segmentIds: parseJson(row.segment_ids_json, []) || [],
    sendMode: row.send_mode,
    sendAt: row.send_at,
    timezone: row.timezone,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    pausedAt: row.paused_at,
    pausedBy: row.paused_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    legacy: Boolean(row.legacy),
    stats: {
      total,
      sent,
      delivered,
      opened: row.opened_count || 0,
      clicked: row.clicked_count || 0,
      bounced: row.bounced_count || 0,
      complaints: row.complaint_count || 0,
      failed: row.failed_count || 0,
      unsubscribed: row.unsubscribed_count || 0,
      skipped: row.skipped_count || 0,
      waiting: live.waiting ?? Math.max(0, total - sent - (row.failed_count || 0) - (row.skipped_count || 0)),
      held: live.held ?? 0,
    },
    rates: {
      open: delivered ? row.opened_count / delivered : 0,
      click: delivered ? row.clicked_count / delivered : 0,
      bounce: sent ? row.bounced_count / sent : 0,
    },
  };
}

/** Waiting/held counts straight from the queue, for many campaigns at once. */
export async function liveQueueCounts(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await query(
    `SELECT campaign_id, SUM(status IN ('pending','sending')) AS waiting, SUM(status = 'held') AS held
     FROM campaign_recipients WHERE campaign_id IN (?) GROUP BY campaign_id`,
    [ids]
  );
  for (const r of rows) map.set(r.campaign_id, { waiting: Number(r.waiting) || 0, held: Number(r.held) || 0 });
  return map;
}

export async function getCampaignRow(id) {
  return one('SELECT * FROM campaigns WHERE id = ?', [id]);
}

export async function loadCampaign(id) {
  const row = await getCampaignRow(id);
  if (!row) return null;
  const live = (await liveQueueCounts([id])).get(id) || { waiting: 0, held: 0 };
  return serializeCampaign(row, live);
}

export function campaignBlocks(row, template) {
  return parseJson(row.blocks_json, null) || parseJson(template?.blocks_json, null) || defaultBlocks(template || {});
}

export async function campaignEvent(campaignId, type, title, detail = '') {
  await query('INSERT INTO events (type, campaign_id, title, detail) VALUES (?, ?, ?, ?)', [
    type,
    campaignId,
    String(title).slice(0, 255),
    String(detail).slice(0, 500),
  ]);
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------
const TOPIC_KEYS = new Set(['newsletter', 'offers']);

function receivableSql(topic) {
  const key = TOPIC_KEYS.has(topic) ? topic : 'newsletter';
  return `c.status = 'Subscribed'
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.preferences_json, '$.topics.${key}')), 'true') <> 'false'
    AND NOT (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.preferences_json, '$.frequency')), '') = 'monthly'
      AND EXISTS (SELECT 1 FROM campaign_recipients rf WHERE rf.contact_id = c.id AND rf.sent_at >= UTC_TIMESTAMP() - INTERVAL 28 DAY))`;
}

/** WHERE fragment matching anyone in the chosen groups, segments or resend audience. */
export async function membershipSql({ groupIds = [], segmentIds = [], resendOf = null }) {
  const parts = [];
  const params = [];
  if (groupIds.length) {
    parts.push('EXISTS (SELECT 1 FROM contact_groups g WHERE g.contact_id = c.id AND g.group_id IN (?))');
    params.push(groupIds);
  }
  // The token 'all' means every contact (receivableSql still removes unsubscribed etc).
  if (segmentIds.includes('all')) parts.push('1 = 1');
  for (const seg of await loadSegments(segmentIds.filter((s) => s !== 'all'))) {
    const compiled = compileSegment({ ...seg, onlyReceivable: false });
    parts.push(compiled.sql);
    params.push(...compiled.params);
  }
  if (resendOf) {
    parts.push(
      `EXISTS (SELECT 1 FROM campaign_recipients rr WHERE rr.contact_id = c.id AND rr.campaign_id = ?
        AND rr.sent_at IS NOT NULL AND rr.opened_at IS NULL AND rr.bounced_at IS NULL)`
    );
    params.push(resendOf);
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '1 = 0', params };
}

export async function estimateAudience({ groupIds, segmentIds, resendOf, topic }) {
  const m = await membershipSql({ groupIds, segmentIds, resendOf });
  const receivable = receivableSql(topic);
  const [row] = await query(
    `SELECT SUM(${receivable}) AS can_receive, COUNT(*) AS total FROM contacts c WHERE ${m.sql}`,
    m.params
  );
  const count = Number(row?.can_receive) || 0;
  return { count, skipped: (Number(row?.total) || 0) - count };
}

function audienceOf(row) {
  const segs = parseJson(row.segment_ids_json, []) || [];
  return {
    groupIds: parseJson(row.group_ids_json, []) || [],
    segmentIds: segs.filter((s) => !String(s).startsWith('resend:')),
    resendOf: (segs.find((s) => String(s).startsWith('resend:')) || '').slice(7) || null,
    topic: row.topic,
  };
}

export async function estimateForCampaign(row) {
  return estimateAudience(audienceOf(row));
}

// ---------------------------------------------------------------------------
// Starting a campaign
// ---------------------------------------------------------------------------
async function assignAbVariants(conn, row, total) {
  if (!row.ab_test || !row.subject_b) {
    await conn.query("UPDATE campaign_recipients SET variant = 'A' WHERE campaign_id = ?", [row.id]);
    return;
  }
  if (total < 20) {
    // Too few people for a meaningful test: alternate A and B.
    await conn.query(
      "UPDATE campaign_recipients SET variant = IF(MOD(id, 2) = 0, 'A', 'B') WHERE campaign_id = ?",
      [row.id]
    );
    return;
  }
  const each = Math.max(1, Math.floor((total * (row.ab_split_pct || 20)) / 100 / 2));
  await conn.query(
    "UPDATE campaign_recipients SET variant = 'A' WHERE campaign_id = ? AND variant IS NULL ORDER BY RAND() LIMIT ?",
    [row.id, each]
  );
  await conn.query(
    "UPDATE campaign_recipients SET variant = 'B' WHERE campaign_id = ? AND variant IS NULL ORDER BY RAND() LIMIT ?",
    [row.id, each]
  );
  await conn.query("UPDATE campaign_recipients SET status = 'held' WHERE campaign_id = ? AND variant IS NULL", [row.id]);
  await conn.query('UPDATE campaigns SET ab_decide_at = UTC_TIMESTAMP() + INTERVAL ? HOUR WHERE id = ?', [
    row.ab_wait_hours || 4,
    row.id,
  ]);
}

/**
 * Freezes the audience into campaign_recipients and switches to Sending.
 * The conditional UPDATE makes this safe if two workers race on the same campaign.
 */
export async function startCampaign(id, { actor = 'Scheduler' } = {}) {
  const claimed = await query(
    "UPDATE campaigns SET status = 'Starting' WHERE id = ? AND status IN ('Draft', 'Scheduled')",
    [id]
  );
  if (claimed.affectedRows === 0) return { started: false, reason: 'Campaign is not a draft or scheduled.' };

  try {
    const row = await getCampaignRow(id);
    const aud = audienceOf(row);
    const m = await membershipSql(aud);
    const total = await tx(async (conn) => {
      const [ins] = await conn.query(
        `INSERT IGNORE INTO campaign_recipients (campaign_id, contact_id, email, name, status)
         SELECT ?, c.id, c.email, c.name, 'pending' FROM contacts c
         WHERE ${m.sql} AND ${receivableSql(aud.topic)}`,
        [id, ...m.params]
      );
      await assignAbVariants(conn, row, ins.affectedRows);
      return ins.affectedRows;
    });

    if (total === 0) {
      await query("UPDATE campaigns SET status = 'Draft', description = ? WHERE id = ?", [
        'Nobody in the chosen groups could receive it, so nothing was sent.',
        id,
      ]);
      await campaignEvent(id, 'skipped', 'Nobody to send to');
      return { started: false, reason: 'Nobody in the chosen audience can receive this campaign.' };
    }

    await query(
      `UPDATE campaigns SET status = 'Sending', started_at = UTC_TIMESTAMP(), total_count = ?, recipients_count = ?,
       description = '' WHERE id = ?`,
      [total, total, id]
    );
    await campaignEvent(id, 'started', `Sending started · ${total} ${total === 1 ? 'person' : 'people'}`, `by ${actor}`);

    const settings = await getSettings({ fresh: true });
    if (isLive(settings) && settings.ses.warmup?.enabled && !settings.ses.warmup.startedAt) {
      await saveSetting('ses', { ...settings.ses, warmup: { ...settings.ses.warmup, startedAt: new Date().toISOString() } });
    }
    return { started: true, total };
  } catch (err) {
    await query("UPDATE campaigns SET status = 'Draft', description = ? WHERE id = ? AND status = 'Starting'", [
      `Could not start: ${err.message}`.slice(0, 255),
      id,
    ]);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Counters and completion
// ---------------------------------------------------------------------------
export async function refreshCampaignCounts(id) {
  await query(
    `UPDATE campaigns c JOIN (
       SELECT campaign_id,
         SUM(status <> 'skipped') AS total,
         SUM(sent_at IS NOT NULL) AS sent,
         SUM(sent_at IS NOT NULL AND bounced_at IS NULL) AS delivered,
         SUM(opened_at IS NOT NULL) AS opened,
         SUM(clicked_at IS NOT NULL) AS clicked,
         SUM(bounced_at IS NOT NULL) AS bounced,
         SUM(complained_at IS NOT NULL) AS complaints,
         SUM(status = 'failed') AS failed,
         SUM(unsubscribed_at IS NOT NULL) AS unsubscribed,
         SUM(status = 'skipped') AS skipped
       FROM campaign_recipients WHERE campaign_id = ? GROUP BY campaign_id
     ) s ON s.campaign_id = c.id
     SET c.total_count = s.total, c.sent_count = s.sent, c.delivered_count = s.delivered,
         c.opened_count = s.opened, c.clicked_count = s.clicked, c.bounced_count = s.bounced,
         c.complaint_count = s.complaints, c.failed_count = s.failed,
         c.unsubscribed_count = s.unsubscribed, c.skipped_count = s.skipped
     WHERE c.id = ? AND c.legacy = 0`,
    [id, id]
  );
}

export async function completeIfDone(id) {
  const [row] = await query(
    "SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','sending','held')",
    [id]
  );
  if (Number(row.n) > 0) return false;
  const res = await query(
    "UPDATE campaigns SET status = 'Completed', completed_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'Sending'",
    [id]
  );
  if (res.affectedRows) {
    await refreshCampaignCounts(id);
    const c = await getCampaignRow(id);
    await campaignEvent(id, 'completed', `Finished · ${c.sent_count} sent${c.failed_count ? `, ${c.failed_count} failed` : ''}`);
  }
  return res.affectedRows > 0;
}

/** Picks the subject with the better open rate and releases everyone held back. */
export async function decideAbWinner(id) {
  const rows = await query(
    `SELECT variant, SUM(sent_at IS NOT NULL) AS sent, SUM(opened_at IS NOT NULL) AS opened
     FROM campaign_recipients WHERE campaign_id = ? AND variant IN ('A','B') GROUP BY variant`,
    [id]
  );
  const rate = (v) => {
    const r = rows.find((x) => x.variant === v);
    return r && Number(r.sent) ? Number(r.opened) / Number(r.sent) : 0;
  };
  const winner = rate('B') > rate('A') ? 'B' : 'A';
  const res = await query('UPDATE campaigns SET ab_winner = ? WHERE id = ? AND ab_winner IS NULL', [winner, id]);
  if (!res.affectedRows) return null;
  const released = await query(
    "UPDATE campaign_recipients SET status = 'pending', variant = ? WHERE campaign_id = ? AND status = 'held'",
    [winner, id]
  );
  await campaignEvent(
    id,
    'ab_winner',
    `Subject ${winner} won (${(rate(winner) * 100).toFixed(1)}% opened)`,
    `Sending it to the other ${released.affectedRows}`
  );
  return winner;
}
