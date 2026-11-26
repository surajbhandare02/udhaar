import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { cache } from '../cache/memoryCache.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  createSessionToken,
  isAuthenticated,
  isWebhookAuthorized,
} from '../middleware/auth.js';
import { accountService } from '../services/accountService.js';
import { peopleService } from '../services/peopleService.js';
import { transactionService } from '../services/transactionService.js';
import { smsService } from '../services/smsService.js';
import { validateTransactionInput } from '../validators/transactionValidator.js';
import * as db from '../database/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// Cached static files in memory in production for instant sub-millisecond delivery
const staticCache = new Map();

function sendResponse(req, res, status, data, extraHeaders = {}) {
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
  const acceptEncoding = req.headers['accept-encoding'] || '';

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
    ...extraHeaders,
  };

  // Enable gzip compression on responses > 1KB
  if (jsonStr.length > 1024 && acceptEncoding.includes('gzip')) {
    zlib.gzip(Buffer.from(jsonStr), (err, compressed) => {
      if (err) {
        res.writeHead(status, headers);
        res.end(jsonStr);
      } else {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = compressed.length;
        res.writeHead(status, headers);
        res.end(compressed);
      }
    });
  } else {
    res.writeHead(status, headers);
    res.end(jsonStr);
  }
}

function sendError(req, res, status, message) {
  sendResponse(req, res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const safe = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, safe);

  // Security check: ensure path stays inside PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ct = MIME[path.extname(filePath)] || 'application/octet-stream';

  if (staticCache.has(filePath) && config.IS_PROD) {
    const { buffer, etag } = staticCache.get(filePath);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400',
      'ETag': etag,
    });
    res.end(buffer);
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const etag = `W/"${data.length}-${data.slice(0, 16).toString('hex')}"`;
    if (config.IS_PROD) {
      staticCache.set(filePath, { buffer: data, etag });
    }

    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=86400',
      'ETag': etag,
    });
    res.end(data);
  });
}

export async function handleRequest(req, res) {
  const startTime = performance.now();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  // 1. Health check — unauthenticated, < 1ms response
  if (pathname === '/health' && method === 'GET') {
    return sendResponse(req, res, 200, { ok: true, timestamp: Date.now() });
  }

  // 2. API Routes
  if (pathname.startsWith('/api/')) {
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        body = await readBody(req);
      } catch {
        return sendError(req, res, 400, 'Invalid JSON body');
      }
    }

    // --- Authentication Endpoints ---
    if (pathname === '/api/login' && method === 'POST') {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      if (rateLimiter.isRateLimited(`login:${clientIp}`, config.RATE_LIMIT_LOGIN_MAX, 60000)) {
        return sendError(req, res, 429, 'Too many login attempts. Please wait 1 minute.');
      }

      const { pin } = body;
      if (!pin) return sendError(req, res, 400, 'PIN is required');

      if (String(pin).trim() !== String(config.APP_PIN).trim()) {
        return sendError(req, res, 401, 'Incorrect PIN');
      }

      const token = createSessionToken();
      const isSecure = req.headers['x-forwarded-proto'] === 'https' || config.IS_PROD;
      const cookie = `session=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`;
      return sendResponse(req, res, 200, { ok: true, message: 'Authenticated' }, { 'Set-Cookie': cookie });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const isSecure = req.headers['x-forwarded-proto'] === 'https' || config.IS_PROD;
      const cookie = `session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`;
      return sendResponse(req, res, 200, { ok: true, message: 'Logged out' }, { 'Set-Cookie': cookie });
    }

    if (pathname === '/api/auth/status' && method === 'GET') {
      return sendResponse(req, res, 200, { authenticated: isAuthenticated(req) });
    }

    // --- Test Reset Endpoint ---
    if (pathname === '/api/test/reset' && method === 'POST') {
      if (!config.IS_TEST) return sendError(req, res, 403, 'Test only');
      cache.clear();
      await db.run('DELETE FROM transactions');
      await db.run('DELETE FROM people');
      await db.run('DELETE FROM accounts');
      try {
        await db.run("DELETE FROM sqlite_sequence WHERE name IN ('accounts','people','transactions')");
      } catch {}
      await db.run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['UPI / Bank']);
      await db.run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Cash']);
      await db.run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Savings']);
      const accounts = await accountService.getAll();
      return sendResponse(req, res, 200, { reset: true, accounts });
    }

    // --- Protected Webhook / Quick Endpoints (Token or Session) ---
    if (pathname === '/api/webhook/sms' && method === 'POST') {
      if (!isWebhookAuthorized(req, url)) return sendError(req, res, 401, 'Invalid or missing API key');
      const { message, account } = body;
      if (!message) return sendError(req, res, 400, 'message is required');
      const result = await smsService.processSingle(message, account);
      return sendResponse(req, res, result.status === 'created' ? 201 : 200, result);
    }

    if (pathname === '/api/webhook/batch' && method === 'POST') {
      if (!isWebhookAuthorized(req, url)) return sendError(req, res, 401, 'Invalid or missing API key');
      const result = await smsService.processBatch({
        raw_text: body.raw_text,
        messages: body.messages,
        targetAccount: body.account,
      });
      return sendResponse(req, res, 200, result);
    }

    if (pathname === '/api/quick' && method === 'POST') {
      if (!isWebhookAuthorized(req, url)) return sendError(req, res, 401, 'Invalid or missing API key');
      const { mode, amount: rawAmount, person, category = '', note = '', account } = body;
      if (!mode) return sendError(req, res, 400, 'mode is required ("cash_expense", "lent", "borrowed")');

      const amount = Number(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return sendError(req, res, 400, 'amount must be a positive number');
      }

      let accountId = null;
      if (account) {
        const a = typeof account === 'number'
          ? await accountService.getById(account)
          : await accountService.getByName(String(account).trim());
        if (a) accountId = a.id;
      }
      if (!accountId) {
        const cashAcc = await accountService.getByName('Cash');
        accountId = cashAcc ? cashAcc.id : 2;
      }

      let type;
      if (mode === 'cash_expense') {
        type = 'expense';
      } else if (mode === 'lent' || mode === 'borrowed') {
        type = mode;
        if (!person) return sendError(req, res, 400, 'person is required for lent/borrowed');
      } else {
        return sendError(req, res, 400, `Unknown mode "${mode}". Supported: cash_expense, lent, borrowed`);
      }

      const txCategory = category || (mode === 'cash_expense' ? 'Food' : '');
      const tx = await transactionService.create({
        type,
        amount,
        account_id: accountId,
        person_name: person || null,
        category: txCategory,
        note,
      });

      return sendResponse(req, res, 201, { success: true, mode, transaction: tx });
    }

    // --- Protected Dashboard Endpoints (Cookie Required) ---
    if (!isAuthenticated(req)) {
      return sendError(req, res, 401, 'Unauthorized — PIN login required');
    }

    if (pathname === '/api/summary' && method === 'GET') {
      const summary = await transactionService.getSummary();
      return sendResponse(req, res, 200, summary);
    }

    if (pathname === '/api/accounts' && method === 'GET') {
      return sendResponse(req, res, 200, await accountService.getAll());
    }

    if (pathname === '/api/accounts' && method === 'POST') {
      const { name, balance = 0 } = body;
      if (!name) return sendError(req, res, 400, 'name is required');
      const account = await accountService.create(name, balance);
      return sendResponse(req, res, 201, account);
    }

    const accIdMatch = pathname.match(/^\/api\/accounts\/(\d+)$/);
    if (accIdMatch && method === 'PUT') {
      const id = parseInt(accIdMatch[1], 10);
      const acc = await accountService.getById(id);
      if (!acc) return sendError(req, res, 404, 'Account not found');
      const balance = body.balance !== undefined ? body.balance : acc.balance;
      const updated = await accountService.updateBalance(id, balance);
      return sendResponse(req, res, 200, updated);
    }

    if (pathname === '/api/people' && method === 'GET') {
      return sendResponse(req, res, 200, await peopleService.getAll());
    }

    if (pathname === '/api/people' && method === 'POST') {
      const { name, phone } = body;
      if (!name) return sendError(req, res, 400, 'name is required');
      try {
        const person = await peopleService.create(name, phone);
        return sendResponse(req, res, 201, person);
      } catch (err) {
        if (err.message?.includes('UNIQUE')) return sendError(req, res, 409, 'Person already exists');
        return sendError(req, res, 500, err.message);
      }
    }

    const personTxMatch = pathname.match(/^\/api\/people\/(\d+)\/transactions$/);
    if (personTxMatch && method === 'GET') {
      const id = parseInt(personTxMatch[1], 10);
      const data = await peopleService.getTransactions(id);
      if (!data) return sendError(req, res, 404, 'Person not found');
      return sendResponse(req, res, 200, data);
    }

    if (pathname === '/api/transactions' && method === 'GET') {
      const sp = url.searchParams;
      const data = await transactionService.getFiltered({
        type: sp.get('type'),
        account_id: sp.get('account_id'),
        category: sp.get('category'),
        search: sp.get('search'),
        limit: parseInt(sp.get('limit') || '50', 10),
        offset: parseInt(sp.get('offset') || '0', 10),
      });
      return sendResponse(req, res, 200, data);
    }

    if (pathname === '/api/transactions' && method === 'POST') {
      const validation = validateTransactionInput(body);
      if (!validation.valid) {
        return sendError(req, res, 400, validation.error);
      }
      const tx = await transactionService.create(body);
      return sendResponse(req, res, 201, tx);
    }

    const txIdMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
    if (txIdMatch && method === 'PUT') {
      const id = parseInt(txIdMatch[1], 10);
      if (body.amount !== undefined) {
        const amt = Number(body.amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return sendError(req, res, 400, 'amount must be a positive number');
        }
      }
      const updated = await transactionService.update(id, body);
      if (!updated) return sendError(req, res, 404, 'Transaction not found');
      return sendResponse(req, res, 200, updated);
    }

    if (txIdMatch && method === 'DELETE') {
      const id = parseInt(txIdMatch[1], 10);
      const success = await transactionService.delete(id);
      if (!success) return sendError(req, res, 404, 'Transaction not found');
      return sendResponse(req, res, 200, { success: true });
    }

    if (pathname === '/api/export/csv' && method === 'GET') {
      const rows = await db.all(`
        SELECT t.id, t.type, t.amount,
               a.name  AS account,
               ta.name AS to_account,
               p.name  AS person,
               t.category, t.merchant, t.note, t.utr_ref, t.created_at
        FROM transactions t
        LEFT JOIN accounts a  ON t.account_id    = a.id
        LEFT JOIN accounts ta ON t.to_account_id = ta.id
        LEFT JOIN people   p  ON t.person_id     = p.id
        ORDER BY t.created_at DESC
      `);

      const headers = ['id','type','amount','account','to_account','person',
                       'category','merchant','note','utr_ref','created_at'];
      const esc = v => {
        if (v == null) return '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [
        headers.join(','),
        ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
      ].join('\n');

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="udhaar-export.csv"',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(csv);
    }

    return sendError(req, res, 404, 'API endpoint not found');
  }

  // 3. Static Files
  serveStatic(req, res, pathname);

  logger.debug(`${method} ${pathname} completed in ${(performance.now() - startTime).toFixed(2)}ms`);
}
