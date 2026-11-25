import app from './src/app.js';
import { env } from './src/config/env.js';
import { hydrateFromMysql } from './src/data/store.js';
import { startEmailCron, stopEmailCron } from './src/services/queue.service.js';

await hydrateFromMysql();

const server = app.listen(env.port, () => {
  console.log(`[bulkemail-backend] Listening on port ${env.port} (${env.nodeEnv})`);
  startEmailCron();
});

function shutdown(signal) {
  console.log(`[bulkemail-backend] ${signal} received, shutting down gracefully...`);
  stopEmailCron();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
