import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './config/env.js';
import { isDbReady, getDbError } from './config/db.js';
import { latestMigrationVersion } from './config/migrator.js';
import { workerState } from './services/worker.service.js';
import authRoutes from './routes/auth.routes.js';
import contactsRoutes from './routes/contacts.routes.js';
import groupsRoutes from './routes/groups.routes.js';
import segmentsRoutes from './routes/segments.routes.js';
import templatesRoutes from './routes/templates.routes.js';
import campaignsRoutes from './routes/campaigns.routes.js';
import automationsRoutes from './routes/automations.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import publicRoutes from './routes/public.routes.js';
import trackingRoutes from './routes/tracking.routes.js';
import webhookRoutes from './routes/webhooks.routes.js';
import { uploadsApi, uploadsPublic } from './routes/uploads.routes.js';

const app = express();

// Hostinger puts a proxy in front of the app; trust it for client IPs and rate limits.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

// Routes reached from emails and from AWS: no CORS, their own body parsing.
app.use('/t', trackingRoutes);
app.use('/uploads', uploadsPublic);
app.use('/api/webhooks', webhookRoutes);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin.replace(/\/$/, ''))) return cb(null, true);
      return cb(null, false); // browser blocks it; no 500 in our logs
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);

// Large enough for a 50,000-row CSV import.
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.get('/', (_req, res) => res.json({ success: true, service: 'bulkemail-backend' }));

app.get('/api/health', (_req, res) => {
  const ok = isDbReady();
  res.status(ok ? 200 : 503).json({
    success: ok,
    status: ok ? 'ok' : 'starting',
    database: ok ? 'connected' : 'not_connected',
    databaseError: ok ? undefined : getDbError(),
    schema: latestMigrationVersion(),
    worker: { running: workerState.running, lastTickAt: workerState.lastTickAt, holdReason: workerState.holdReason, lastError: workerState.lastError },
    environment: env.nodeEnv,
    uptime: Math.round(process.uptime()),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/segments', segmentsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/automations', automationsRoutes);
app.use('/api/uploads', uploadsApi);
app.use('/api', analyticsRoutes);
app.use('/api', settingsRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message;
  if (err.type === 'entity.parse.failed') message = 'The request body is not valid JSON.';
  if (err.type === 'entity.too.large') message = 'That is too much data for one request. Split the file into smaller parts.';
  if (err.code === 'LIMIT_FILE_SIZE') {
    status = 400;
    message = 'Images can be at most 5 MB.';
  }
  if (err.code === 'ER_DUP_ENTRY') {
    status = 409;
    message = 'That already exists.';
  }
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    success: false,
    message: status >= 500 && env.isProduction ? 'Something went wrong on the server. Try again.' : message,
  });
});

export default app;
