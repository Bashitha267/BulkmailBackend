import crypto from 'node:crypto';

export function slugify(text, max = 60) {
  return (
    String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'item'
  );
}

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Readable unique id: "december-newsletter-k3f9a2". */
export function newId(label, max = 80) {
  return `${slugify(label, max - 7)}-${randomHex(3)}`;
}

export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

export function initialsOf(name, email = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  const base = parts[0] || String(email).split('@')[0] || '?';
  return base.slice(0, 2).toUpperCase();
}

// Pragmatic check: one @, a dot in the domain, no spaces. Real validation is SES bouncing.
const EMAIL_RE = /^[^\s@"<>(),;:]+@[^\s@"<>(),;:]+\.[a-z]{2,}$/i;
export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 190 && EMAIL_RE.test(email.trim());
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${user.slice(0, 1)}***@${domain}`;
}

export function toInt(value, fallback = 0) {
  const n = parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Converts a wall-clock date and time in an IANA zone to a UTC Date.
 * e.g. ('2026-12-01', '09:00', 'Asia/Colombo') -> 2026-12-01T03:30:00Z
 */
export function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  if (!y || !mo || !d || Number.isNaN(h) || Number.isNaN(mi)) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (ts) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ts));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ts;
  };
  let ts = guess - offset(guess);
  ts = guess - offset(ts); // second pass handles DST edges
  return new Date(ts);
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
