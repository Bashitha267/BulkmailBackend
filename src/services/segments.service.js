import { query, parseJson } from '../config/db.js';

/**
 * Segment rules -> SQL. Every value goes through a ? placeholder; only
 * whitelisted column names and operators are ever concatenated.
 *
 * Rule shape: { field, op, value }
 *   opened_any | clicked_any       op: in_last_days | not_in_last_days     value: days
 *   campaign                       op: received | opened | not_opened | clicked   value: campaignId
 *   group                          op: in | not_in                          value: groupId
 *   date_added                     op: in_last_days | before | after        value: days or YYYY-MM-DD
 *   city | plan                    op: is | is_not | contains | empty | not_empty
 *   custom:<key>                   same as city, plus before/after/in_last_days for dates
 *   status                         op: is | is_not                          value: Subscribed...
 */
const days = (v) => Math.max(1, Math.min(3650, parseInt(v, 10) || 30));

function textCondition(expr, op, value) {
  switch (op) {
    case 'is':
      return { sql: `LOWER(${expr}) = LOWER(?)`, params: [String(value ?? '')] };
    case 'is_not':
      return { sql: `LOWER(COALESCE(${expr}, '')) <> LOWER(?)`, params: [String(value ?? '')] };
    case 'contains':
      return { sql: `${expr} LIKE ?`, params: [`%${String(value ?? '').replace(/[%_\\]/g, '\\$&')}%`] };
    case 'empty':
      return { sql: `COALESCE(${expr}, '') = ''`, params: [] };
    case 'not_empty':
      return { sql: `COALESCE(${expr}, '') <> ''`, params: [] };
    case 'before':
      return { sql: `${expr} < ?`, params: [String(value)] };
    case 'after':
      return { sql: `${expr} > ?`, params: [String(value)] };
    case 'in_last_days':
      return { sql: `${expr} >= DATE_FORMAT(UTC_TIMESTAMP() - INTERVAL ? DAY, '%Y-%m-%d')`, params: [days(value)] };
    default:
      return null;
  }
}

export function compileRule(rule) {
  const { field = '', op, value } = rule || {};
  if (field === 'opened_any' || field === 'clicked_any') {
    const col = field === 'opened_any' ? 'opened_at' : 'clicked_at';
    const exists = `EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.contact_id = c.id AND r.${col} >= UTC_TIMESTAMP() - INTERVAL ? DAY)`;
    return { sql: op === 'not_in_last_days' ? `NOT ${exists}` : exists, params: [days(value)] };
  }
  if (field === 'campaign') {
    const base = 'SELECT 1 FROM campaign_recipients r WHERE r.contact_id = c.id AND r.campaign_id = ? AND r.sent_at IS NOT NULL';
    const map = {
      received: `EXISTS (${base})`,
      opened: `EXISTS (${base} AND r.opened_at IS NOT NULL)`,
      not_opened: `EXISTS (${base} AND r.opened_at IS NULL AND r.bounced_at IS NULL)`,
      clicked: `EXISTS (${base} AND r.clicked_at IS NOT NULL)`,
    };
    return map[op] ? { sql: map[op], params: [String(value)] } : null;
  }
  if (field === 'group') {
    const exists = 'EXISTS (SELECT 1 FROM contact_groups g WHERE g.contact_id = c.id AND g.group_id = ?)';
    return { sql: op === 'not_in' ? `NOT ${exists}` : exists, params: [String(value)] };
  }
  if (field === 'date_added') {
    if (op === 'in_last_days') return { sql: 'c.created_at >= UTC_TIMESTAMP() - INTERVAL ? DAY', params: [days(value)] };
    if (op === 'before') return { sql: 'c.created_at < ?', params: [String(value)] };
    if (op === 'after') return { sql: 'c.created_at > ?', params: [String(value)] };
    return null;
  }
  if (field === 'city' || field === 'plan') return textCondition(`c.${field}`, op, value);
  if (field === 'status') {
    return { sql: op === 'is_not' ? 'c.status <> ?' : 'c.status = ?', params: [String(value)] };
  }
  if (field.startsWith('custom:')) {
    const key = field.slice(7);
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) return null;
    return textCondition(`JSON_UNQUOTE(JSON_EXTRACT(c.custom_fields_json, '$.${key}'))`, op, value);
  }
  return null;
}

/** Combines rules into one WHERE fragment (alias c = contacts). */
export function compileSegment({ matchType = 'all', rules = [], onlyReceivable = true } = {}) {
  const parts = rules.map(compileRule).filter(Boolean);
  const params = [];
  let sql;
  if (parts.length === 0) {
    sql = '1 = 0'; // an empty segment matches nobody, never everybody
  } else {
    sql = `(${parts.map((p) => `(${p.sql})`).join(matchType === 'any' ? ' OR ' : ' AND ')})`;
    for (const p of parts) params.push(...p.params);
  }
  if (onlyReceivable) sql = `(${sql} AND c.status = 'Subscribed')`;
  return { sql, params };
}

export function serializeSegment(row) {
  return {
    id: row.id,
    name: row.name,
    matchType: row.match_type,
    rules: parseJson(row.rules_json, []) || [],
    onlyReceivable: Boolean(row.only_receivable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function countSegment(def, { sampleSize = 3 } = {}) {
  const { sql, params } = compileSegment(def);
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM contacts c WHERE ${sql}`, params);
  const sample = await query(`SELECT id, name, email FROM contacts c WHERE ${sql} ORDER BY c.last_activity_at DESC, c.created_at DESC LIMIT ?`, [
    ...params,
    sampleSize,
  ]);
  return { count: Number(n), sample };
}

export async function loadSegments(ids) {
  if (!ids?.length) return [];
  const rows = await query('SELECT * FROM segments WHERE id IN (?)', [ids]);
  return rows.map(serializeSegment);
}
