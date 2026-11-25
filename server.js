import app from './src/app.js';
import { env } from './src/config/env.js';
import { connectWithRetry, closeDatabase } from './src/config/db.js';
import { bootstrapAdmin, warnAboutDefaultPassword } from './src/services/users.service.js';
import { startWorker, stopWorker } from './src/services/worker.service.js';

// Bind the port first so Hostinger sees the app as up, then connect, migrate and start sending.
const server = app.listen(env.port, () => {
  console.log(`[bulkemail-backend] Listening on port ${env.port} (${env.nodeEnv})`);
  connectWithRetry({
    onReady: async () => {
      await bootstrapAdmin();
      await warnAboutDefaultPassword();
      startWorker();
    },
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bulkemail-backend] ${signal}: finishing the current batch and shutting down`);
  await stopWorker();
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
