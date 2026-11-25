import { migrations } from '../migrations/index.js';

const LOCK_NAME = 'bulkmailer_schema_migrations';

/**
 * Applies pending migrations in order. Runs automatically on every start/redeploy.
 *
 * - Applied versions are tracked in `schema_migrations`, so each runs once.
 * - A MySQL named lock stops two app instances from migrating at the same time.
 * - MySQL commits DDL implicitly, so every migration step is written to be
 *   safe to re-run if a deploy is interrupted halfway.
 */
export async function runMigrations(pool) {
  const conn = await pool.getConnection();
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 120) AS got', [LOCK_NAME]);
    if (!lock || Number(lock.got) !== 1) {
      throw new Error('Timed out waiting for the migration lock (another instance is migrating).');
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version VARCHAR(120) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    const [appliedRows] = await conn.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.version));
    const pending = migrations.filter((m) => !applied.has(m.version));

    for (const migration of pending) {
      const started = Date.now();
      console.log(`[migrate] Applying ${migration.version}: ${migration.name}`);
      await migration.up(conn);
      await conn.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
        migration.version,
        migration.name,
      ]);
      console.log(`[migrate] Done ${migration.version} in ${Date.now() - started} ms`);
    }

    if (pending.length === 0) console.log('[migrate] Database schema is up to date.');
    return pending.map((m) => m.version);
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    conn.release();
  }
}

export function latestMigrationVersion() {
  return migrations[migrations.length - 1]?.version || null;
}
