import app from './src/app.js';
import { env } from './src/config/env.js';

const server = app.listen(env.port, () => {
  console.log(`[bulkemail-backend] Listening on port ${env.port} (${env.nodeEnv})`);
});

function shutdown(signal) {
  console.log(`[bulkemail-backend] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
