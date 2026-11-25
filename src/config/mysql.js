import mysql from 'mysql2/promise';
import { env } from './env.js';
import { runMigrations } from './migrator.js';

let pool = null;
let mysqlConnected = false;

export function isMysqlConnected() {
  return mysqlConnected;
}

export function getPool() {
  return pool;
}

export async function initMysql(seedData) {
  try {
    // Try creating database locally; ignore if Hostinger user lacks CREATE DATABASE privilege
    try {
      const bootstrapConn = await mysql.createConnection({
        host: env.db.host,
        port: env.db.port,
        user: env.db.user,
        password: env.db.password,
        connectTimeout: 4000,
      });
      await bootstrapConn.query(
        `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await bootstrapConn.end();
    } catch {
      // Expected on Hostinger shared hosting where DB is already created via hPanel
    }

    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    // Run versioned auto-migrations on every startup / redeploy
    await runMigrations(pool);

    // Seed workspace state if not present
    const [rows] = await pool.query('SELECT state_value FROM workspace_state WHERE state_key = ? LIMIT 1', ['main']);
    if (rows.length === 0 && seedData) {
      await pool.query('INSERT INTO workspace_state (state_key, state_value) VALUES (?, ?)', [
        'main',
        JSON.stringify(seedData),
      ]);
      mysqlConnected = true;
      console.log(`[mysql] Connected to ${env.db.database} and seeded initial data.`);
      return seedData;
    }

    mysqlConnected = true;
    console.log(`[mysql] Connected to ${env.db.database} (${env.db.host}:${env.db.port})`);
    if (rows.length > 0) {
      return JSON.parse(rows[0].state_value);
    }
    return null;
  } catch (err) {
    mysqlConnected = false;
    console.warn(`[mysql] Not connected (${err.message}). Using local JSON store until MySQL is configured.`);
    return null;
  }
}

export async function persistWorkspaceToMysql(data) {
  if (!mysqlConnected || !pool) return;
  try {
    await pool.query(
      'INSERT INTO workspace_state (state_key, state_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE state_value = VALUES(state_value)',
      ['main', JSON.stringify(data)]
    );
  } catch (err) {
    console.warn('[mysql] Failed to persist workspace state:', err.message);
  }
}

export async function findMysqlUserByUsername(username) {
  if (!mysqlConnected || !pool) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ? LIMIT 1', [username.toLowerCase()]);
  if (rows.length === 0) return null;
  const u = rows[0];
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.password_hash,
    name: u.name,
    email: u.email,
    role: u.role,
    initials: u.initials,
    teamName: u.team_name,
  };
}
