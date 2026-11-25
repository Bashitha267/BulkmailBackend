import { Router } from 'express';
import dns from 'node:dns/promises';
import bcrypt from 'bcryptjs';
import { query, one } from '../config/db.js';
import { env } from '../config/env.js';
import { requireAuth, requireRole, asyncRoute, httpError, serializeUser } from '../middleware/auth.js';
import { initialsOf, isValidEmail, normalizeEmail, randomHex, slugify } from '../lib/util.js';
import { getSettings, saveSetting, audit, warmupState } from '../services/settings.service.js';
import {
  isLive,
  sesModeReason,
  hasSesCredentials,
  getSendQuota,
  startDomainVerification,
  getDomainStatus,
  verifySenderEmail,
  getIdentityStatuses,
  sendEmail,
} from '../services/ses.service.js';
import { sendingAllowance, workerState } from '../services/worker.service.js';
import { WARMUP_SCHEDULE } from '../lib/defaults.js';

const router = Router();
router.use(requireAuth);

const REGION_NAMES = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-west-2': 'Europe (London)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
};

async function team() {
  const rows = await query("SELECT * FROM users WHERE status = 'active' ORDER BY FIELD(role, 'Owner', 'Editor', 'Viewer'), id");
  return rows.map((u) => ({ ...serializeUser(u), lastLoginAt: u.last_login_at }));
}

router.get(
  '/settings',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings({ fresh: true });
    const allowance = await sendingAllowance(settings);
    const audit = await query('SELECT actor, action, created_at FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 15');
    const [events] = await query(
      `SELECT MAX(delivered_at) AS delivery, MAX(bounced_at) AS bounce, MAX(complained_at) AS complaint FROM campaign_recipients`
    );
    res.json({
      success: true,
      settings,
      ses: {
        mode: isLive(settings) ? 'live' : 'simulation',
        modeReason: sesModeReason(settings),
        hasCredentials: hasSesCredentials(),
        forcedSimulation: env.aws.forceSimulation,
        region: env.aws.region,
        regionName: REGION_NAMES[env.aws.region] || env.aws.region,
        quota: allowance.quota,
        snsConfigured: env.aws.snsTopicArns.length > 0,
        webhookUrl: `${env.publicBaseUrl}/api/webhooks/ses`,
        lastEvents: { delivery: events.delivery, bounce: events.bounce, complaint: events.complaint },
      },
      allowance: {
        limit: allowance.limit === Infinity ? null : allowance.limit,
        used: allowance.used,
        remaining: allowance.remaining === Infinity ? null : allowance.remaining,
        source: allowance.source,
      },
      warmup: { ...(warmupState(settings.ses) || {}), enabled: Boolean(settings.ses.warmup?.enabled), schedule: WARMUP_SCHEDULE },
      worker: workerState,
      team: await team(),
      auditLog: audit.map((a) => ({ actor: a.actor, action: a.action, at: a.created_at })),
    });
  })
);

router.put(
  '/settings',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const current = await getSettings({ fresh: true });
    if (b.general) {
      await saveSetting('general', {
        ...current.general,
        teamName: String(b.general.teamName ?? current.general.teamName).slice(0, 120) || current.general.teamName,
        fromName: String(b.general.fromName ?? current.general.fromName).slice(0, 120),
        replyTo: b.general.replyTo ? normalizeEmail(b.general.replyTo) : '',
      });
      if (b.general.teamName) await query('UPDATE users SET team_name = ?', [String(b.general.teamName).slice(0, 120)]);
    }
    if (b.ses) {
      const sendRate = Math.min(500, Math.max(1, parseInt(b.ses.sendRate ?? current.ses.sendRate, 10) || 10));
      const quota = await getSendQuota(current);
      if (quota?.maxRate && sendRate > quota.maxRate) throw httpError(400, `Your SES limit is ${quota.maxRate} a second.`);
      await saveSetting('ses', {
        ...current.ses,
        sendRate,
        retries: Math.min(10, Math.max(0, parseInt(b.ses.retries ?? current.ses.retries, 10) || 0)),
        dailyLimit: Math.max(0, parseInt(b.ses.dailyLimit ?? current.ses.dailyLimit, 10) || 0),
        simulation: b.ses.simulation !== undefined ? Boolean(b.ses.simulation) : current.ses.simulation,
        warmup: {
          ...current.ses.warmup,
          enabled: b.ses.warmupEnabled !== undefined ? Boolean(b.ses.warmupEnabled) : current.ses.warmup.enabled,
        },
      });
    }
    if (b.compliance) {
      const c = b.compliance;
      await saveSetting('compliance', {
        ...current.compliance,
        address: String(c.address ?? current.compliance.address).slice(0, 300),
        oneClickUnsubscribe: c.oneClickUnsubscribe ?? current.compliance.oneClickUnsubscribe,
        doubleOptIn: c.doubleOptIn ?? current.compliance.doubleOptIn,
        preferencePage: c.preferencePage ?? current.compliance.preferencePage,
        trackOpens: c.trackOpens ?? current.compliance.trackOpens,
        trackClicks: c.trackClicks ?? current.compliance.trackClicks,
      });
    }
    await audit(req.user.name, 'changed settings');
    res.json({ success: true, settings: await getSettings({ fresh: true }) });
  })
);

// ---------------------------------------------------------------------------
// Contact fields
// ---------------------------------------------------------------------------
router.post(
  '/settings/fields',
  requireRole('Editor'),
  asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Give the field a name.');
    const type = ['text', 'number', 'date', 'choice'].includes(req.body?.type) ? req.body.type : 'text';
    const settings = await getSettings({ fresh: true });
    const key = slugify(name).replace(/-(.)/g, (_, ch) => ch.toUpperCase()).slice(0, 40);
    if (settings.fields.some((f) => f.key === key)) throw httpError(409, 'A field with this name already exists.');
    const options = type === 'choice' ? (req.body.options || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 30) : undefined;
    const fields = [...settings.fields, { key, name, type, ...(options ? { options } : {}) }];
    await saveSetting('fields', fields);
    res.status(201).json({ success: true, fields });
  })
);

router.delete(
  '/settings/fields/:key',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const settings = await getSettings({ fresh: true });
    const field = settings.fields.find((f) => f.key === req.params.key);
    if (!field) throw httpError(404, 'Field not found.');
    if (field.builtIn) throw httpError(400, 'City and Plan are built in and can’t be removed.');
    const fields = settings.fields.filter((f) => f.key !== field.key);
    await saveSetting('fields', fields);
    res.json({ success: true, fields });
  })
);

router.get(
  '/settings/fields/usage',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    const usage = {};
    const [builtIn] = await query("SELECT SUM(city <> '') AS city, SUM(plan <> '') AS plan FROM contacts");
    usage.city = Number(builtIn.city) || 0;
    usage.plan = Number(builtIn.plan) || 0;
    for (const f of settings.fields.filter((x) => !x.builtIn)) {
      const [r] = await query(
        `SELECT COUNT(*) AS n FROM contacts WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(custom_fields_json, '$.${f.key.replace(/[^A-Za-z0-9_]/g, '')}')), '') <> ''`
      );
      usage[f.key] = Number(r.n);
    }
    res.json({ success: true, usage });
  })
);

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------
async function sendersWithStatus(settings) {
  const statuses = await getIdentityStatuses(
    [...new Set(settings.senders.flatMap((s) => [s.email, s.email.split('@')[1]]))],
    settings
  ).catch(() => ({}));
  return settings.senders.map((s) => {
    const live = isLive(settings);
    const verified = !live || statuses[s.email] === 'Success' || statuses[s.email.split('@')[1]] === 'Success';
    return { ...s, verified, status: live ? statuses[s.email] || statuses[s.email.split('@')[1]] || 'NotStarted' : 'Simulation' };
  });
}

router.get(
  '/settings/senders',
  asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    res.json({ success: true, senders: await sendersWithStatus(settings) });
  })
);

router.post(
  '/settings/senders',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) throw httpError(400, 'Enter a valid email address.');
    const settings = await getSettings({ fresh: true });
    if (settings.senders.some((s) => s.email === email)) throw httpError(409, 'This sender is already added.');
    const domain = email.split('@')[1];
    const statuses = await getIdentityStatuses([domain], settings).catch(() => ({}));
    // If the whole domain is verified in SES, the address works without its own verification email.
    if (isLive(settings) && statuses[domain] !== 'Success') await verifySenderEmail(email, settings);
    const senders = [...settings.senders, { email, isDefault: settings.senders.length === 0 }];
    const saved = await saveSetting('senders', senders);
    await audit(req.user.name, `added the sender ${email}`);
    res.status(201).json({
      success: true,
      senders: await sendersWithStatus(saved),
      message: isLive(settings) && statuses[domain] !== 'Success' ? `Amazon SES sent a verification link to ${email}.` : undefined,
    });
  })
);

router.patch(
  '/settings/senders/default',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const settings = await getSettings({ fresh: true });
    if (!settings.senders.some((s) => s.email === email)) throw httpError(404, 'Sender not found.');
    const saved = await saveSetting('senders', settings.senders.map((s) => ({ ...s, isDefault: s.email === email })));
    res.json({ success: true, senders: await sendersWithStatus(saved) });
  })
);

router.delete(
  '/settings/senders/:email',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const settings = await getSettings({ fresh: true });
    let senders = settings.senders.filter((s) => s.email !== email);
    if (senders.length && !senders.some((s) => s.isDefault)) senders = senders.map((s, i) => ({ ...s, isDefault: i === 0 }));
    const saved = await saveSetting('senders', senders);
    res.json({ success: true, senders: await sendersWithStatus(saved) });
  })
);

// ---------------------------------------------------------------------------
// Domains: real DNS lookups plus SES DKIM status
// ---------------------------------------------------------------------------
async function txt(name) {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function cname(name) {
  try {
    return (await dns.resolveCname(name)).map((c) => c.toLowerCase().replace(/\.$/, ''));
  } catch {
    return [];
  }
}

export async function checkDomain(domain, settings) {
  const name = domain.name;
  const rootTxt = await txt(name);
  const spfRecord = rootTxt.find((t) => t.toLowerCase().startsWith('v=spf1')) || null;
  const spf = spfRecord ? (/include:amazonses\.com/i.test(spfRecord) ? 'pass' : 'mismatch') : 'missing';

  let tokens = domain.dkimTokens || [];
  let sesStatus = null;
  if (isLive(settings)) {
    const st = await getDomainStatus(name, settings).catch(() => null);
    if (st) {
      sesStatus = st;
      if (st.dkimTokens?.length) tokens = st.dkimTokens;
    }
  }
  const dkimChecks = await Promise.all(
    tokens.map(async (t) => {
      const found = await cname(`${t}._domainkey.${name}`);
      return found.includes(`${t}.dkim.amazonses.com`);
    })
  );
  let dkim = tokens.length === 0 ? 'unknown' : dkimChecks.every(Boolean) ? 'pass' : 'missing';
  if (sesStatus?.dkimStatus === 'Success') dkim = 'pass';

  const dmarcRecord = (await txt(`_dmarc.${name}`)).find((t) => t.toUpperCase().startsWith('V=DMARC1')) || null;
  const dmarc = dmarcRecord ? 'pass' : 'missing';

  const suggestedSpf =
    spf === 'mismatch' ? spfRecord.replace(/\s*([~?-]all|\+all)\s*$/i, ' include:amazonses.com $1').trim() : 'v=spf1 include:amazonses.com ~all';

  return {
    ...domain,
    dkimTokens: tokens,
    records: { spf, dkim, dmarc },
    found: { spf: spfRecord, dmarc: dmarcRecord, dkim: dkimChecks },
    expected: {
      spf: { type: 'TXT', name, value: suggestedSpf },
      dkim: tokens.map((t) => ({ type: 'CNAME', name: `${t}._domainkey`, value: `${t}.dkim.amazonses.com` })),
      dmarc: { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=none; rua=mailto:dmarc@${name}` },
    },
    sesStatus: sesStatus ? sesStatus.verification : null,
    lastCheckedAt: new Date().toISOString(),
  };
}

async function saveDomain(updated) {
  const settings = await getSettings({ fresh: true });
  const domains = settings.domains.map((d) => (d.name === updated.name ? updated : d));
  await saveSetting('domains', domains);
  return updated;
}

router.get(
  '/domains',
  asyncRoute(async (_req, res) => res.json({ success: true, domains: (await getSettings()).domains }))
);

router.post(
  '/domains',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(name)) throw httpError(400, 'Enter a domain like example.com.');
    const settings = await getSettings({ fresh: true });
    if (settings.domains.some((d) => d.name === name)) throw httpError(409, 'This domain is already added.');
    const started = await startDomainVerification(name, settings);
    const domain = { name, addedAt: new Date().toISOString(), dkimTokens: started.tokens, records: {} };
    await saveSetting('domains', [...settings.domains, domain]);
    const checked = await saveDomain(await checkDomain(domain, settings));
    await audit(req.user.name, `added the domain ${name}`);
    res.status(201).json({ success: true, domain: checked });
  })
);

router.get(
  '/domains/:name',
  asyncRoute(async (req, res) => {
    const settings = await getSettings();
    const d = settings.domains.find((x) => x.name === req.params.name);
    if (!d) throw httpError(404, 'Domain not found.');
    res.json({ success: true, domain: d, warmup: { ...(warmupState(settings.ses) || {}), enabled: Boolean(settings.ses.warmup?.enabled), schedule: WARMUP_SCHEDULE } });
  })
);

router.post(
  '/domains/:name/check',
  asyncRoute(async (req, res) => {
    const settings = await getSettings({ fresh: true });
    const d = settings.domains.find((x) => x.name === req.params.name);
    if (!d) throw httpError(404, 'Domain not found.');
    res.json({ success: true, domain: await saveDomain(await checkDomain(d, settings)) });
  })
);

router.delete(
  '/domains/:name',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const settings = await getSettings({ fresh: true });
    await saveSetting('domains', settings.domains.filter((d) => d.name !== req.params.name));
    await audit(req.user.name, `removed the domain ${req.params.name}`);
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------
const ROLES = ['Owner', 'Editor', 'Viewer'];

router.post(
  '/settings/team',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim().slice(0, 120) || email.split('@')[0];
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'Editor';
    if (!isValidEmail(email)) throw httpError(400, 'Enter a valid email address.');
    const existing = await one('SELECT id, status FROM users WHERE username = ? OR LOWER(email) = ?', [email, email]);
    if (existing?.status === 'active') throw httpError(409, 'This person is already on the team.');

    const tempPassword = randomHex(6);
    const hash = await bcrypt.hash(tempPassword, 12);
    if (existing) {
      await query("UPDATE users SET status = 'active', role = ?, name = ?, password_hash = ?, password_changed_at = UTC_TIMESTAMP() WHERE id = ?", [role, name, hash, existing.id]);
    } else {
      await query(
        `INSERT INTO users (username, password_hash, name, email, role, initials, team_name, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [email, hash, name, email, role, initialsOf(name, email), req.user.teamName]
      );
    }

    const settings = await getSettings();
    const sender = settings.senders.find((s) => s.isDefault) || settings.senders[0];
    let emailed = false;
    if (sender && isLive(settings)) {
      try {
        const text = `${req.user.name} added you to ${req.user.teamName} on Bulk Mailer as ${role}.\n\nSign in at ${env.appUrl}/login\nUsername: ${email}\nTemporary password: ${tempPassword}\n\nChange the password after you sign in.`;
        await sendEmail({
          settings,
          to: email,
          fromEmail: sender.email,
          fromName: settings.general.teamName,
          subject: `You’ve been added to ${req.user.teamName}`,
          text,
          html: `<pre style="font:14px/1.6 sans-serif">${text.replace(/</g, '&lt;')}</pre>`,
        });
        emailed = true;
      } catch {
        emailed = false;
      }
    }
    await audit(req.user.name, `invited ${email} as ${role}`);
    res.status(201).json({
      success: true,
      team: await team(),
      emailed,
      // Shown once to the owner when the invite couldn't be emailed.
      tempPassword: emailed ? undefined : tempPassword,
    });
  })
);

router.patch(
  '/settings/team/:id',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const role = req.body?.role;
    if (!ROLES.includes(role)) throw httpError(400, 'Pick Owner, Editor or Viewer.');
    const u = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!u) throw httpError(404, 'Team member not found.');
    if (u.role === 'Owner' && role !== 'Owner') {
      const [{ n }] = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'Owner' AND status = 'active'");
      if (Number(n) <= 1) throw httpError(400, 'There must be at least one owner.');
    }
    await query('UPDATE users SET role = ? WHERE id = ?', [role, u.id]);
    await audit(req.user.name, `made ${u.name} ${role}`);
    res.json({ success: true, team: await team() });
  })
);

router.delete(
  '/settings/team/:id',
  requireRole('Owner'),
  asyncRoute(async (req, res) => {
    const u = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!u) throw httpError(404, 'Team member not found.');
    if (u.id === req.user.id) throw httpError(400, 'You can’t remove yourself.');
    if (u.role === 'Owner') {
      const [{ n }] = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'Owner' AND status = 'active'");
      if (Number(n) <= 1) throw httpError(400, 'There must be at least one owner.');
    }
    await query("UPDATE users SET status = 'removed' WHERE id = ?", [u.id]);
    await audit(req.user.name, `removed ${u.name} from the team`);
    res.json({ success: true, team: await team() });
  })
);

export default router;
