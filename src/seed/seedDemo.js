// `npm run seed:demo` loads sample contacts, campaigns and templates into an EMPTY database.
import { connectDatabase, closeDatabase, query } from '../config/db.js';
import { importWorkspaceSnapshot } from '../lib/importWorkspace.js';
import { DEMO_DATA } from './demoData.js';

try {
  await connectDatabase();
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM contacts');
  if (Number(n) > 0 && !process.argv.includes('--force')) {
    console.error(`[seed] The contacts table already has ${n} rows. Refusing to mix in demo data (use --force).`);
    process.exitCode = 1;
  } else {
    const pool = (await import('../config/db.js')).getPool();
    const counts = await importWorkspaceSnapshot(pool, DEMO_DATA);
    console.log('[seed] Demo data loaded:', counts);
  }
} catch (err) {
  console.error('[seed] Failed:', err.message);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
