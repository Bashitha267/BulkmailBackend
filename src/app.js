import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './config/env.js';
import authRoutes from './routes/auth.routes.js';
import contactsRoutes from './routes/contacts.routes.js';
import templatesRoutes from './routes/templates.routes.js';
import campaignsRoutes from './routes/campaigns.routes.js';
import uploadsRoutes, { UPLOADS_DIR } from './routes/uploads.routes.js';
import workspaceRoutes from './routes/workspace.routes.js';

const app = express();

// Trust Hostinger reverse proxy for accurate client IP & rate limiting
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    // Allow uploaded email images to be loaded from frontend & email clients
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));

// Serve uploaded email images publicly
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

app.get('/', (_req, res) => {
  res.json({
    success: true,
    service: 'bulkemail-backend',
    status: 'ok',
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    status: 'ok',
    environment: env.nodeEnv,
    uptime: Math.round(process.uptime()),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api', workspaceRoutes);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Centralized error handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message:
      env.nodeEnv === 'production' && status === 500
        ? 'Internal server error'
        : err.message || 'Internal server error',
  });
});

export default app;
