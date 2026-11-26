import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');

if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // .env is optional; environment variables are passed directly in production (e.g., Render)
  }
}

export const config = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_TEST: process.env.NODE_ENV === 'test',
  IS_PROD: process.env.NODE_ENV === 'production',

  APP_PIN: process.env.APP_PIN || '1234',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',

  SESSION_SECRET: process.env.SESSION_SECRET ||
    (process.env.APP_PIN ? `${process.env.APP_PIN}:${process.env.WEBHOOK_SECRET || 'udhaar-cloud'}` : 'udhaar-default-session-secret'),

  TURSO_DATABASE_URL: process.env.NODE_ENV === 'test' ? '' : (process.env.TURSO_DATABASE_URL || ''),
  TURSO_AUTH_TOKEN: process.env.NODE_ENV === 'test' ? '' : (process.env.TURSO_AUTH_TOKEN || ''),
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'udhaar.db'),

  // Performance settings
  CACHE_TTL_SUMMARY: 30, // seconds
  CACHE_TTL_ACCOUNTS: 60, // seconds
  RATE_LIMIT_LOGIN_MAX: 10, // attempts per minute
  RATE_LIMIT_API_MAX: 120, // requests per minute
};
