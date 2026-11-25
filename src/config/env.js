import dotenv from 'dotenv';

dotenv.config();

function withProtocol(value) {
  const v = String(value || '').trim().replace(/\/$/, '');
  if (!v) return '';
  return v.startsWith('http://') || v.startsWith('https://') ? v : `https://${v}`;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const port = Number(process.env.PORT) || 5000;
const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .flatMap((o) => (o === '*' || /^https?:\/\//.test(o) ? [o.replace(/\/$/, '')] : [`https://${o}`, `http://${o}`]));

const publicBaseUrl = withProtocol(process.env.PUBLIC_BASE_URL) || `http://localhost:${port}`;
// Where the React app lives. Unsubscribe/preference links in emails point here.
const appUrl =
  withProtocol(process.env.APP_URL) ||
  (corsOrigins.find((o) => o !== '*') ?? 'http://localhost:5173');

const DEV_JWT_SECRET = 'bulkmailer-dev-secret-change-in-production';
const jwtSecret = process.env.JWT_SECRET || DEV_JWT_SECRET;
if (isProduction && (jwtSecret === DEV_JWT_SECRET || jwtSecret.length < 32 || jwtSecret.startsWith('change-this'))) {
  console.error(
    '[env] JWT_SECRET is missing, a placeholder, or shorter than 32 characters. ' +
      'Set a long random JWT_SECRET in hPanel before running in production.'
  );
  process.exit(1);
}

export const env = {
  port,
  nodeEnv,
  isProduction,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins,
  publicBaseUrl,
  appUrl,
  uploadsDir: process.env.UPLOADS_DIR || '',
  seedDemoData: bool(process.env.SEED_DEMO_DATA, false),
  admin: {
    username: (process.env.ADMIN_USERNAME || '').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
    email: (process.env.ADMIN_EMAIL || '').trim(),
    resetPassword: bool(process.env.ADMIN_RESET_PASSWORD, false),
  },
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bulk_mailer',
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 8,
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    fromEmail: process.env.SES_FROM_EMAIL || '',
    fromName: process.env.SES_FROM_NAME || '',
    configurationSet: process.env.SES_CONFIGURATION_SET || '',
    snsTopicArns: (process.env.SES_SNS_TOPIC_ARNS || process.env.SES_SNS_TOPIC_ARN || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // true forces simulation regardless of the Settings toggle. Defaults to true
    // so nothing is really sent until you opt in.
    forceSimulation: bool(process.env.SES_SIMULATION_MODE, true),
  },
  worker: {
    enabled: bool(process.env.WORKER_ENABLED, true),
    tickMs: Math.max(250, Number(process.env.WORKER_TICK_MS) || 1000),
  },
};
