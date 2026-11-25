import { query, isDbReady, parseJson } from '../config/db.js';
import { env } from '../config/env.js';
import { randomHex } from '../lib/util.js';
import { getSettings, warmupState } from './settings.service.js';
import { sendEmail, isLive, isTemporaryError, getSendQuota } from './ses.service.js';
import { renderEmail, trackingToken } from './render.service.js';
import { recordContactEvent } from './contacts.service.js';
import { campaignBlocks, completeIfDone, decideAbWinner, refreshCampaignCounts, startCampaign, campaignEvent } from './campaigns.service.js';
import { processAutomations } from './automations.service.js';

const STALE_SENDING_MINUTES = 10;

export const workerState = {
  running: false,
  lastTickAt: null,
  lastError: null,
  holdReason: null, // e.g. "Daily limit of 1,000 reached"
  sentThisProcess: 0,
};

const dirtyCampaigns = new Set();
export function markCampaignDirty(id) {
  if (id) dirtyCampaigns.add(id);
}

// ---------------------------------------------------------------------------
// Daily allowance (warm-up, daily limit, SES quota)
// ---------------------------------------------------------------------------
export async function sentInLast24h() {
  const [row] = await query(
    `SELECT
      (SELECT COUNT(*) FROM campaign_recipients WHERE sent_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) +
      (SELECT COUNT(*) FROM automation_sends WHERE sent_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) +
      (SELECT COUNT(*) FROM test_sends WHERE sent_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS n`
  );
  return Number(row.n) || 0;
}

export async function sendingAllowance(settings) {
  const warm = warmupState(settings.ses);
  const configured = Number(settings.ses.dailyLimit) || 0;
  let limit = warm && !warm.finished ? warm.limit : configured > 0 ? configured : Infinity;
  let source = warm && !warm.finished ? 'warm-up' : configured > 0 ? 'daily limit' : 'none';
  const quota = await getSendQuota(settings);
  if (quota?.max24h && quota.max24h < limit) {
    limit = quota.max24h;
    source = 'Amazon SES quota';
  }
  const used = await sentInLast24h();
  return { limit, used, remaining: Math.max(0, limit - used), source, warmup: warm, quota };
}

// ---------------------------------------------------------------------------
// Campaign sending
// ---------------------------------------------------------------------------
async function reclaimStale() {
  // A row stuck in 'sending' means the process died mid-send. SES may already
  // have accepted it, so we never resend automatically: mark it for a manual retry.
  const res = await query(
    `UPDATE campaign_recipients SET status = 'failed', claim_token = NULL,
       error = 'Interrupted while sending. Retry it if the person did not get it.'
     WHERE status = 'sending' AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE`,
    [STALE_SENDING_MINUTES]
  );
  return res.affectedRows;
}

async function startDueScheduled() {
  const due = await query(
    "SELECT id FROM campaigns WHERE status = 'Scheduled' AND send_at IS NOT NULL AND send_at <= UTC_TIMESTAMP() LIMIT 5"
  );
  for (const { id } of due) {
    try {
      await startCampaign(id, { actor: 'Schedule' });
    } catch (err) {
      console.error(`[worker] Could not start ${id}:`, err.message);
    }
  }
}

async function decideDueAbTests() {
  const due = await query(
    `SELECT id FROM campaigns WHERE status = 'Sending' AND ab_winner IS NULL
     AND ab_decide_at IS NOT NULL AND ab_decide_at <= UTC_TIMESTAMP() LIMIT 5`
  );
  for (const { id } of due) await decideAbWinner(id);
}

async function claimBatch(limit) {
  if (limit <= 0) return [];
  const token = randomHex(8);
  const res = await query(
    `UPDATE campaign_recipients SET status = 'sending', claim_token = ?, claimed_at = UTC_TIMESTAMP(), attempts = attempts + 1
     WHERE status = 'pending' AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'Sending')
     ORDER BY id LIMIT ?`,
    [token, limit]
  );
  if (!res.affectedRows) return [];
  return query(
    `SELECT r.id, r.campaign_id, r.contact_id, r.email, r.name, r.variant, r.attempts,
            c.status AS contact_status, c.first_name, c.last_name, c.city, c.plan, c.custom_fields_json, c.unsub_token
     FROM campaign_recipients r LEFT JOIN contacts c ON c.id = r.contact_id
     WHERE r.claim_token = ?`,
    [token]
  );
}

async function loadCampaignContext(ids) {
  const rows = await query(
    `SELECT c.*, t.blocks_json AS t_blocks, t.subject AS t_subject, t.preview_text AS t_preview,
            t.heading, t.body, t.cta_label, t.cta_url, t.cta_color
     FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id WHERE c.id IN (?)`,
    [ids]
  );
  const map = new Map();
  for (const row of rows) {
    const template = row.t_blocks
      ? { blocks_json: row.t_blocks }
      : { heading: row.heading, body: row.body, ctaLabel: row.cta_label, ctaUrl: row.cta_url, ctaColor: row.cta_color };
    map.set(row.id, { row, blocks: campaignBlocks(row, template) });
  }
  return map;
}

function senderFor(campaign, settings) {
  const defaultSender = settings.senders.find((s) => s.isDefault) || settings.senders[0];
  return {
    fromEmail: campaign.from_email || defaultSender?.email || env.aws.fromEmail,
    fromName: campaign.from_name || settings.general.fromName || env.aws.fromName || settings.general.teamName,
    replyTo: campaign.reply_to || settings.general.replyTo || '',
  };
}

async function sendOne(item, ctx, settings) {
  if (item.contact_id && item.contact_status && item.contact_status !== 'Subscribed') {
    await query("UPDATE campaign_recipients SET status = 'skipped', claim_token = NULL, error = ? WHERE id = ?", [
      `Skipped: ${item.contact_status.toLowerCase()}`,
      item.id,
    ]);
    return 'skipped';
  }
  const c = ctx.row;
  const subject = item.variant === 'B' && c.subject_b ? c.subject_b : c.subject_a || c.t_subject || c.title;
  const contact = {
    name: item.name,
    firstName: item.first_name,
    lastName: item.last_name,
    email: item.email,
    city: item.city,
    plan: item.plan,
    customFields: parseJson(item.custom_fields_json, {}),
  };
  const email = renderEmail({
    blocks: ctx.blocks,
    subject,
    previewText: c.preview_text || c.t_preview,
    contact,
    settings,
    unsubToken: item.unsub_token,
    trackToken: trackingToken('r', item.id),
  });

  try {
    const result = await sendEmail({ settings, to: item.email, ...senderFor(c, settings), ...email });
    await query(
      `UPDATE campaign_recipients SET status = 'sent', claim_token = NULL, sent_at = UTC_TIMESTAMP(),
       message_id = ?, error = NULL WHERE id = ?`,
      [result.messageId, item.id]
    );
    if (item.contact_id) {
      await query('UPDATE contacts SET sent_count = sent_count + 1 WHERE id = ?', [item.contact_id]);
      await recordContactEvent(item.contact_id, { type: 'delivered', title: `Sent ${c.title}`, campaignId: c.id });
    }
    return 'sent';
  } catch (err) {
    const temporary = isTemporaryError(err) && !err.permanent;
    const retries = Number(settings.ses.retries) || 0;
    if (temporary && item.attempts < Math.max(1, retries)) {
      await query("UPDATE campaign_recipients SET status = 'pending', claim_token = NULL, error = ? WHERE id = ?", [
        `Retrying: ${err.message}`.slice(0, 500),
        item.id,
      ]);
      return 'retry';
    }
    await query("UPDATE campaign_recipients SET status = 'failed', claim_token = NULL, error = ? WHERE id = ?", [
      `${temporary ? `Failed after ${item.attempts} tries: ` : ''}${err.message}`.slice(0, 500),
      item.id,
    ]);
    return 'failed';
  }
}

async function sendCampaignBatch(settings, budget) {
  const batch = await claimBatch(budget);
  if (!batch.length) return 0;
  const ids = [...new Set(batch.map((b) => b.campaign_id))];
  const ctxMap = await loadCampaignContext(ids);

  // Re-check status right before sending so Pause/Cancel takes effect immediately.
  const release = batch.filter((b) => ctxMap.get(b.campaign_id)?.row.status !== 'Sending');
  if (release.length) {
    await query("UPDATE campaign_recipients SET status = 'pending', claim_token = NULL, attempts = attempts - 1 WHERE id IN (?)", [
      release.map((r) => r.id),
    ]);
  }
  const toSend = batch.filter((b) => ctxMap.get(b.campaign_id)?.row.status === 'Sending');
  const results = await Promise.all(toSend.map((item) => sendOne(item, ctxMap.get(item.campaign_id), settings)));

  const failures = results.filter((r) => r === 'failed').length;
  if (failures) {
    for (const id of ids) await campaignEvent(id, 'failed', `${failures} email${failures > 1 ? 's' : ''} failed`);
  }
  for (const id of ids) dirtyCampaigns.add(id);
  const sent = results.filter((r) => r === 'sent').length;
  workerState.sentThisProcess += sent;
  return sent;
}

async function flushDirty() {
  const ids = [...dirtyCampaigns];
  dirtyCampaigns.clear();
  for (const id of ids) {
    await refreshCampaignCounts(id);
    await completeIfDone(id);
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
let timer = null;
let busy = false;
let tickCount = 0;

export async function tick() {
  if (busy || !isDbReady()) return;
  busy = true;
  try {
    tickCount += 1;
    const settings = await getSettings();
    if (tickCount % 30 === 1) await reclaimStale();
    await startDueScheduled();
    await decideDueAbTests();

    const allowance = await sendingAllowance(settings);
    const perTick = Math.max(1, Math.floor((Number(settings.ses.sendRate) || 10) * (env.worker.tickMs / 1000)));
    const budget = Math.min(perTick, allowance.remaining);
    workerState.holdReason =
      allowance.remaining <= 0 ? `Daily limit of ${allowance.limit.toLocaleString('en-US')} reached (${allowance.source}). Sending continues automatically.` : null;

    const used = await sendCampaignBatch(settings, budget);
    if (tickCount % 5 === 0) await processAutomations(settings, Math.max(0, allowance.remaining - used));

    // Campaigns that are Sending but have nothing left (e.g. everyone skipped) still need completing.
    if (tickCount % 5 === 0) {
      const sending = await query("SELECT id FROM campaigns WHERE status = 'Sending'");
      for (const { id } of sending) dirtyCampaigns.add(id);
    }
    await flushDirty();
    workerState.lastTickAt = new Date();
    workerState.lastError = null;
  } catch (err) {
    workerState.lastError = err.message;
    console.error('[worker] Tick failed:', err.message);
  } finally {
    busy = false;
  }
}

export function startWorker() {
  if (timer || !env.worker.enabled) return;
  timer = setInterval(tick, env.worker.tickMs);
  workerState.running = true;
  console.log(`[worker] Send queue running every ${env.worker.tickMs} ms`);
}

export async function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  workerState.running = false;
  // Let an in-flight batch finish so no row is left half-sent.
  for (let i = 0; busy && i < 50; i += 1) await new Promise((r) => setTimeout(r, 100));
}

export { isLive };
