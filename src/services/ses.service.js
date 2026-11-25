import {
  SESClient,
  SendRawEmailCommand,
  GetSendQuotaCommand,
  VerifyDomainDkimCommand,
  VerifyEmailIdentityCommand,
  GetIdentityVerificationAttributesCommand,
  GetIdentityDkimAttributesCommand,
} from '@aws-sdk/client-ses';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

let client = null;

function sesClient() {
  if (!client) {
    client = new SESClient({
      region: env.aws.region,
      credentials: { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey },
      maxAttempts: 2,
    });
  }
  return client;
}

export function hasSesCredentials() {
  return Boolean(env.aws.accessKeyId && env.aws.secretAccessKey);
}

/** Live only when credentials exist, the env var allows it, and the Settings toggle is off. */
export function isLive(settings) {
  return hasSesCredentials() && !env.aws.forceSimulation && !settings?.ses?.simulation;
}

export function sesModeReason(settings) {
  if (!hasSesCredentials()) return 'No AWS credentials set on the server';
  if (env.aws.forceSimulation) return 'SES_SIMULATION_MODE=true on the server';
  if (settings?.ses?.simulation) return 'Simulation mode is on in Settings';
  return null;
}

// ---------------------------------------------------------------------------
// MIME building
// ---------------------------------------------------------------------------
const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

function encodeWords(text) {
  const value = clean(text);
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // Split by code point so multi-byte characters are never cut in half.
  const chars = Array.from(value);
  const words = [];
  for (let i = 0; i < chars.length; i += 12) {
    words.push(`=?UTF-8?B?${Buffer.from(chars.slice(i, i + 12).join('')).toString('base64')}?=`);
  }
  return words.join('\r\n ');
}

export function formatAddress(name, email) {
  const addr = clean(email);
  const n = clean(name);
  if (!n) return addr;
  if (!/^[\x20-\x7e]*$/.test(n)) return `${encodeWords(n)} <${addr}>`;
  return `"${n.replace(/["\\]/g, '\\$&')}" <${addr}>`;
}

function base64Lines(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

export function buildRawMessage({ from, to, replyTo, subject, html, text, headers = {} }) {
  const boundary = `bm_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${from}`,
    `To: ${clean(to)}`,
    ...(replyTo ? [`Reply-To: ${clean(replyTo)}`] : []),
    `Subject: ${encodeWords(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...Object.entries(headers)
      .filter(([, v]) => v)
      .map(([k, v]) => `${clean(k)}: ${clean(v)}`),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text || ''),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html || ''),
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
const TEMPORARY = new Set([
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalFailure',
  'RequestTimeout',
  'TimeoutError',
]);

export function isTemporaryError(err) {
  if (!err) return false;
  if (err.$retryable || TEMPORARY.has(err.name) || TEMPORARY.has(err.Code)) return true;
  if (/Maximum sending rate exceeded/i.test(err.message || '')) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(err.code);
}

/**
 * Sends one email. In simulation nothing leaves the server, but the message is
 * still fully built so formatting bugs show up before going live.
 */
export async function sendEmail({ settings, to, fromName, fromEmail, replyTo, subject, html, text, headers }) {
  if (!fromEmail) throw Object.assign(new Error('No sender address. Add a sender email in Settings.'), { permanent: true });
  const raw = buildRawMessage({
    from: formatAddress(fromName, fromEmail),
    to,
    replyTo,
    subject,
    html,
    text,
    headers: {
      ...headers,
      ...(env.aws.configurationSet ? { 'X-SES-CONFIGURATION-SET': env.aws.configurationSet } : {}),
    },
  });

  if (!isLive(settings)) {
    await new Promise((r) => setTimeout(r, 5));
    return { simulated: true, messageId: `sim-${crypto.randomBytes(8).toString('hex')}`, bytes: raw.length };
  }

  const result = await sesClient().send(
    new SendRawEmailCommand({
      RawMessage: { Data: raw },
      ...(env.aws.configurationSet ? { ConfigurationSetName: env.aws.configurationSet } : {}),
    })
  );
  return { simulated: false, messageId: result.MessageId, bytes: raw.length };
}

// ---------------------------------------------------------------------------
// Account and identities
// ---------------------------------------------------------------------------
let quotaCache = null;
let quotaAt = 0;

export async function getSendQuota(settings) {
  if (!isLive(settings)) return null;
  if (quotaCache && Date.now() - quotaAt < 60000) return quotaCache;
  try {
    const q = await sesClient().send(new GetSendQuotaCommand({}));
    quotaCache = { max24h: q.Max24HourSend, maxRate: q.MaxSendRate, sent24h: q.SentLast24Hours, sandbox: q.Max24HourSend <= 200 };
    quotaAt = Date.now();
    return quotaCache;
  } catch (err) {
    return { error: err.message };
  }
}

/** Starts SES DKIM for a domain and returns the 3 CNAME tokens. */
export async function startDomainVerification(domain, settings) {
  if (!isLive(settings)) return { simulated: true, tokens: [] };
  const res = await sesClient().send(new VerifyDomainDkimCommand({ Domain: domain }));
  return { simulated: false, tokens: res.DkimTokens || [] };
}

export async function getDomainStatus(domain, settings) {
  if (!isLive(settings)) return null;
  const [ver, dkim] = await Promise.all([
    sesClient().send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] })),
    sesClient().send(new GetIdentityDkimAttributesCommand({ Identities: [domain] })),
  ]);
  const v = ver.VerificationAttributes?.[domain];
  const d = dkim.DkimAttributes?.[domain];
  return {
    verification: v?.VerificationStatus || 'NotStarted',
    dkimStatus: d?.DkimVerificationStatus || 'NotStarted',
    dkimTokens: d?.DkimTokens || [],
  };
}

export async function verifySenderEmail(email, settings) {
  if (!isLive(settings)) return { simulated: true };
  await sesClient().send(new VerifyEmailIdentityCommand({ EmailAddress: email }));
  return { simulated: false };
}

export async function getIdentityStatuses(identities, settings) {
  if (!isLive(settings) || identities.length === 0) return {};
  const res = await sesClient().send(new GetIdentityVerificationAttributesCommand({ Identities: identities }));
  return Object.fromEntries(
    identities.map((id) => [id, res.VerificationAttributes?.[id]?.VerificationStatus || 'NotStarted'])
  );
}
