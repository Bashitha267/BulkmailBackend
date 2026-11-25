import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { query, one } from '../config/db.js';
import { normalizeEmail } from '../lib/util.js';
import { setContactStatus, recordContactEvent } from './contacts.service.js';
import { markCampaignDirty } from './worker.service.js';

// ---------------------------------------------------------------------------
// Signature verification (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
// ---------------------------------------------------------------------------
const certCache = new Map();
const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

function isAwsUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && CERT_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

async function fetchCert(url) {
  if (certCache.has(url)) return certCache.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Could not fetch SNS certificate (${res.status})`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

function stringToSign(msg) {
  const keys =
    msg.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.filter((k) => msg[k] !== undefined).map((k) => `${k}\n${msg[k]}\n`).join('');
}

export async function verifySnsMessage(msg) {
  if (!msg || typeof msg !== 'object') return 'Body is not an SNS message.';
  if (!env.aws.snsTopicArns.length) return 'SES_SNS_TOPIC_ARNS is not set on the server.';
  if (!env.aws.snsTopicArns.includes(msg.TopicArn)) return `Topic ${msg.TopicArn} is not in SES_SNS_TOPIC_ARNS.`;
  if (!isAwsUrl(msg.SigningCertURL) || !/\.pem$/.test(new URL(msg.SigningCertURL).pathname)) return 'Certificate URL is not from Amazon SNS.';
  const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : msg.SignatureVersion === '1' ? 'RSA-SHA1' : null;
  if (!algorithm) return 'Unknown SNS signature version.';
  const pem = await fetchCert(msg.SigningCertURL);
  const ok = crypto.verify(algorithm, Buffer.from(stringToSign(msg), 'utf8'), pem, Buffer.from(msg.Signature || '', 'base64'));
  return ok ? null : 'SNS signature does not match.';
}

export async function confirmSubscription(msg) {
  if (!isAwsUrl(msg.SubscribeURL)) throw new Error('SubscribeURL is not from Amazon SNS.');
  const res = await fetch(msg.SubscribeURL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Subscription confirmation failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// SES event handling
// ---------------------------------------------------------------------------
async function findSend(messageId) {
  if (!messageId) return null;
  const r = await one('SELECT id, campaign_id, contact_id, email FROM campaign_recipients WHERE message_id = ? LIMIT 1', [messageId]);
  if (r) return { ...r, kind: 'r' };
  const a = await one('SELECT id, contact_id, email FROM automation_sends WHERE message_id = ? LIMIT 1', [messageId]);
  return a ? { ...a, kind: 'a' } : null;
}

async function contactIdFor(email, send) {
  if (send?.contact_id && normalizeEmail(send.email) === normalizeEmail(email)) return send.contact_id;
  const c = await one('SELECT id FROM contacts WHERE email = ?', [normalizeEmail(email)]);
  return c?.id || null;
}

export async function handleSesEvent(event) {
  const type = event.notificationType || event.eventType;
  const send = await findSend(event.mail?.messageId);
  const markRecipient = async (column) => {
    if (send?.kind !== 'r') return;
    await query(`UPDATE campaign_recipients SET ${column} = COALESCE(${column}, UTC_TIMESTAMP()) WHERE id = ?`, [send.id]);
    markCampaignDirty(send.campaign_id);
  };

  if (type === 'Delivery') {
    await markRecipient('delivered_at');
    return { handled: 'delivery' };
  }

  if (type === 'Bounce') {
    const bounce = event.bounce || {};
    const permanent = bounce.bounceType === 'Permanent';
    for (const r of bounce.bouncedRecipients || []) {
      const contactId = await contactIdFor(r.emailAddress, send);
      const reason = (r.diagnosticCode || bounce.bounceSubType || 'Bounced').slice(0, 300);
      if (permanent) {
        await markRecipient('bounced_at');
        if (contactId) await setContactStatus(contactId, 'Bounced', { reason, campaignId: send?.campaign_id });
      } else if (contactId) {
        await recordContactEvent(contactId, { type: 'soft_bounce', title: 'Temporary delivery problem', detail: reason });
      }
    }
    return { handled: permanent ? 'hard_bounce' : 'soft_bounce' };
  }

  if (type === 'Complaint') {
    for (const r of event.complaint?.complainedRecipients || []) {
      await markRecipient('complained_at');
      const contactId = await contactIdFor(r.emailAddress, send);
      if (contactId) {
        await setContactStatus(contactId, 'Complained', {
          reason: event.complaint.complaintFeedbackType || 'Marked as spam',
          campaignId: send?.campaign_id,
        });
      }
    }
    if (send?.campaign_id) {
      await query('INSERT INTO events (type, campaign_id, title) VALUES (?, ?, ?)', [
        'complaint',
        send.campaign_id,
        'Someone marked it as spam · suppressed automatically',
      ]);
    }
    return { handled: 'complaint' };
  }

  return { handled: null };
}
