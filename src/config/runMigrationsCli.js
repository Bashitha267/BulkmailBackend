// Manual entry point: `npm run migrate`. The server also runs this automatically on start.
import { connectDatabase, closeDatabase } from './db.js';

try {
  await connectDatabase();
  console.log('[migrate] Finished.');
  await closeDatabase();
  process.exit(0);
} catch (err) {
  console.error(`[migrate] Failed: ${err.message}`);
  console.error('Check DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in .env');
  await closeDatabase();
  process.exit(1);
}
