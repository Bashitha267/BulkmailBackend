import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { env } from './config/env.js';
import authRoutes from './routes/auth.routes.js';

const app = express();

// Trust Hostinger reverse proxy for accurate client IP & rate limiting
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet());
app.use(compression());

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / server-to-server / curl requests without Origin header
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

app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    status: 'ok',
    environment: env.nodeEnv,
    uptime: Math.round(process.uptime()),
  });
});

app.use('/api/auth', authRoutes);

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
    message: env.nodeEnv === 'production' && status === 500
      ? 'Internal server error'
      : err.message || 'Internal server error',
  });
});

export default app;
