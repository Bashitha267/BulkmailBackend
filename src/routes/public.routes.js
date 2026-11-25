import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, one, parseJson } from '../config/db.js';
import { requireDb, asyncRoute, httpError } from '../middleware/auth.js';
import { maskEmail } from '../lib/util.js';
import { TOPICS } from '../lib/defaults.js';
import { getSettings } from '../services/settings.service.js';
import { setContactStatus, recordContactEvent } from '../services/contacts.service.js';
import { markCampaignDirty } from '../services/worker.service.js';

/** Pages subscribers reach from links in emails. No login; the token is the key. */
const router = Router();
router.use(requireDb, rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }));

async function contactByToken(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token))) throw httpError(404, 'This link isn’t valid any more.');
  const c = await one('SELECT * FROM contacts WHERE unsub_token = ?', [token]);
  if (!c) throw httpError(404, 'This link isn’t valid any more.');
  return c;
}

async function markLatestUnsubscribe(contactId) {
  const r = await one(
    'SELECT id, campaign_id FROM campaign_recipients WHERE contact_id = ? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1',
    [contactId]
  );
  if (r) {
    await query('UPDATE campaign_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, UTC_TIMESTAMP()) WHERE id = ?', [r.id]);
    markCampaignDirty(r.campaign_id);
  }
}

function view(c, settings) {
  const prefs = parseJson(c.preferences_json, {}) || {};
  return {
    email: maskEmail(c.email),
    teamName: settings.general.teamName,
    address: settings.compliance.address,
    status: c.status,
    topics: TOPICS.map((t) => ({ ...t, subscribed: prefs.topics?.[t.key] !== false })),
    frequency: prefs.frequency === 'monthly' ? 'monthly' : 'any',
  };
}

router.get(
  '/preferences/:token',
  asyncRoute(async (req, res) => {
    const c = await contactByToken(req.params.token);
    res.json({ success: true, ...view(c, await getSettings()) });
  })
);

router.post(
  '/preferences/:token',
  asyncRoute(async (req, res) => {
    const c = await contactByToken(req.params.token);
    const topics = {};
    for (const t of TOPICS) topics[t.key] = req.body?.topics?.[t.key] !== false;
    const frequency = req.body?.frequency === 'monthly' ? 'monthly' : 'any';
    await query('UPDATE contacts SET preferences_json = ? WHERE id = ?', [JSON.stringify({ topics, frequency }), c.id]);
    await recordContactEvent(c.id, { type: 'preferences', title: 'Updated email preferences' });
    // Choosing nothing at all is the same as unsubscribing.
    if (!Object.values(topics).some(Boolean)) {
      await setContactStatus(c.id, 'Unsubscribed', { reason: 'Turned off every topic' });
      await markLatestUnsubscribe(c.id);
    } else if (c.status === 'Unsubscribed') {
      await setContactStatus(c.id, 'Subscribed', { reason: 'Chose topics on the preference page' });
    }
    const fresh = await one('SELECT * FROM contacts WHERE id = ?', [c.id]);
    res.json({ success: true, ...view(fresh, await getSettings()) });
  })
);

/**
 * One-click unsubscribe (RFC 8058). Gmail and Yahoo POST "List-Unsubscribe=One-Click"
 * here; the unsubscribe page in the app posts here too.
 */
router.post(
  '/unsubscribe/:token',
  asyncRoute(async (req, res) => {
    const c = await contactByToken(req.params.token);
    if (c.status === 'Subscribed') {
      await setContactStatus(c.id, 'Unsubscribed', { reason: req.is('application/x-www-form-urlencoded') ? 'One-click unsubscribe in the inbox' : 'Unsubscribe link' });
      await markLatestUnsubscribe(c.id);
    }
    res.json({ success: true, ...view(await one('SELECT * FROM contacts WHERE id = ?', [c.id]), await getSettings()) });
  })
);

router.post(
  '/resubscribe/:token',
  asyncRoute(async (req, res) => {
    const c = await contactByToken(req.params.token);
    if (c.status !== 'Unsubscribed') throw httpError(409, 'This address can’t be resubscribed from here.');
    await setContactStatus(c.id, 'Subscribed', { reason: 'Resubscribed from the unsubscribe page' });
    res.json({ success: true, ...view(await one('SELECT * FROM contacts WHERE id = ?', [c.id]), await getSettings()) });
  })
);

const REASONS = { too_many: 'Too many emails', not_relevant: 'Not relevant to me', never_signed_up: 'I never signed up' };
router.post(
  '/feedback/:token',
  asyncRoute(async (req, res) => {
    const c = await contactByToken(req.params.token);
    const reason = REASONS[req.body?.reason];
    if (!reason) throw httpError(400, 'Pick a reason.');
    await recordContactEvent(c.id, { type: 'feedback', title: `Unsubscribe reason: ${reason}` });
    res.json({ success: true });
  })
);

export default router;
