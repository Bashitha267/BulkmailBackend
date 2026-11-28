import app from './src/app.js';
import { env } from './src/config/env.js';
import { connectWithRetry, closeDatabase } from './src/config/db.js';
import { bootstrapAdmin, warnAboutDefaultPassword } from './src/services/users.service.js';
import { startWorker, stopWorker } from './src/services/worker.service.js';
import { hasSesCredentials } from './src/services/ses.service.js';
import { env as appEnv } from './src/config/env.js';

// Bind the port first so Hostinger sees the app as up, then connect, migrate and start sending.
const server = app.listen(env.port, () => {
  console.log(`[bulkemail-backend] Listening on port ${env.port} (${env.nodeEnv})`);
  connectWithRetry({
    onReady: async () => {
      await bootstrapAdmin();
      await warnAboutDefaultPassword();
      startWorker();
      const why = !hasSesCredentials() ? 'no AWS credentials' : appEnv.aws.forceSimulation ? 'SES_SIMULATION_MODE=true' : 'depends on the Settings toggle';
      console.log(`[ses] region ${appEnv.aws.region}; sending: ${why}`);
      if (/localhost|127\.0\.0\.1/.test(appEnv.publicBaseUrl)) {
        console.warn('[env] PUBLIC_BASE_URL points at localhost: tracking and unsubscribe links in emails will not work for recipients.');
      }
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
