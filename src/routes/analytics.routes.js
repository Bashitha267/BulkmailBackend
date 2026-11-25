import { Router } from 'express';
import { query } from '../config/db.js';
import { requireAuth, asyncRoute } from '../middleware/auth.js';
import { serializeCampaign, liveQueueCounts } from '../services/campaigns.service.js';
import { getSettings, warmupState } from '../services/settings.service.js';
import { isLive, sesModeReason } from '../services/ses.service.js';
import { sendingAllowance, workerState } from '../services/worker.service.js';
import { contactCounts } from './contacts.routes.js';
import { WARMUP_SCHEDULE } from '../lib/defaults.js';

const router = Router();
router.use(requireAuth);

const PROVIDER_SQL = `CASE
  WHEN SUBSTRING_INDEX(email, '@', -1) IN ('gmail.com','googlemail.com') THEN 'Gmail'
  WHEN SUBSTRING_INDEX(email, '@', -1) LIKE 'yahoo.%' OR SUBSTRING_INDEX(email, '@', -1) IN ('ymail.com','rocketmail.com') THEN 'Yahoo'
  WHEN SUBSTRING_INDEX(email, '@', -1) IN ('outlook.com','hotmail.com','live.com','msn.com') OR SUBSTRING_INDEX(email, '@', -1) LIKE 'hotmail.%' OR SUBSTRING_INDEX(email, '@', -1) LIKE 'outlook.%' THEN 'Outlook'
  WHEN SUBSTRING_INDEX(email, '@', -1) IN ('icloud.com','me.com','mac.com') THEN 'iCloud'
  ELSE 'Other providers' END`;

function totalsOf(campaigns) {
  const t = { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complaints: 0, unsubscribed: 0 };
  for (const c of campaigns) for (const k of Object.keys(t)) t[k] += c.stats[k] || 0;
  return {
    ...t,
    deliveredRate: t.sent ? t.delivered / t.sent : 0,
    openRate: t.delivered ? t.opened / t.delivered : 0,
    clickRate: t.delivered ? t.clicked / t.delivered : 0,
    bounceRate: t.sent ? t.bounced / t.sent : 0,
    complaintRate: t.delivered ? t.complaints / t.delivered : 0,
    unsubscribeRate: t.delivered ? t.unsubscribed / t.delivered : 0,
  };
}

async function sentCampaigns(days) {
  const rows = await query(
    `SELECT * FROM campaigns WHERE sent_count > 0 ${days ? 'AND COALESCE(started_at, created_at) >= UTC_TIMESTAMP() - INTERVAL ? DAY' : ''}
     ORDER BY COALESCE(started_at, created_at) DESC`,
    days ? [days] : []
  );
  const live = await liveQueueCounts(rows.map((r) => r.id));
  return rows.map((r) => serializeCampaign(r, live.get(r.id)));
}

router.get(
  '/analytics',
  asyncRoute(async (req, res) => {
    const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const campaigns = await sentCampaigns(days);
    const providers = await query(
      `SELECT ${PROVIDER_SQL} AS provider, SUM(sent_at IS NOT NULL AND bounced_at IS NULL) AS delivered, SUM(opened_at IS NOT NULL) AS opened
       FROM campaign_recipients WHERE sent_at >= UTC_TIMESTAMP() - INTERVAL ? DAY GROUP BY provider ORDER BY delivered DESC`,
      [days]
    );
    const topLinks = await query(
      `SELECT l.url, l.label, SUM(l.clicks) AS clicks, c.title AS campaign FROM link_clicks l JOIN campaigns c ON c.id = l.campaign_id
       WHERE COALESCE(c.started_at, c.created_at) >= UTC_TIMESTAMP() - INTERVAL ? DAY
       GROUP BY l.url, l.label, c.title ORDER BY clicks DESC LIMIT 5`,
      [days]
    );
    const [unsub] = await query(
      "SELECT COUNT(*) AS n FROM contacts WHERE status = 'Unsubscribed' AND status_changed_at >= UTC_TIMESTAMP() - INTERVAL ? DAY",
      [days]
    );
    res.json({
      success: true,
      days,
      totals: totalsOf(campaigns),
      unsubscribedContacts: Number(unsub.n),
      perSendDay: campaigns
        .slice()
        .reverse()
        .map((c) => ({ id: c.id, title: c.title, date: c.startedAt || c.createdAt, sent: c.stats.sent, status: c.status })),
      providers: providers.map((p) => ({
        provider: p.provider,
        delivered: Number(p.delivered),
        openRate: Number(p.delivered) ? Number(p.opened) / Number(p.delivered) : 0,
      })),
      topLinks: topLinks.map((l) => ({ url: l.url, label: l.label, clicks: Number(l.clicks), campaign: l.campaign })),
      campaigns,
    });
  })
);

/** Setup progress shown on the dashboard and in the sidebar. */
async function setupSteps(settings, counts) {
  const domainsOk = settings.domains.some((d) => d.records?.spf === 'pass' && d.records?.dkim === 'pass' && d.records?.dmarc === 'pass');
  const [test] = await query('SELECT COUNT(*) AS n FROM test_sends');
  const steps = [
    { key: 'provider', title: 'Connect an email provider', done: isLive(settings) },
    { key: 'domain', title: 'Verify your domain', done: domainsOk },
    { key: 'address', title: 'Add your business address', done: Boolean(settings.compliance.address?.trim()) },
    { key: 'contacts', title: 'Import your contacts', done: counts.total > 0 },
    { key: 'test', title: 'Send yourself a test', done: Number(test.n) > 0 },
  ];
  const next = steps.find((s) => !s.done);
  let nextLabel = next ? next.title : null;
  if (next?.key === 'domain') {
    const d = settings.domains[0];
    if (d && d.records?.spf === 'pass' && d.records?.dkim === 'pass') nextLabel = 'Add your DMARC record';
  }
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length, next: nextLabel };
}

/** Small payload for the sidebar on every page. */
router.get(
  '/summary',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    const counts = await contactCounts();
    const [c] = await query('SELECT COUNT(*) AS campaigns FROM campaigns');
    const [t] = await query('SELECT COUNT(*) AS templates FROM templates');
    const [a] = await query('SELECT COUNT(*) AS n, SUM(active) AS active FROM automations');
    res.json({
      success: true,
      teamName: settings.general.teamName,
      sesMode: isLive(settings) ? 'live' : 'simulation',
      sesModeReason: sesModeReason(settings),
      counts: {
        contacts: counts.total,
        templates: Number(t.templates),
        campaigns: Number(c.campaigns),
        automations: Number(a.n),
        automationsActive: Number(a.active) || 0,
      },
      setup: await setupSteps(settings, counts),
    });
  })
);

router.get(
  '/dashboard',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    const counts = await contactCounts();
    const allSent = await sentCampaigns(0);
    const totals = totalsOf(allSent);
    const recentRows = await query('SELECT * FROM campaigns ORDER BY updated_at DESC LIMIT 4');
    const live = await liveQueueCounts(recentRows.map((r) => r.id));
    const recent = recentRows.map((r) => serializeCampaign(r, live.get(r.id)));

    const activeRows = await query("SELECT * FROM campaigns WHERE status IN ('Sending','Paused') ORDER BY updated_at DESC LIMIT 1");
    const activeLive = await liveQueueCounts(activeRows.map((r) => r.id));
    const active = activeRows[0] ? serializeCampaign(activeRows[0], activeLive.get(activeRows[0].id)) : null;

    const attention = [];
    const domain = settings.domains[0];
    if (domain && domain.records?.dmarc !== 'pass') {
      attention.push({ key: 'dmarc', kind: 'error', title: 'DMARC record missing', detail: 'Gmail and Yahoo require it for bulk mail', action: 'Fix', to: `/domains/${encodeURIComponent(domain.name)}` });
    }
    if (!settings.compliance.address?.trim()) {
      attention.push({ key: 'address', kind: 'error', title: 'No business address', detail: 'Required in every marketing email', action: 'Add', to: '/settings' });
    }
    const paused = await query("SELECT id, title FROM campaigns WHERE status = 'Paused' ORDER BY paused_at DESC LIMIT 3");
    const pausedLive = await liveQueueCounts(paused.map((p) => p.id));
    for (const p of paused) {
      attention.push({ key: `paused-${p.id}`, kind: 'paused', title: `${p.title} paused`, detail: `${pausedLive.get(p.id)?.waiting || 0} people still waiting`, action: 'Resume', campaignId: p.id });
    }
    const [complaints] = await query(
      "SELECT COUNT(*) AS n FROM contacts WHERE status = 'Complained' AND status_changed_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY"
    );
    if (Number(complaints.n)) {
      attention.push({ key: 'complaints', kind: 'complaint', title: `${complaints.n} spam complaint${Number(complaints.n) > 1 ? 's' : ''}`, detail: 'Contact suppressed automatically', action: 'View', to: '/contacts?status=complained' });
    }
    if (workerState.holdReason) attention.push({ key: 'limit', kind: 'warn', title: 'Daily limit reached', detail: workerState.holdReason, action: null });

    const allowance = await sendingAllowance(settings);
    res.json({
      success: true,
      sesMode: isLive(settings) ? 'live' : 'simulation',
      sesModeReason: sesModeReason(settings),
      counts,
      totals,
      active,
      recent,
      attention,
      deliverability: {
        domain: domain ? { name: domain.name, records: domain.records || {} } : null,
        complaintRate: totals.complaintRate,
        bounceRate: totals.bounceRate,
        oneClickUnsubscribe: settings.compliance.oneClickUnsubscribe !== false,
      },
      allowance: { limit: allowance.limit === Infinity ? null : allowance.limit, used: allowance.used, remaining: allowance.remaining === Infinity ? null : allowance.remaining, source: allowance.source },
      warmup: warmupState(settings.ses) ? { ...warmupState(settings.ses), schedule: WARMUP_SCHEDULE } : { enabled: Boolean(settings.ses.warmup?.enabled), day: null, schedule: WARMUP_SCHEDULE },
      setup: await setupSteps(settings, counts),
    });
  })
);

export default router;
