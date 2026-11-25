import { migrations } from '../migrations/index.js';

/**
 * Automatically runs any pending migrations in order on server startup.
 * Safe across Hostinger redeploys & restarts via `schema_migrations` tracking.
 */
export async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      version VARCHAR(120) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [appliedRows] = await pool.query('SELECT version FROM schema_migrations');
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  let appliedCount = 0;

  for (const migration of migrations) {
    if (appliedSet.has(migration.version)) {
      continue;
    }

    console.log(`[migrate] Applying ${migration.version}: ${migration.name}...`);
    await migration.up(pool);
    await pool.query(
      'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
      [migration.version, migration.name]
    );
    appliedCount += 1;
  }

  if (appliedCount > 0) {
    console.log(`[migrate] Applied ${appliedCount} new migration(s).`);
  } else {
    console.log('[migrate] Database schema is up to date.');
  }
}
