import mysql from 'mysql2/promise';
import { env } from './env.js';
import { runMigrations } from './migrator.js';

let pool = null;
let ready = false;
let lastError = null;
let connecting = null;

export function isDbReady() {
  return ready;
}

export function getDbError() {
  return lastError;
}

export function getPool() {
  if (!pool) throw Object.assign(new Error('Database is not connected yet.'), { status: 503 });
  return pool;
}

export async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** Runs fn(conn) inside a transaction. conn.query has the same signature as pool.query. */
export async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** MySQL returns JSON columns parsed; MariaDB returns strings. Accept both. */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function toJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function createPool() {
  const p = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    waitForConnections: true,
    connectionLimit: env.db.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    enableKeepAlive: true,
    connectTimeout: 10000,
  });
  // Every connection works in UTC so NOW() and stored DATETIMEs agree with JS Dates.
  p.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return p;
}

async function tryCreateDatabase() {
  // Works locally; on Hostinger the DB already exists and the user can't create one.
  try {
    const conn = await mysql.createConnection({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      connectTimeout: 4000,
    });
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conn.end();
  } catch {
    /* expected on shared hosting */
  }
}

/**
 * Connects, applies pending migrations, and marks the DB ready.
 * Throws on failure; see connectWithRetry for the startup loop.
 */
export async function connectDatabase({ migrate = true } = {}) {
  await tryCreateDatabase();
  if (!pool) pool = createPool();
  await pool.query('SELECT 1');
  if (migrate) await runMigrations(pool);
  ready = true;
  lastError = null;
  return pool;
}

/** Keeps retrying in the background so a slow or briefly unavailable DB doesn't kill the app. */
export function connectWithRetry({ onReady, retryMs = 15000 } = {}) {
  if (connecting) return connecting;
  connecting = (async () => {
    for (;;) {
      try {
        await connectDatabase();
        console.log(`[db] Connected to ${env.db.database} on ${env.db.host}:${env.db.port}`);
        if (onReady) await onReady();
        return;
      } catch (err) {
        ready = false;
        lastError = err.message;
        console.error(`[db] Not ready: ${err.message}. Retrying in ${retryMs / 1000}s`);
        if (pool) {
          await pool.end().catch(() => {});
          pool = null;
        }
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }
  })();
  return connecting;
}

export async function closeDatabase() {
  ready = false;
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}
