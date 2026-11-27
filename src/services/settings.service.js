import { query, parseJson } from '../config/db.js';
import { env } from '../config/env.js';
import { DEFAULT_SETTINGS, SETTING_KEYS, WARMUP_SCHEDULE } from '../lib/defaults.js';
import { isValidEmail, normalizeEmail } from '../lib/util.js';

let cache = null;
let cacheAt = 0;
const TTL_MS = 3000;

function merge(key, stored) {
  const def = DEFAULT_SETTINGS[key];
  if (Array.isArray(def)) return Array.isArray(stored) ? stored : structuredClone(def);
  return { ...structuredClone(def), ...(stored && typeof stored === 'object' ? stored : {}) };
}

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < TTL_MS) return cache;
  const rows = await query('SELECT setting_key, value_json FROM app_settings');
  const stored = Object.fromEntries(rows.map((r) => [r.setting_key, parseJson(r.value_json, null)]));
  const out = {};
  for (const key of SETTING_KEYS) out[key] = merge(key, stored[key]);
  // Built-in fields can't be deleted.
  for (const f of DEFAULT_SETTINGS.fields) {
    if (!out.fields.some((x) => x.key === f.key)) out.fields.unshift(f);
  }
  // Auto-populate default sender/fromName from .env when configured.
  const envFromEmail = normalizeEmail(env.aws.fromEmail);
  if (envFromEmail && isValidEmail(envFromEmail)) {
    out.senders = Array.isArray(out.senders) ? out.senders.filter(Boolean) : [];
    if (!out.senders.some((s) => normalizeEmail(s.email) === envFromEmail)) {
      out.senders.unshift({
        email: envFromEmail,
        isDefault: !out.senders.some((s) => s.isDefault),
        fromEnv: true,
      });
    }
  }
  if (!out.general.fromName && env.aws.fromName) {
    out.general.fromName = env.aws.fromName;
  }
  cache = out;
  cacheAt = Date.now();
  return out;
}

export async function saveSetting(key, value) {
  if (!SETTING_KEYS.includes(key)) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
  await query(
    'INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)',
    [key, JSON.stringify(value)]
  );
  cache = null;
  return getSettings({ fresh: true });
}

export async function updateSetting(key, patch) {
  const current = (await getSettings({ fresh: true }))[key];
  const next = Array.isArray(current) ? patch : { ...current, ...patch };
  return saveSetting(key, next);
}

export function invalidateSettings() {
  cache = null;
}

/** Day number of the warm-up plan (1-based) and today's limit from it, or null when off. */
export function warmupState(ses, now = new Date()) {
  if (!ses?.warmup?.enabled || !ses.warmup.startedAt) return null;
  const started = new Date(ses.warmup.startedAt);
  const day = Math.floor((now - started) / 86400000) + 1;
  if (day > WARMUP_SCHEDULE.length) return { day, finished: true, limit: null, schedule: WARMUP_SCHEDULE };
  return { day: Math.max(1, day), finished: false, limit: WARMUP_SCHEDULE[Math.max(0, day - 1)], schedule: WARMUP_SCHEDULE };
}

export async function audit(actor, action) {
  await query('INSERT INTO audit_log (actor, action) VALUES (?, ?)', [String(actor || 'System').slice(0, 120), String(action).slice(0, 255)]);
}
