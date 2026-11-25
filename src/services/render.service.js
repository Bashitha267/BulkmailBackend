import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { escapeHtml } from '../lib/util.js';
import { defaultBlocks } from '../lib/defaults.js';

// ---------------------------------------------------------------------------
// Signed tokens for tracking and redirects
// ---------------------------------------------------------------------------
function sign(value) {
  return crypto.createHmac('sha256', env.jwtSecret).update(value).digest('base64url').slice(0, 16);
}

export function trackingToken(kind, id) {
  const base = `${kind}${id}`;
  return `${base}.${sign(base)}`;
}

/** Returns { kind: 'r'|'a', id } or null when the signature doesn't match. */
export function readTrackingToken(token) {
  const m = /^([ra])(\d+)\.([\w-]{16})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = sign(`${m[1]}${m[2]}`);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[3]))) return null;
  return { kind: m[1], id: Number(m[2]) };
}

export function signUrl(token, url) {
  return sign(`${token}|${url}`);
}

export function verifySignedUrl(token, url, sig) {
  const expected = signUrl(token, url);
  return typeof sig === 'string' && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function unsubscribeLinks(unsubToken) {
  if (!unsubToken) return { oneClick: '', page: '', preferences: '' };
  return {
    oneClick: `${env.publicBaseUrl}/api/public/unsubscribe/${unsubToken}`,
    page: `${env.appUrl}/unsubscribed?t=${unsubToken}`,
    preferences: `${env.appUrl}/preferences?t=${unsubToken}`,
  };
}

// ---------------------------------------------------------------------------
// Merge tags
// ---------------------------------------------------------------------------
export function contactVars(contact = {}, settings = {}) {
  const custom = contact.customFields || {};
  return {
    firstName: contact.firstName || String(contact.name || '').split(' ')[0] || '',
    lastName: contact.lastName || '',
    name: contact.name || '',
    email: contact.email || '',
    city: contact.city || '',
    plan: contact.plan || '',
    teamName: settings.general?.teamName || '',
    ...custom,
  };
}

const FALLBACKS = { firstName: 'there' };

/** Replaces {{tag}} and {{tag|fallback}}. HTML mode escapes values. */
export function interpolate(text, vars, { html = false } = {}) {
  return String(text ?? '').replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*))?\}\}/g, (_, key, fallback) => {
    let v = vars[key];
    if (v === undefined || v === null || v === '') v = fallback ?? FALLBACKS[key] ?? '';
    return html ? escapeHtml(v) : String(v);
  });
}

function htmlText(text, vars) {
  // Escape the author's text, then merge tags (escaped too), then line breaks.
  return interpolate(escapeHtml(text), vars, { html: true }).replace(/\n/g, '<br>');
}

function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(u)) return `https://${u}`;
  return '';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function renderBlock(b, vars, link) {
  switch (b.type) {
    case 'heading':
      return `<h1 style="margin:0 0 16px;font:700 24px/1.25 ${FONT};color:#111111;">${htmlText(b.text, vars)}</h1>`;
    case 'text':
      return `<p style="margin:0 0 16px;font:400 15px/1.6 ${FONT};color:#3f3f3f;">${htmlText(b.text, vars)}</p>`;
    case 'button': {
      const url = safeUrl(interpolate(b.url, vars));
      if (!url) return '';
      const radius = b.corners === 'square' ? 0 : b.corners === 'pill' ? 999 : 10;
      const color = /^#[0-9a-f]{3,8}$/i.test(b.color || '') ? b.color : '#111111';
      return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 20px;"><tr><td style="border-radius:${radius}px;background:${color};"><a href="${escapeHtml(link(url, b.label))}" style="display:inline-block;padding:12px 22px;font:600 14px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:${radius}px;">${htmlText(b.label, vars)}</a></td></tr></table>`;
    }
    case 'image': {
      const src = safeUrl(b.url);
      if (!src) return '';
      const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt || '')}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px;">`;
      const href = safeUrl(b.link);
      return `<div style="margin:0 0 16px;">${href ? `<a href="${escapeHtml(link(href, b.alt || 'Image'))}">${img}</a>` : img}</div>`;
    }
    case 'columns':
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px;"><tr><td valign="top" width="50%" style="padding-right:8px;font:400 14px/1.6 ${FONT};color:#3f3f3f;">${htmlText(b.left, vars)}</td><td valign="top" width="50%" style="padding-left:8px;font:400 14px/1.6 ${FONT};color:#3f3f3f;">${htmlText(b.right, vars)}</td></tr></table>`;
    case 'divider':
      return '<hr style="border:0;border-top:1px solid #e6e6e3;margin:20px 0;">';
    default:
      return '';
  }
}

function blockText(b, vars) {
  switch (b.type) {
    case 'heading':
    case 'text':
      return interpolate(b.text, vars);
    case 'button': {
      const url = safeUrl(interpolate(b.url, vars));
      return url ? `${interpolate(b.label, vars)}: ${url}` : '';
    }
    case 'columns':
      return `${interpolate(b.left, vars)}\n\n${interpolate(b.right, vars)}`;
    case 'image':
      return b.alt ? `[${b.alt}]` : '';
    case 'divider':
      return '---';
    default:
      return '';
  }
}

/** Lists the links a set of blocks contains, for link checks and reports. */
export function extractLinks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.type === 'button' && safeUrl(b.url)) out.push({ url: safeUrl(b.url), label: b.label || 'Button' });
    if (b.type === 'image' && safeUrl(b.link)) out.push({ url: safeUrl(b.link), label: b.alt || 'Image' });
  }
  return out;
}

/**
 * Builds subject, HTML and plain text for one recipient.
 * trackToken enables open pixel and click redirects; unsubToken adds the
 * personal unsubscribe and preference links.
 */
export function renderEmail({ blocks, subject, previewText, contact, settings, unsubToken, trackToken, isTest = false }) {
  const list = Array.isArray(blocks) && blocks.length ? blocks : defaultBlocks();
  const vars = contactVars(contact, settings);
  const compliance = settings?.compliance || {};
  const tracking = Boolean(trackToken);

  const link = (url, label) => {
    if (!tracking || !compliance.trackClicks || /^mailto:/i.test(url)) return url;
    const q = new URLSearchParams({ u: url, s: signUrl(trackToken, url) });
    if (label) q.set('l', String(label).slice(0, 80));
    return `${env.publicBaseUrl}/t/c/${trackToken}?${q}`;
  };

  const links = unsubscribeLinks(unsubToken);
  const address = compliance.address || '';
  const body = list.map((b) => renderBlock(b, vars, link)).join('\n');
  const finalSubject = interpolate(subject, vars);
  const preheader = interpolate(previewText || '', vars);

  const footerLinks = unsubToken
    ? `You’re getting this because you subscribed. <a href="${escapeHtml(links.page)}" style="color:#6b6b6b;">Unsubscribe</a>${
        compliance.preferencePage ? ` · <a href="${escapeHtml(links.preferences)}" style="color:#6b6b6b;">Email preferences</a>` : ''
      }`
    : isTest
      ? 'Test email. Real recipients get their personal unsubscribe link here.'
      : '';

  const pixel =
    tracking && compliance.trackOpens
      ? `<img src="${env.publicBaseUrl}/t/o/${trackToken}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">`
      : '';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(finalSubject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f2;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f2;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;"><tr><td style="padding:32px;">
${body}
<hr style="border:0;border-top:1px solid #ececea;margin:24px 0 16px;">
<p style="margin:0;font:400 12px/1.6 ${FONT};color:#8a8a8a;">${escapeHtml(address)}${address && footerLinks ? '<br>' : ''}${footerLinks}</p>
</td></tr></table>
</td></tr></table>
${pixel}
</body></html>`;

  const textParts = list.map((b) => blockText(b, vars)).filter(Boolean);
  textParts.push('---');
  if (address) textParts.push(address);
  if (unsubToken) textParts.push(`Unsubscribe: ${links.page}`);
  const text = textParts.join('\n\n');

  const headers = {};
  if (unsubToken) {
    headers['List-Unsubscribe'] = `<${links.oneClick}>`;
    if (compliance.oneClickUnsubscribe !== false) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return { subject: finalSubject, html, text, headers, previewText: preheader };
}
