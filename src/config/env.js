import dotenv from 'dotenv';

dotenv.config();

const rawOrigins = process.env.CORS_ORIGIN || 'http://localhost:5173';
const corsOrigins = rawOrigins
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .flatMap((o) => (o === '*' || o.startsWith('http://') || o.startsWith('https://') ? [o] : [`https://${o}`, `http://${o}`]));

const rawBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${Number(process.env.PORT) || 5000}`).trim().replace(/\/$/, '');
const publicBaseUrl =
  rawBaseUrl.startsWith('http://') || rawBaseUrl.startsWith('https://') ? rawBaseUrl : `https://${rawBaseUrl}`;

export const env = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'bulkmailer-dev-secret-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins,
  publicBaseUrl,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bulk_mailer',
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    fromEmail: process.env.SES_FROM_EMAIL || 'news@acme.example.com',
    fromName: process.env.SES_FROM_NAME || 'Acme Team',
    simulationMode: String(process.env.SES_SIMULATION_MODE || 'true').toLowerCase() === 'true',
    batchSize: Math.max(1, Number(process.env.SES_BATCH_SIZE) || 10),
  },
};
