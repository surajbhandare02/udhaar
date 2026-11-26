import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT    = process.env.PORT    || 3000;
const IS_TEST = process.env.NODE_ENV === 'test';
const APP_PIN = process.env.APP_PIN || '1234';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Derived secret for cookie session signing so sessions survive cloud container restarts
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`${APP_PIN}:${WEBHOOK_SECRET || 'udhaar-cloud-key'}`).digest('hex');

// ─── Initialize Database ──────────────────────────────────────────────────────
await db.initDB();

// ─── Session & Security Helpers ───────────────────────────────────────────────

function createSessionToken() {
  const timestamp = Date.now();
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`sess:${timestamp}`).digest('hex');
  return `${timestamp}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const tsStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return false;
  // Valid for 30 days
  if (Date.now() - ts > 30 * 24 * 60 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`sess:${tsStr}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function parseCookies(req) {
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

function isAuthenticated(req) {
  if (IS_TEST && !req.headers['x-force-auth-check']) return true;
  const cookies = parseCookies(req);
  return verifySessionToken(cookies.session);
}

function isWebhookAuthorized(req, url) {
  if (IS_TEST && !req.headers['x-force-auth-check']) return true;
  // Allow if user is logged into dashboard
  if (isAuthenticated(req)) return true;

  if (!WEBHOOK_SECRET) return true; // No secret configured: open

  const key = req.headers['x-api-key'] ||
              url.searchParams.get('key') ||
              (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);

  return key === WEBHOOK_SECRET;
}

// ─── Atomic Balance Deltas ────────────────────────────────────────────────────

async function applyBalanceDeltas(dbHandle, tx, multiplier) {
  const { type, amount, account_id, to_account_id, person_id } = tx;
  const m = multiplier;

  switch (type) {
    case 'expense':
      await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount * m, account_id]);
      break;

    case 'income':
      await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount * m, account_id]);
      break;

    case 'transfer':
      await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount * m, account_id]);
      await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount * m, to_account_id]);
      break;

    case 'lent':
      await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount * m, account_id]);
      if (person_id) {
        await dbHandle.run('UPDATE people SET net_balance = net_balance + ? WHERE id = ?', [amount * m, person_id]);
      }
      break;

    case 'borrowed':
      await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount * m, account_id]);
      if (person_id) {
        await dbHandle.run('UPDATE people SET net_balance = net_balance - ? WHERE id = ?', [amount * m, person_id]);
      }
      break;

    case 'settle_in':
      await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount * m, account_id]);
      if (person_id) {
        await dbHandle.run('UPDATE people SET net_balance = net_balance - ? WHERE id = ?', [amount * m, person_id]);
      }
      break;

    case 'settle_out':
      await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount * m, account_id]);
      if (person_id) {
        await dbHandle.run('UPDATE people SET net_balance = net_balance + ? WHERE id = ?', [amount * m, person_id]);
      }
      break;
  }
}

// ─── SMS Parsing ──────────────────────────────────────────────────────────────

const CATEGORY_MAP = [
  [/zomato|swiggy|food|restaurant|cafe|burger|pizza|eat/i,                       'Food'],
  [/uber|ola|rapido|metro|bus|train|irctc|flight|makemytrip/i,                   'Travel'],
  [/amazon|flipkart|myntra|meesho|ajio|shopping|mart/i,                          'Shopping'],
  [/electricity|water|gas|airtel|jio|\bvi\b|bsnl|broadband|internet|recharge/i,  'Bills'],
  [/netflix|spotify|prime|hotstar|zee5|youtube/i,                                'Entertainment'],
  [/hospital|pharmacy|medical|apollo|1mg|netmedi/i,                              'Health'],
  [/rent|maintenance|society/i,                                                  'Rent'],
  [/salary|payroll/i,                                                            'Salary'],
];

function guessCategory(merchant = '', text = '') {
  const combined = `${merchant} ${text}`.toLowerCase();
  for (const [pat, cat] of CATEGORY_MAP) {
    if (pat.test(combined)) return cat;
  }
  return 'Other';
}

function isIgnoredSMS(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 15) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  // 1. OTP / PIN messages
  if (
    /\b(?:OTP|one[\s-]time\s+(?:password|pin)|verification\s+code)\b/i.test(text) ||
    /\bis your OTP\b/i.test(text) ||
    /\buse\s+(?:code|otp)\b/i.test(text)
  ) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  // 2. Failed / declined payment alerts
  if (/\b(?:payment\s+failed|transaction\s+failed|declined|unsuccessful|rejected|reversed|timed?\s*out)\b/i.test(text)) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  // 3. Balance-only notifications
  const hasDebit  = /\b(?:debited|sent|spent|paid|withdrawn)\b/i.test(text);
  const hasCredit = /\b(?:credited|received|deposited|refund)\b/i.test(text);
  if (!hasDebit && !hasCredit) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  return { ignored: false };
}

function parseSMS(text) {
  if (!text || text.length < 15) return null;

  if (
    /\b(?:OTP|one[\s-]time\s+(?:password|pin)|verification\s+code)\b/i.test(text) &&
    !/\b(?:debited|credited)\b/i.test(text)
  ) return null;

  if (/\b(?:payment\s+failed|transaction\s+failed|declined|unsuccessful|rejected|reversed|timed?\s*out)\b/i.test(text)) {
    return null;
  }

  // 1. Amount
  const amtM = text.match(/(?:Rs\.?\s*|INR\s*)([\d,]+(?:\.\d{1,2})?)/i);
  if (!amtM) return null;
  const amount = parseFloat(amtM[1].replace(/,/g, ''));
  if (!isFinite(amount) || amount <= 0) return null;

  // 2. Direction
  const hasDebit  = /\b(?:debited|sent|spent|paid|withdrawn)\b/i.test(text);
  const hasCredit = /\b(?:credited|received|deposited|refund)\b/i.test(text);
  if (!hasDebit && !hasCredit) return null;
  const type = hasDebit ? 'expense' : 'income';

  // 3. UTR / Ref (10–12 digits)
  const refM = text.match(
    /(?:UPI\s*Ref\s*(?:No\.?\s*)?|Ref\s*(?:No\.?\s*)?|UPI:|Ref#\s*)(\d{10,12})/i
  );
  const utr_ref = refM ? refM[1] : null;

  // 4. Merchant
  let merchant = '';
  const vpaM = text.match(
    /(?:VPA|to\s+VPA|UPI\s+ID|to\s+UPI)\s+([\w.\-@]+@[\w.\-]+)/i
  );
  if (vpaM) {
    merchant = vpaM[1];
  } else {
    const toM = text.match(
      /\bto\s+([A-Z][A-Z0-9\s&.\-]{2,30}?)(?:\s+on\b|\s+via\b|\s*[.,;]|\s*\d)/i
    );
    if (toM) merchant = toM[1].trim();
  }

  return { amount, type, merchant, utr_ref, category: guessCategory(merchant, text) };
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

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

function send(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

async function getOrCreatePerson(dbHandle, name, phone) {
  if (!name) return null;
  let p = await dbHandle.get('SELECT * FROM people WHERE name = ? COLLATE NOCASE', [name]);
  if (!p) {
    const r = await dbHandle.run(
      'INSERT INTO people (name, phone, net_balance) VALUES (?, ?, 0)',
      [name, phone || null]
    );
    p = await dbHandle.get('SELECT * FROM people WHERE id = ?', [r.lastInsertRowid]);
  }
  return p;
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

async function handleSummary(req, res) {
  try {
    const accounts = await db.all('SELECT * FROM accounts ORDER BY id');
    const monthly  = await db.get(`
      SELECT
        SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
        SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income
      FROM transactions
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `);
    const recv = await db.get(
      "SELECT COALESCE(SUM(net_balance), 0) AS total FROM people WHERE net_balance > 0"
    );

    send(res, 200, {
      accounts,
      monthly: { expense: monthly?.expense || 0, income: monthly?.income || 0 },
      people_receivables: recv?.total || 0,
    });
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleGetAccounts(req, res) {
  try {
    send(res, 200, await db.all('SELECT * FROM accounts ORDER BY id'));
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleCreateAccount(req, res, body) {
  try {
    const { name, balance = 0 } = body;
    if (!name) return sendError(res, 400, 'name is required');
    const r = await db.run('INSERT INTO accounts (name, balance) VALUES (?, ?)', [name, balance]);
    send(res, 201, await db.get('SELECT * FROM accounts WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleUpdateAccount(req, res, id, body) {
  try {
    const acc = await db.get('SELECT * FROM accounts WHERE id = ?', [id]);
    if (!acc) return sendError(res, 404, 'Account not found');
    const balance = body.balance !== undefined ? body.balance : acc.balance;
    await db.run('UPDATE accounts SET balance = ? WHERE id = ?', [balance, id]);
    send(res, 200, await db.get('SELECT * FROM accounts WHERE id = ?', [id]));
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleGetPeople(req, res) {
  try {
    send(res, 200, await db.all('SELECT * FROM people ORDER BY ABS(net_balance) DESC'));
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleCreatePerson(req, res, body) {
  try {
    const { name, phone } = body;
    if (!name) return sendError(res, 400, 'name is required');
    const r = await db.run(
      'INSERT INTO people (name, phone, net_balance) VALUES (?, ?, 0)',
      [name, phone || null]
    );
    send(res, 201, await db.get('SELECT * FROM people WHERE id = ?', [r.lastInsertRowid]));
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return sendError(res, 409, 'Person already exists');
    sendError(res, 500, err.message);
  }
}

async function handlePersonTransactions(req, res, personId) {
  try {
    const person = await db.get('SELECT * FROM people WHERE id = ?', [personId]);
    if (!person) return sendError(res, 404, 'Person not found');
    const txs = await db.all(`
      SELECT t.*, a.name AS account_name, p.name AS person_name
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN people   p ON t.person_id  = p.id
      WHERE t.person_id = ?
      ORDER BY t.created_at DESC
    `, [personId]);
    send(res, 200, { person, transactions: txs });
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleGetTransactions(req, res, url) {
  try {
    const sp         = url.searchParams;
    const type       = sp.get('type');
    const account_id = sp.get('account_id');
    const category   = sp.get('category');
    const search     = sp.get('search');
    const limit      = parseInt(sp.get('limit')  || '50', 10);
    const offset     = parseInt(sp.get('offset') || '0',  10);

    const conds = [], args = [];
    if (type)       { conds.push('t.type = ?');  args.push(type); }
    if (account_id) { conds.push('(t.account_id = ? OR t.to_account_id = ?)'); args.push(account_id, account_id); }
    if (category)   { conds.push('t.category = ?'); args.push(category); }
    if (search)     {
      conds.push('(t.merchant LIKE ? OR t.note LIKE ? OR t.category LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await db.all(`
      SELECT t.*,
             a.name  AS account_name,
             ta.name AS to_account_name,
             p.name  AS person_name
      FROM transactions t
      LEFT JOIN accounts a  ON t.account_id    = a.id
      LEFT JOIN accounts ta ON t.to_account_id = ta.id
      LEFT JOIN people   p  ON t.person_id     = p.id
      ${where}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?
    `, [...args, limit, offset]);

    const countRow = await db.get(`SELECT COUNT(*) AS c FROM transactions t ${where}`, args);
    send(res, 200, { transactions: rows, total: countRow?.c || 0, limit, offset });
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleCreateTransaction(req, res, body) {
  try {
    const {
      type,
      amount: rawAmount,
      account_id,
      to_account_id = null,
      person_id     = null,
      person_name   = null,
      phone         = null,
      category      = '',
      merchant      = '',
      note          = '',
      utr_ref       = null,
      created_at    = null,
    } = body;

    if (!type) return sendError(res, 400, 'type is required');

    const amount = Number(rawAmount);
    if (!isFinite(amount) || amount <= 0)
      return sendError(res, 400, 'amount must be a positive number');

    if (type === 'transfer') {
      if (!to_account_id)
        return sendError(res, 400, 'to_account_id is required for transfers');
      if (Number(account_id) === Number(to_account_id))
        return sendError(res, 400, 'transfer source and destination accounts must differ');
    }
    if (type === 'lent' || type === 'borrowed') {
      if (!person_id && !person_name)
        return sendError(res, 400, 'person_name or person_id is required for lent/borrowed');
    }

    const tx = await db.withTransaction(async (txRunner) => {
      let resolvedPersonId = person_id;
      if (!resolvedPersonId && person_name) {
        const p = await getOrCreatePerson(txRunner, person_name, phone);
        resolvedPersonId = p ? p.id : null;
      }

      const params = {
        type, amount,
        account_id:    account_id    ? Number(account_id)    : null,
        to_account_id: to_account_id ? Number(to_account_id) : null,
        person_id:     resolvedPersonId,
      };

      await applyBalanceDeltas(txRunner, params, 1);
      const r = created_at
        ? await txRunner.run(`
            INSERT INTO transactions
              (type, amount, account_id, to_account_id, person_id, category, merchant, note, utr_ref, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [type, amount, params.account_id, params.to_account_id, params.person_id,
              category, merchant, note, utr_ref || null, created_at])
        : await txRunner.run(`
            INSERT INTO transactions
              (type, amount, account_id, to_account_id, person_id, category, merchant, note, utr_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [type, amount, params.account_id, params.to_account_id, params.person_id,
              category, merchant, note, utr_ref || null]);

      return txRunner.get('SELECT * FROM transactions WHERE id = ?', [r.lastInsertRowid]);
    });

    send(res, 201, tx);
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleUpdateTransaction(req, res, id, body) {
  try {
    const old = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
    if (!old) return sendError(res, 404, 'Transaction not found');

    const {
      type       = old.type,
      amount: rawAmount = old.amount,
      account_id    = old.account_id,
      to_account_id = old.to_account_id,
      person_id     = old.person_id,
      person_name   = null,
      phone         = null,
      category   = old.category,
      merchant   = old.merchant,
      note       = old.note,
      utr_ref    = old.utr_ref,
      created_at = old.created_at,
    } = body;

    const amount = Number(rawAmount);
    if (!isFinite(amount) || amount <= 0)
      return sendError(res, 400, 'amount must be a positive number');

    const updated = await db.withTransaction(async (txRunner) => {
      let resolvedPersonId = person_id;
      if (!resolvedPersonId && person_name) {
        const p = await getOrCreatePerson(txRunner, person_name, phone);
        resolvedPersonId = p ? p.id : null;
      }

      const newDelta = { type, amount, account_id, to_account_id, person_id: resolvedPersonId };

      await applyBalanceDeltas(txRunner, old, -1);
      await applyBalanceDeltas(txRunner, newDelta, 1);
      await txRunner.run(`
        UPDATE transactions
        SET type=?, amount=?, account_id=?, to_account_id=?, person_id=?,
            category=?, merchant=?, note=?, utr_ref=?, created_at=?
        WHERE id=?
      `, [type, amount, account_id || null, to_account_id || null, resolvedPersonId,
          category, merchant, note, utr_ref || null, created_at, id]);

      return txRunner.get('SELECT * FROM transactions WHERE id = ?', [id]);
    });

    send(res, 200, updated);
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleDeleteTransaction(req, res, id) {
  try {
    const tx = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
    if (!tx) return sendError(res, 404, 'Transaction not found');

    await db.withTransaction(async (txRunner) => {
      await applyBalanceDeltas(txRunner, tx, -1);
      await txRunner.run('DELETE FROM transactions WHERE id = ?', [id]);
    });

    send(res, 200, { success: true });
  } catch (err) { sendError(res, 500, err.message); }
}

// ─── SMS Webhook Handlers ─────────────────────────────────────────────────────

async function processSingleSMS(message, targetAccount = null) {
  const ignoreCheck = isIgnoredSMS(message);
  if (ignoreCheck.ignored) {
    return { status: 'ignored', reason: ignoreCheck.reason, unrecognized: true };
  }

  const parsed = parseSMS(message);
  if (!parsed) {
    return { status: 'ignored', reason: 'otp_or_non_tx', unrecognized: true };
  }

  const { amount, type, merchant, utr_ref, category } = parsed;

  let accountId = 1;
  if (targetAccount) {
    if (typeof targetAccount === 'number') {
      const a = await db.get('SELECT id FROM accounts WHERE id = ?', [targetAccount]);
      if (a) accountId = a.id;
    } else if (typeof targetAccount === 'string') {
      const a = await db.get('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE', [targetAccount.trim()]);
      if (a) accountId = a.id;
    }
  }

  if (utr_ref) {
    const hit = await db.get('SELECT id FROM transactions WHERE utr_ref = ?', [utr_ref]);
    if (hit) return { status: 'duplicate', duplicate: true, utr_ref };
  }

  const fuzzy = await db.get(`
    SELECT id FROM transactions
    WHERE amount = ? AND type = ? AND account_id = ?
      AND created_at >= datetime('now', '-3 minutes')
  `, [amount, type, accountId]);
  if (fuzzy) return { status: 'duplicate', duplicate: true };

  const params = { type, amount, account_id: accountId, to_account_id: null, person_id: null };
  const tx = await db.withTransaction(async (txRunner) => {
    await applyBalanceDeltas(txRunner, params, 1);
    const r = await txRunner.run(`
      INSERT INTO transactions (type, amount, account_id, category, merchant, utr_ref)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [type, amount, accountId, category, merchant, utr_ref || null]);
    return txRunner.get('SELECT * FROM transactions WHERE id = ?', [r.lastInsertRowid]);
  });

  return { status: 'created', transaction: tx };
}

async function handleSMSWebhook(req, res, body) {
  try {
    const { message, account } = body;
    if (!message) return sendError(res, 400, 'message is required');
    const result = await processSingleSMS(message, account);
    send(res, result.status === 'created' ? 201 : 200, result);
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleBatchSMS(req, res, body) {
  try {
    let messages = [];
    if (typeof body.raw_text === 'string') {
      messages = body.raw_text
        .split(/(?:\r?\n\s*[-—]{3,}\s*\r?\n|\r?\n\s*\r?\n+)/g)
        .map(s => s.trim())
        .filter(Boolean);
      if (messages.length <= 1 && body.raw_text.includes('\n')) {
        const lines = body.raw_text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (lines.length > 1 && lines.every(l => /(?:rs\.?|inr|debited|credited|paid|sent)/i.test(l))) {
          messages = lines;
        }
      }
    } else if (Array.isArray(body.messages)) {
      messages = body.messages.map(s => String(s).trim()).filter(Boolean);
    } else {
      return sendError(res, 400, 'raw_text or messages array is required');
    }

    const defaultAcc = body.account || 1;
    let accountId = 1;
    if (typeof defaultAcc === 'number') {
      const a = await db.get('SELECT id FROM accounts WHERE id = ?', [defaultAcc]);
      if (a) accountId = a.id;
    } else if (typeof defaultAcc === 'string') {
      const a = await db.get('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE', [defaultAcc.trim()]);
      if (a) accountId = a.id;
    }

    const outcome = await db.withTransaction(async (txRunner) => {
      const summary = { imported: 0, duplicates: 0, ignored: 0 };
      const results = [];
      const seenUtrs = new Set();

      for (const msg of messages) {
        try {
          const ignoreCheck = isIgnoredSMS(msg);
          if (ignoreCheck.ignored) {
            summary.ignored++;
            results.push({ message: String(msg).slice(0, 70), status: 'ignored', reason: ignoreCheck.reason });
            continue;
          }

          const parsed = parseSMS(msg);
          if (!parsed) {
            summary.ignored++;
            results.push({ message: String(msg).slice(0, 70), status: 'ignored', reason: 'otp_or_non_tx' });
            continue;
          }

          const { amount, type, merchant, utr_ref, category } = parsed;

          if (utr_ref) {
            if (seenUtrs.has(utr_ref)) {
              summary.duplicates++;
              results.push({ message: String(msg).slice(0, 70), status: 'duplicate', duplicate: true, utr_ref });
              continue;
            }
            const hit = await txRunner.get('SELECT id FROM transactions WHERE utr_ref = ?', [utr_ref]);
            if (hit) {
              summary.duplicates++;
              results.push({ message: String(msg).slice(0, 70), status: 'duplicate', duplicate: true, utr_ref });
              continue;
            }
          }

          const fuzzy = await txRunner.get(`
            SELECT id FROM transactions
            WHERE amount = ? AND type = ? AND account_id = ?
              AND created_at >= datetime('now', '-3 minutes')
          `, [amount, type, accountId]);
          if (fuzzy) {
            summary.duplicates++;
            results.push({ message: String(msg).slice(0, 70), status: 'duplicate', duplicate: true });
            continue;
          }

          const params = { type, amount, account_id: accountId, to_account_id: null, person_id: null };
          await applyBalanceDeltas(txRunner, params, 1);
          const r = await txRunner.run(`
            INSERT INTO transactions (type, amount, account_id, category, merchant, utr_ref)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [type, amount, accountId, category, merchant, utr_ref || null]);

          if (utr_ref) seenUtrs.add(utr_ref);
          summary.imported++;
          results.push({ message: String(msg).slice(0, 70), status: 'created', id: r.lastInsertRowid });
        } catch (e) {
          summary.ignored++;
          results.push({ status: 'error', error: e.message });
        }
      }

      return {
        imported: summary.imported,
        duplicates: summary.duplicates,
        ignored: summary.ignored,
        summary,
        results,
      };
    });

    send(res, 200, outcome);
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleQuick(req, res, body) {
  try {
    const { mode, amount: rawAmount, person, category = '', note = '', account } = body;
    if (!mode) return sendError(res, 400, 'mode is required ("cash_expense", "lent", "borrowed")');

    const amount = Number(rawAmount);
    if (!isFinite(amount) || amount <= 0)
      return sendError(res, 400, 'amount must be a positive number');

    let accountId = null;
    if (account) {
      const a = typeof account === 'number'
        ? await db.get('SELECT id FROM accounts WHERE id = ?', [account])
        : await db.get('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE', [String(account).trim()]);
      if (a) accountId = a.id;
    }
    if (!accountId) {
      const cashAcc = await db.get("SELECT id FROM accounts WHERE name = 'Cash' COLLATE NOCASE");
      accountId = cashAcc ? cashAcc.id : 2;
    }

    let type;
    if (mode === 'cash_expense') {
      type = 'expense';
    } else if (mode === 'lent' || mode === 'borrowed') {
      type = mode;
      if (!person) return sendError(res, 400, 'person is required for lent/borrowed');
    } else {
      return sendError(res, 400, `Unknown mode "${mode}". Supported: cash_expense, lent, borrowed`);
    }

    const txCategory = category || (mode === 'cash_expense' ? 'Food' : '');

    const tx = await db.withTransaction(async (txRunner) => {
      let resolvedPersonId = null;
      if (mode === 'lent' || mode === 'borrowed') {
        const p = await getOrCreatePerson(txRunner, person);
        resolvedPersonId = p ? p.id : null;
      }

      const params = {
        type,
        amount,
        account_id:    accountId,
        to_account_id: null,
        person_id:     resolvedPersonId,
      };

      await applyBalanceDeltas(txRunner, params, 1);
      const r = await txRunner.run(`
        INSERT INTO transactions (type, amount, account_id, to_account_id, person_id, category, merchant, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [type, amount, accountId, null, resolvedPersonId, txCategory, '', note || '']);
      return txRunner.get('SELECT * FROM transactions WHERE id = ?', [r.lastInsertRowid]);
    });

    send(res, 201, { success: true, mode, transaction: tx });
  } catch (err) { sendError(res, 500, err.message); }
}

async function handleExportCSV(req, res) {
  try {
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
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="udhaar-export.csv"',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(csv);
  } catch (err) { sendError(res, 500, err.message); }
}

// ─── Test-Only: DB Reset ──────────────────────────────────────────────────────

async function handleTestReset(req, res) {
  if (!IS_TEST) return sendError(res, 403, 'Only available in test mode (NODE_ENV=test)');
  try {
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM people');
    await db.run('DELETE FROM accounts');
    try {
      await db.run("DELETE FROM sqlite_sequence WHERE name IN ('accounts','people','transactions')");
    } catch { /* ignored */ }
    await db.run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['UPI / Bank']);
    await db.run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Cash']);
    await db.run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Savings']);
    const accounts = await db.all('SELECT * FROM accounts ORDER BY id');
    send(res, 200, { reset: true, accounts });
  } catch (err) { sendError(res, 500, err.message); }
}

// ─── Auth Endpoints ───────────────────────────────────────────────────────────

function handleLogin(req, res, body) {
  const { pin } = body;
  if (!pin) return sendError(res, 400, 'PIN is required');

  if (String(pin).trim() !== String(APP_PIN).trim()) {
    return sendError(res, 401, 'Incorrect PIN');
  }

  const token = createSessionToken();
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  const cookieHeader = `session=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`;

  send(res, 200, { ok: true, message: 'Authenticated' }, { 'Set-Cookie': cookieHeader });
}

function handleLogout(req, res) {
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  const cookieHeader = `session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`;
  send(res, 200, { ok: true, message: 'Logged out' }, { 'Set-Cookie': cookieHeader });
}

function handleAuthStatus(req, res) {
  const authed = isAuthenticated(req);
  send(res, 200, { authenticated: authed });
}

// ─── Static File Server ───────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function serveStatic(req, res, urlPath) {
  const safe     = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(__dirname, 'public', safe);
  const ct       = MIME[path.extname(filePath)] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(data);
  });
}

// ─── Main Router ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
    });
    res.end();
    return;
  }

  const url      = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method   = req.method;

  // Unauthenticated 24/7 Keep-Alive Health Endpoint
  if (pathname === '/health' && method === 'GET') {
    return send(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/')) {
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try { body = await readBody(req); }
      catch { return sendError(res, 400, 'Invalid JSON body'); }
    }

    // ── Public Auth & Health routes ──
    if (pathname === '/api/login'       && method === 'POST') return handleLogin(req, res, body);
    if (pathname === '/api/logout'      && method === 'POST') return handleLogout(req, res);
    if (pathname === '/api/auth/status' && method === 'GET')  return handleAuthStatus(req, res);
    if (pathname === '/api/test/reset'  && method === 'POST') return handleTestReset(req, res);

    // ── Protected Webhook endpoints (Token / API-Key protected) ──
    if (pathname === '/api/webhook/sms'   && method === 'POST') {
      if (!isWebhookAuthorized(req, url)) return sendError(res, 401, 'Invalid or missing API key');
      return handleSMSWebhook(req, res, body);
    }
    if (pathname === '/api/webhook/batch' && method === 'POST') {
      if (!isWebhookAuthorized(req, url)) return sendError(res, 401, 'Invalid or missing API key');
      return handleBatchSMS(req, res, body);
    }
    if (pathname === '/api/quick'         && method === 'POST') {
      if (!isWebhookAuthorized(req, url)) return sendError(res, 401, 'Invalid or missing API key');
      return handleQuick(req, res, body);
    }

    // ── Protected Dashboard endpoints (PIN Session Cookie required) ──
    if (!isAuthenticated(req)) {
      return sendError(res, 401, 'Unauthorized — PIN login required');
    }

    if (pathname === '/api/summary'       && method === 'GET')  return handleSummary(req, res);
    if (pathname === '/api/accounts'      && method === 'GET')  return handleGetAccounts(req, res);
    if (pathname === '/api/accounts'      && method === 'POST') return handleCreateAccount(req, res, body);
    if (pathname === '/api/people'        && method === 'GET')  return handleGetPeople(req, res);
    if (pathname === '/api/people'        && method === 'POST') return handleCreatePerson(req, res, body);
    if (pathname === '/api/transactions'  && method === 'GET')  return handleGetTransactions(req, res, url);
    if (pathname === '/api/transactions'  && method === 'POST') return handleCreateTransaction(req, res, body);
    if (pathname === '/api/export/csv'    && method === 'GET')  return handleExportCSV(req, res);

    const accM = pathname.match(/^\/api\/accounts\/(\d+)$/);
    if (accM   && method === 'PUT')    return handleUpdateAccount(req, res, +accM[1], body);

    const pTxM = pathname.match(/^\/api\/people\/(\d+)\/transactions$/);
    if (pTxM   && method === 'GET')    return handlePersonTransactions(req, res, +pTxM[1]);

    const txM  = pathname.match(/^\/api\/transactions\/(\d+)$/);
    if (txM    && method === 'PUT')    return handleUpdateTransaction(req, res, +txM[1], body);
    if (txM    && method === 'DELETE') return handleDeleteTransaction(req, res, +txM[1]);

    return sendError(res, 404, 'API endpoint not found');
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Udhaar server running at http://0.0.0.0:${PORT}`);
});
