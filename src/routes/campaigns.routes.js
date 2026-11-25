import { Router } from 'express';
import { query, one, parseJson } from '../config/db.js';
import { requireAuth, editorsWrite, asyncRoute, httpError } from '../middleware/auth.js';
import { isValidEmail, isValidTimeZone, newId, normalizeEmail, zonedTimeToUtc } from '../lib/util.js';
import {
  serializeCampaign,
  liveQueueCounts,
  loadCampaign,
  getCampaignRow,
  estimateAudience,
  estimateForCampaign,
  startCampaign,
  campaignEvent,
  campaignBlocks,
  refreshCampaignCounts,
} from '../services/campaigns.service.js';
import { renderEmail, extractLinks } from '../services/render.service.js';
import { sendEmail, isLive, getIdentityStatuses } from '../services/ses.service.js';
import { getSettings, audit } from '../services/settings.service.js';
import { sendingAllowance } from '../services/worker.service.js';
import { cleanBlocks } from './templates.routes.js';

const router = Router();
router.use(requireAuth, editorsWrite);

const EDITABLE = ['Draft', 'Scheduled'];

async function list() {
  const rows = await query('SELECT * FROM campaigns ORDER BY COALESCE(send_at, started_at, created_at) DESC, created_at DESC');
  const live = await liveQueueCounts(rows.map((r) => r.id));
  return rows.map((r) => serializeCampaign(r, live.get(r.id)));
}

router.get('/', asyncRoute(async (_req, res) => res.json({ success: true, campaigns: await list() })));

router.post(
  '/estimate',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const est = await estimateAudience({
      groupIds: Array.isArray(b.groupIds) ? b.groupIds : [],
      segmentIds: Array.isArray(b.segmentIds) ? b.segmentIds : [],
      topic: b.topic,
    });
    res.json({ success: true, ...est });
  })
);

// ---------------------------------------------------------------------------
// Create / edit drafts
// ---------------------------------------------------------------------------
async function applyBody(b, existing = null) {
  const out = {};
  const str = (v, n) => String(v ?? '').slice(0, n);
  if (b.title !== undefined) out.title = str(b.title, 255).trim() || 'Untitled campaign';
  if (b.subjectA !== undefined) out.subject_a = str(b.subjectA, 255);
  if (b.subjectB !== undefined) out.subject_b = str(b.subjectB, 255);
  if (b.abTest !== undefined) out.ab_test = b.abTest ? 1 : 0;
  if (b.previewText !== undefined) out.preview_text = str(b.previewText, 255);
  if (b.fromName !== undefined) out.from_name = str(b.fromName, 120);
  if (b.fromEmail !== undefined) out.from_email = normalizeEmail(b.fromEmail).slice(0, 190);
  if (b.replyTo !== undefined) out.reply_to = normalizeEmail(b.replyTo).slice(0, 190);
  if (b.groupIds !== undefined) out.group_ids_json = JSON.stringify((b.groupIds || []).map(String).slice(0, 50));
  if (b.segmentIds !== undefined) {
    const keepResend = (parseJson(existing?.segment_ids_json, []) || []).filter((s) => String(s).startsWith('resend:'));
    out.segment_ids_json = JSON.stringify([...keepResend, ...(b.segmentIds || []).map(String).slice(0, 50)]);
  }
  if (b.templateId !== undefined && b.templateId !== existing?.template_id) {
    const tpl = b.templateId ? await one('SELECT * FROM templates WHERE id = ?', [b.templateId]) : null;
    if (b.templateId && !tpl) throw httpError(400, 'That template no longer exists.');
    out.template_id = tpl?.id || null;
    out.topic = /promo|offer/i.test(tpl?.category || '') ? 'offers' : 'newsletter';
    // Campaigns keep their own copy, so editing here never changes the template.
    if (b.blocks === undefined && tpl) out.blocks_json = tpl.blocks_json ? (typeof tpl.blocks_json === 'string' ? tpl.blocks_json : JSON.stringify(tpl.blocks_json)) : null;
    if (b.subjectA === undefined && !existing?.subject_a && tpl?.subject) out.subject_a = tpl.subject;
    if (b.previewText === undefined && !existing?.preview_text && tpl?.preview_text) out.preview_text = tpl.preview_text;
  }
  if (b.blocks !== undefined) out.blocks_json = JSON.stringify(cleanBlocks(b.blocks) || []);
  if (b.abSplitPct !== undefined) out.ab_split_pct = Math.min(50, Math.max(10, parseInt(b.abSplitPct, 10) || 20));
  if (b.abWaitHours !== undefined) out.ab_wait_hours = Math.min(48, Math.max(1, parseInt(b.abWaitHours, 10) || 4));
  if (b.sendMode !== undefined) out.send_mode = b.sendMode === 'schedule' ? 'schedule' : 'now';
  if (b.timezone !== undefined) {
    if (!isValidTimeZone(b.timezone)) throw httpError(400, 'Pick a valid time zone.');
    out.timezone = b.timezone;
  }
  if (b.sendDate !== undefined || b.sendTime !== undefined) {
    const tz = out.timezone || existing?.timezone || 'Asia/Colombo';
    const at = b.sendDate ? zonedTimeToUtc(b.sendDate, b.sendTime || '09:00', tz) : null;
    if (b.sendDate && !at) throw httpError(400, 'Pick a valid date and time.');
    out.send_at = at;
  }
  return out;
}

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    const fields = await applyBody(req.body || {});
    const defaultSender = settings.senders.find((s) => s.isDefault) || settings.senders[0];
    const id = newId(fields.title || 'campaign', 120);
    const row = {
      id,
      month: '',
      day: '',
      title: 'Untitled campaign',
      status: 'Draft',
      from_name: settings.general.fromName || settings.general.teamName,
      from_email: defaultSender?.email || '',
      reply_to: settings.general.replyTo || '',
      created_by: req.user.name,
      timezone: 'Asia/Colombo',
      ...fields,
    };
    const cols = Object.keys(row);
    await query(`INSERT INTO campaigns (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row));
    res.status(201).json({ success: true, campaign: await loadCampaign(id) });
  })
);

router.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const c = await loadCampaign(req.params.id);
    if (!c) throw httpError(404, 'Campaign not found.');
    if (!c.blocks && c.templateId) {
      const t = await one('SELECT * FROM templates WHERE id = ?', [c.templateId]);
      c.blocks = campaignBlocks({}, t);
    }
    res.json({ success: true, campaign: c });
  })
);

router.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    if (!EDITABLE.includes(row.status)) throw httpError(409, `A ${row.status.toLowerCase()} campaign can’t be edited. Duplicate it instead.`);
    const fields = await applyBody(req.body || {}, row);
    if (row.status === 'Scheduled' && fields.send_at && new Date(fields.send_at) < new Date()) {
      throw httpError(400, 'Pick a time in the future.');
    }
    const cols = Object.keys(fields);
    if (cols.length) await query(`UPDATE campaigns SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), row.id]);
    res.json({ success: true, campaign: await loadCampaign(row.id) });
  })
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    if (!['Draft', 'Cancelled'].includes(row.status)) throw httpError(409, 'Only drafts and cancelled campaigns can be deleted.');
    await query('DELETE FROM campaign_recipients WHERE campaign_id = ?', [row.id]);
    await query('DELETE FROM events WHERE campaign_id = ? AND contact_id IS NULL', [row.id]);
    await query('DELETE FROM campaigns WHERE id = ?', [row.id]);
    await audit(req.user.name, `deleted the campaign ${row.title}`);
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// Pre-send checks
// ---------------------------------------------------------------------------
async function checkLink(url) {
  const attempt = async (method) => {
    const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'BulkMailer link check' } });
    return r.status;
  };
  try {
    let status = await attempt('HEAD');
    if (status === 405 || status === 403 || status === 501) status = await attempt('GET');
    return status < 400 ? null : `returns ${status}`;
  } catch (err) {
    return err.name === 'TimeoutError' ? 'took too long to answer' : 'could not be reached';
  }
}

export async function runChecks(row) {
  const settings = await getSettings();
  const checks = [];
  const add = (key, status, title, detail = '', action = null) => checks.push({ key, status, title, detail, action });
  const live = isLive(settings);

  const audience = await estimateForCampaign(row);
  if (audience.count === 0) add('audience', 'fail', 'Nobody can receive this', 'Choose a group or segment with subscribed people.', 'recipients');

  const subject = row.subject_a || '';
  if (!subject.trim()) add('subject', 'fail', 'Subject is empty', 'Add a subject line.', 'edit');
  if (row.ab_test && !String(row.subject_b || '').trim()) add('subject_b', 'fail', 'Subject B is empty', 'Add a second subject or turn off the test.', 'edit');

  const sender = settings.senders.find((s) => s.email === row.from_email);
  const senderDomain = (row.from_email || '').split('@')[1] || '';
  if (!row.from_email) {
    add('sender', 'fail', 'No sender email', 'Add a sender in Settings, then pick it here.', 'settings');
  } else if (!sender) {
    add('sender', 'fail', 'Sender isn’t set up', `${row.from_email} isn’t in your sender list.`, 'settings');
  } else if (live) {
    const statuses = await getIdentityStatuses([row.from_email, senderDomain], settings).catch(() => ({}));
    const ok = statuses[row.from_email] === 'Success' || statuses[senderDomain] === 'Success';
    if (!ok) add('sender', 'fail', 'Sender isn’t verified in Amazon SES', `Verify ${senderDomain} or ${row.from_email} first.`, 'domains');
  }

  const domain = settings.domains.find((d) => d.name === senderDomain);
  const rec = domain?.records || {};
  if (rec.spf === 'pass' && rec.dkim === 'pass') add('spf_dkim', 'pass', 'SPF and DKIM pass', 'Your domain is allowed to send through Amazon SES');
  else add('spf_dkim', 'warn', 'SPF or DKIM not confirmed', domain ? 'Check the records on the domain page.' : `Add ${senderDomain || 'your domain'} on the domain page.`, 'domains');
  if (rec.dmarc === 'pass') add('dmarc', 'pass', 'DMARC record found', 'Inboxes know what to do with fakes');
  else add('dmarc', 'warn', 'DMARC record missing', 'You can still send, but Gmail may filter more of your mail', 'domains');

  if (settings.compliance.oneClickUnsubscribe !== false) add('unsubscribe', 'pass', 'One-click unsubscribe header added', 'Gmail and Yahoo show an Unsubscribe button next to your name');
  else add('unsubscribe', 'warn', 'One-click unsubscribe is off', 'Gmail and Yahoo require it for bulk senders.', 'settings');

  if (settings.compliance.address?.trim()) add('address', 'pass', 'Footer has your business address', settings.compliance.address);
  else add('address', 'fail', 'No business address', 'Anti-spam laws require it in every email. Add it in Settings.', 'settings');

  add('plain_text', 'pass', 'Plain-text version included');

  const tpl = row.template_id ? await one('SELECT * FROM templates WHERE id = ?', [row.template_id]) : null;
  const links = extractLinks(campaignBlocks(row, tpl)).slice(0, 10);
  if (links.length) {
    const results = await Promise.all(links.map(async (l) => ({ ...l, problem: await checkLink(l.url) })));
    const broken = results.filter((r) => r.problem);
    if (broken.length) add('links', 'warn', `${broken.length} of ${links.length} links have a problem`, broken.map((b) => `${b.url} ${b.problem}`).join('; '), 'edit');
    else add('links', 'pass', `All ${links.length} link${links.length > 1 ? 's' : ''} work`, `Checked ${new Date().toISOString()}`);
  }

  const test = await one('SELECT MAX(sent_at) AS last, COUNT(*) AS n FROM test_sends WHERE campaign_id = ?', [row.id]);
  if (test?.last) add('test', 'pass', 'Test sent', `Last test ${new Date(test.last).toISOString()}`);
  else add('test', 'warn', 'No test sent yet', 'Send yourself a test to see what people will get.', 'test');

  const allowance = await sendingAllowance(settings);
  if (allowance.limit === Infinity || audience.count <= allowance.remaining) {
    add('limit', 'pass', 'Within your daily sending limit', allowance.limit === Infinity ? '' : `${allowance.remaining.toLocaleString('en-US')} left today (${allowance.source})`);
  } else {
    const days = Math.ceil((audience.count - allowance.remaining) / allowance.limit) + 1;
    add('limit', 'warn', 'Over today’s sending limit', `It will finish over about ${days} days. Your limit is ${allowance.limit.toLocaleString('en-US')} a day (${allowance.source}).`);
  }

  add('suppressed', 'pass', 'Unsubscribed, bounced and complained people removed', `${audience.skipped} skipped`);
  if (!live) add('simulation', 'warn', 'Simulation mode is on', 'Nothing is really sent until you connect Amazon SES.', 'settings');

  return { checks, audience, canSend: !checks.some((c) => c.status === 'fail') };
}

router.get(
  '/:id/checks',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    res.json({ success: true, ...(await runChecks(row)) });
  })
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
router.post(
  '/:id/send',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    if (!EDITABLE.includes(row.status)) throw httpError(409, `This campaign is already ${row.status.toLowerCase()}.`);
    if (!req.body?.confirmed) throw httpError(400, 'Tick the box to confirm you checked the test email.');
    const result = await runChecks(row);
    if (!result.canSend) return res.status(400).json({ success: false, message: 'Fix the failed checks first.', ...result });

    if (row.send_mode === 'schedule') {
      if (!row.send_at || new Date(row.send_at) < new Date(Date.now() + 60000)) throw httpError(400, 'Pick a time at least a minute from now.');
      await query("UPDATE campaigns SET status = 'Scheduled' WHERE id = ?", [row.id]);
      await campaignEvent(row.id, 'scheduled', `Scheduled by ${req.user.name}`);
      await audit(req.user.name, `scheduled ${row.title}`);
    } else {
      const started = await startCampaign(row.id, { actor: req.user.name });
      if (!started.started) throw httpError(400, started.reason);
      await audit(req.user.name, `started sending ${row.title}`);
    }
    res.json({ success: true, campaign: await loadCampaign(row.id) });
  })
);

router.post(
  '/:id/unschedule',
  asyncRoute(async (req, res) => {
    const r = await query("UPDATE campaigns SET status = 'Draft' WHERE id = ? AND status = 'Scheduled'", [req.params.id]);
    if (!r.affectedRows) throw httpError(409, 'Only scheduled campaigns can be moved back to draft.');
    await campaignEvent(req.params.id, 'unscheduled', `Moved back to draft by ${req.user.name}`);
    res.json({ success: true, campaign: await loadCampaign(req.params.id) });
  })
);

router.post(
  '/:id/pause',
  asyncRoute(async (req, res) => {
    const r = await query(
      "UPDATE campaigns SET status = 'Paused', paused_at = UTC_TIMESTAMP(), paused_by = ? WHERE id = ? AND status = 'Sending'",
      [req.user.name, req.params.id]
    );
    if (!r.affectedRows) throw httpError(409, 'Only campaigns that are sending can be paused.');
    await campaignEvent(req.params.id, 'paused', `Paused by ${req.user.name}`);
    await audit(req.user.name, `paused ${(await getCampaignRow(req.params.id)).title}`);
    res.json({ success: true, campaign: await loadCampaign(req.params.id) });
  })
);

router.post(
  '/:id/resume',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row || row.status !== 'Paused') throw httpError(409, 'Only paused campaigns can be resumed.');
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending','held')", [row.id]);
    if (row.legacy && Number(n) === 0) {
      throw httpError(
        409,
        'This campaign was paused before the upgrade, and the list of who already got it wasn’t saved. Resuming could email people twice. Duplicate it and send to a fresh audience instead.'
      );
    }
    await query("UPDATE campaigns SET status = 'Sending', paused_at = NULL WHERE id = ? AND status = 'Paused'", [row.id]);
    await campaignEvent(row.id, 'resumed', `Resumed by ${req.user.name}`, `${n} waiting`);
    await audit(req.user.name, `resumed ${row.title}`);
    res.json({ success: true, campaign: await loadCampaign(row.id) });
  })
);

router.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row || !['Sending', 'Paused', 'Scheduled'].includes(row.status)) throw httpError(409, 'There is nothing left to cancel.');
    await query("UPDATE campaigns SET status = 'Cancelled' WHERE id = ?", [row.id]);
    const r = await query("UPDATE campaign_recipients SET status = 'cancelled' WHERE campaign_id = ? AND status IN ('pending','held')", [row.id]);
    await refreshCampaignCounts(row.id);
    await campaignEvent(row.id, 'cancelled', `Cancelled by ${req.user.name}`, `${r.affectedRows} not sent`);
    await audit(req.user.name, `cancelled the rest of ${row.title}`);
    res.json({ success: true, campaign: await loadCampaign(row.id) });
  })
);

async function duplicate(row, { title, resendOf = null, actor }) {
  const id = newId(title, 120);
  const segs = (parseJson(row.segment_ids_json, []) || []).filter((s) => !String(s).startsWith('resend:'));
  await query(
    `INSERT INTO campaigns (id, month, day, title, status, subject_a, subject_b, ab_test, preview_text, from_name, from_email,
      reply_to, template_id, blocks_json, topic, group_ids_json, segment_ids_json, send_mode, timezone, ab_split_pct, ab_wait_hours, created_by)
     VALUES (?, '', '', ?, 'Draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'now', ?, ?, ?, ?)`,
    [
      id,
      title.slice(0, 255),
      row.subject_a,
      row.subject_b,
      resendOf ? 0 : row.ab_test,
      row.preview_text,
      row.from_name,
      row.from_email,
      row.reply_to,
      row.template_id,
      typeof row.blocks_json === 'string' || row.blocks_json === null ? row.blocks_json : JSON.stringify(row.blocks_json),
      row.topic,
      resendOf ? '[]' : JSON.stringify(parseJson(row.group_ids_json, []) || []),
      JSON.stringify(resendOf ? [`resend:${resendOf}`] : segs),
      row.timezone,
      row.ab_split_pct,
      row.ab_wait_hours,
      actor,
    ]
  );
  return id;
}

router.post(
  '/:id/duplicate',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    const id = await duplicate(row, { title: `Copy of ${row.title}`, actor: req.user.name });
    res.status(201).json({ success: true, campaign: await loadCampaign(id) });
  })
);

router.post(
  '/:id/resend-non-openers',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    if (row.legacy) throw httpError(409, 'This campaign was sent before the upgrade, so who opened it isn’t known per person.');
    const id = await duplicate(row, { title: `${row.title} (resend to non-openers)`, resendOf: row.id, actor: req.user.name });
    res.status(201).json({ success: true, campaign: await loadCampaign(id) });
  })
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
router.get(
  '/:id/report',
  asyncRoute(async (req, res) => {
    const c = await loadCampaign(req.params.id);
    if (!c) throw httpError(404, 'Campaign not found.');
    const links = await query('SELECT url, label, clicks FROM link_clicks WHERE campaign_id = ? ORDER BY clicks DESC LIMIT 20', [c.id]);
    const problems = await query(
      `SELECT r.id, r.email, r.name, r.status, r.error, r.bounced_at, r.complained_at, r.contact_id
       FROM campaign_recipients r WHERE r.campaign_id = ?
         AND (r.status = 'failed' OR r.bounced_at IS NOT NULL OR r.complained_at IS NOT NULL)
       ORDER BY r.id DESC LIMIT 50`,
      [c.id]
    );
    const activity = await query(
      'SELECT id, type, title, detail, created_at FROM events WHERE campaign_id = ? AND contact_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 30',
      [c.id]
    );
    const [opens] = await query(
      'SELECT MIN(opened_at) AS first_open, COUNT(opened_at) AS n FROM campaign_recipients WHERE campaign_id = ?',
      [c.id]
    );
    const variants = c.abTest
      ? await query(
          `SELECT variant, SUM(sent_at IS NOT NULL) AS sent, SUM(opened_at IS NOT NULL) AS opened
           FROM campaign_recipients WHERE campaign_id = ? AND variant IS NOT NULL GROUP BY variant ORDER BY variant`,
          [c.id]
        )
      : [];
    const tpl = c.templateId ? await one('SELECT * FROM templates WHERE id = ?', [c.templateId]) : null;
    const plannedLinks = extractLinks(c.blocks || campaignBlocks({}, tpl));
    res.json({
      success: true,
      campaign: c,
      links: [
        ...plannedLinks.map((l) => ({ ...l, clicks: Number(links.find((x) => x.url === l.url)?.clicks || 0) })),
        ...links.filter((x) => !plannedLinks.some((l) => l.url === x.url)).map((x) => ({ url: x.url, label: x.label, clicks: Number(x.clicks) })),
      ],
      problems: problems.map((p) => ({
        id: p.id,
        email: p.email,
        name: p.name,
        contactId: p.contact_id,
        kind: p.complained_at ? 'complaint' : p.bounced_at ? 'bounce' : 'failed',
        error: p.error || '',
      })),
      activity: activity.map((a) => ({ id: a.id, type: a.type, title: a.title, detail: a.detail, at: a.created_at })),
      firstOpenAt: opens.first_open,
      variants: variants.map((v) => ({ variant: v.variant, sent: Number(v.sent), opened: Number(v.opened) })),
    });
  })
);

router.get(
  '/:id/recipients',
  asyncRoute(async (req, res) => {
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filters = {
      waiting: "r.status IN ('pending','sending','held')",
      sent: 'r.sent_at IS NOT NULL',
      opened: 'r.opened_at IS NOT NULL',
      clicked: 'r.clicked_at IS NOT NULL',
      problems: "(r.status = 'failed' OR r.bounced_at IS NOT NULL OR r.complained_at IS NOT NULL)",
    };
    const where = filters[req.query.filter] || '1 = 1';
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM campaign_recipients r WHERE r.campaign_id = ? AND ${where}`, [req.params.id]);
    const rows = await query(
      `SELECT r.id, r.email, r.name, r.status, r.variant, r.error, r.sent_at, r.opened_at, r.clicked_at, r.bounced_at, r.complained_at, r.contact_id
       FROM campaign_recipients r WHERE r.campaign_id = ? AND ${where} ORDER BY r.id LIMIT ? OFFSET ?`,
      [req.params.id, pageSize, (page - 1) * pageSize]
    );
    res.json({ success: true, total: Number(n), page, pageSize, recipients: rows });
  })
);

router.post(
  '/:id/recipients/:rid/retry',
  asyncRoute(async (req, res) => {
    const r = await query(
      `UPDATE campaign_recipients r JOIN contacts c ON c.id = r.contact_id
       SET r.status = 'pending', r.attempts = 0, r.error = NULL
       WHERE r.id = ? AND r.campaign_id = ? AND r.status = 'failed' AND c.status = 'Subscribed'`,
      [req.params.rid, req.params.id]
    );
    if (!r.affectedRows) throw httpError(409, 'Only failed emails to subscribed people can be retried.');
    await query("UPDATE campaigns SET status = 'Sending', completed_at = NULL WHERE id = ? AND status = 'Completed'", [req.params.id]);
    await campaignEvent(req.params.id, 'retry', `${req.user.name} retried a failed email`);
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// Preview and test sends
// ---------------------------------------------------------------------------
async function sampleContact(contactId) {
  const c = contactId ? await one('SELECT * FROM contacts WHERE id = ?', [contactId]) : null;
  if (!c) return { firstName: 'Jane', name: 'Jane Doe', email: 'jane@example.com' };
  return {
    name: c.name,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    city: c.city,
    plan: c.plan,
    customFields: parseJson(c.custom_fields_json, {}),
  };
}

router.get(
  '/:id/preview',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    const tpl = row.template_id ? await one('SELECT * FROM templates WHERE id = ?', [row.template_id]) : null;
    const email = renderEmail({
      blocks: campaignBlocks(row, tpl),
      subject: req.query.variant === 'B' && row.subject_b ? row.subject_b : row.subject_a,
      previewText: row.preview_text,
      contact: await sampleContact(req.query.contactId),
      settings: await getSettings(),
      isTest: true,
    });
    res.json({ success: true, ...email });
  })
);

router.post(
  '/:id/send-test',
  asyncRoute(async (req, res) => {
    const row = await getCampaignRow(req.params.id);
    if (!row) throw httpError(404, 'Campaign not found.');
    const emails = [...new Set((req.body?.emails || []).map(normalizeEmail))].filter(Boolean);
    if (!emails.length) throw httpError(400, 'Add at least one email to send the test to.');
    if (emails.length > 5) throw httpError(400, 'Send a test to at most 5 people at a time.');
    const bad = emails.find((e) => !isValidEmail(e));
    if (bad) throw httpError(400, `${bad} isn’t a valid email address.`);

    const settings = await getSettings();
    const allowance = await sendingAllowance(settings);
    if (allowance.remaining < emails.length) throw httpError(429, 'You’ve reached today’s sending limit.');
    if (!row.from_email) throw httpError(400, 'Choose a sender email first.');

    const tpl = row.template_id ? await one('SELECT * FROM templates WHERE id = ?', [row.template_id]) : null;
    const contact = await sampleContact(req.body?.asContactId);
    const results = [];
    for (const variant of row.ab_test && row.subject_b ? ['A', 'B'] : ['A']) {
      const email = renderEmail({
        blocks: campaignBlocks(row, tpl),
        subject: `[Test${variant === 'B' ? ' B' : ''}] ${variant === 'B' ? row.subject_b : row.subject_a}`,
        previewText: row.preview_text,
        contact,
        settings,
        isTest: true,
      });
      for (const to of emails) {
        try {
          const r = await sendEmail({ settings, to, fromEmail: row.from_email, fromName: row.from_name, replyTo: row.reply_to, ...email });
          await query('INSERT INTO test_sends (campaign_id, email, sent_by, simulated) VALUES (?, ?, ?, ?)', [row.id, to, req.user.name, r.simulated ? 1 : 0]);
          results.push({ to, variant, ok: true, simulated: r.simulated });
        } catch (err) {
          results.push({ to, variant, ok: false, error: err.message });
        }
      }
    }
    await audit(req.user.name, `sent a test of ${row.title}`);
    const failed = results.filter((r) => !r.ok);
    res.status(failed.length === results.length ? 502 : 200).json({
      success: failed.length < results.length,
      message: failed.length ? `Some tests failed: ${failed[0].error}` : undefined,
      results,
      simulated: results.every((r) => r.simulated),
    });
  })
);

export default router;
