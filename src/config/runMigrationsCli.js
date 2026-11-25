import { initMysql, getPool, isMysqlConnected } from './mysql.js';

await initMysql(null);

if (!isMysqlConnected()) {
  console.error('[migrate] Could not connect to MySQL. Check DB_HOST, DB_USER, DB_PASSWORD, DB_NAME in .env');
  process.exit(1);
}

const pool = getPool();
if (pool) {
  await pool.end();
}
process.exit(0);
