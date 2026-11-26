import { config } from '../config/index.js';

const LEVELS = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const currentLevel = config.IS_PROD ? LEVELS.INFO : LEVELS.DEBUG;

function formatMessage(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  // Sanitize any accidental sensitive keys from meta
  const safeMeta = { ...meta };
  ['pin', 'token', 'secret', 'password', 'key', 'auth_token'].forEach(k => {
    if (k in safeMeta) safeMeta[k] = '[REDACTED]';
  });

  const metaStr = Object.keys(safeMeta).length > 0 ? ` ${JSON.stringify(safeMeta)}` : '';
  return `[${timestamp}] [${level}] ${message}${metaStr}`;
}

export const logger = {
  debug(msg, meta) {
    if (currentLevel <= LEVELS.DEBUG) console.log(formatMessage('DEBUG', msg, meta));
  },
  info(msg, meta) {
    if (currentLevel <= LEVELS.INFO) console.log(formatMessage('INFO', msg, meta));
  },
  warn(msg, meta) {
    if (currentLevel <= LEVELS.WARN) console.warn(formatMessage('WARN', msg, meta));
  },
  error(msg, meta) {
    if (currentLevel <= LEVELS.ERROR) console.error(formatMessage('ERROR', msg, meta));
  },
};
