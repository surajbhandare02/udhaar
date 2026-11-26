import crypto from 'node:crypto';
import { config } from '../config/index.js';

export function createSessionToken() {
  const timestamp = Date.now();
  const sig = crypto.createHmac('sha256', config.SESSION_SECRET).update(`sess:${timestamp}`).digest('hex');
  return `${timestamp}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const tsStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return false;
  // 30 days validity
  if (Date.now() - ts > 30 * 24 * 60 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', config.SESSION_SECRET).update(`sess:${tsStr}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(c => {
    const parts = c.split('=');
    const key = parts.shift().trim();
    if (key) list[key] = decodeURIComponent(parts.join('=').trim());
  });
  return list;
}

export function isAuthenticated(req) {
  if (config.IS_TEST && !req.headers['x-force-auth-check']) return true;
  const cookies = parseCookies(req);
  return verifySessionToken(cookies.session);
}

export function isWebhookAuthorized(req, url) {
  if (config.IS_TEST && !req.headers['x-force-auth-check']) return true;
  if (isAuthenticated(req)) return true;

  if (!config.WEBHOOK_SECRET) return true;

  const key = req.headers['x-api-key'] ||
              url.searchParams.get('key') ||
              (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);

  return key === config.WEBHOOK_SECRET;
}
