import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db, initDB } from './db.js';

await initDB();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve('public');

const sendJSON = (res, data, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

const getBody = req => new Promise(res => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { res(JSON.parse(b)); } catch { res({}); } });
});

const isAuthed = req => {
  if (!process.env.APP_PIN) return true;
  const cookie = req.headers.cookie || '';
  const apiKey = req.headers['x-api-key'] || new URL(req.url, 'http://x').searchParams.get('key');
  return cookie.includes('session=authorized') || (process.env.WEBHOOK_SECRET && apiKey === process.env.WEBHOOK_SECRET);
};

const parseSMS = text => {
  if (/otp|one time password|verification code/i.test(text)) return null;
  const isDebit = /debited|spent|paid|sent|withdrawn/i.test(text);
  const isCredit = /credited|received|deposited|added/i.test(text);
  if (!isDebit && !isCredit) return null;

  const amtM = text.match(/(?:rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!amtM) return null;
  const amount = parseFloat(amtM[1].replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) return null;

  const utrM = text.match(/(?:upi|ref|utr)[: /]*([0-9]{12})/i);
  const merchM = text.match(/(?:to|at|vpa)\s+([a-zA-Z0-9@._ -]+?)(?:\s+on|\s+ref|\s+upi|\.|\s*$)/i);

  return {
    type: isDebit ? 'expense' : 'income',
    amount,
    utr: utrM ? utrM[1] : null,
    merchant: merchM ? merchM[1].trim() : (isDebit ? 'Debit Spend' : 'Credit Deposit'),
    category: isDebit ? 'Food' : 'Salary'
  };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Static Assets & Health
  if (req.method === 'GET') {
    if (pathname === '/health') return sendJSON(res, { ok: true });
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    }
    const safePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath);
      const mimeMap = {
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.js': 'application/javascript',
        '.css': 'text/css'
      };
      const mime = mimeMap[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      return fs.createReadStream(safePath).pipe(res);
    }
  }

  // 2. Authentication
  if (req.method === 'POST' && pathname === '/api/login') {
    const { pin } = await getBody(req);
    if (!process.env.APP_PIN || pin === process.env.APP_PIN) {
      res.writeHead(200, {
        'Set-Cookie': 'session=authorized; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000',
        'Content-Type': 'application/json'
      });
      return res.end(JSON.stringify({ authenticated: true }));
    }
    return sendJSON(res, { error: 'Incorrect PIN' }, 401);
  }

  // 3. State Endpoint with Month Switcher, Budget & Pause Vault
  if (req.method === 'GET' && pathname === '/api/state') {
    if (!isAuthed(req)) return sendJSON(res, { requiresPin: true });

    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const startMonth = `${month}-01 00:00:00`;
    const nextMonth = m === 12 ? `${y + 1}-01-01 00:00:00` : `${y}-${String(m + 1).padStart(2, '0')}-01 00:00:00`;

    const [accRes, peoRes, monRes, budRes, txRes, pauseRes, savedRes] = await db.batch([
      `SELECT id, name, balance FROM accounts ORDER BY id ASC`,
      `SELECT id, name, phone, net_balance FROM people WHERE net_balance != 0 ORDER BY ABS(net_balance) DESC`,
      { sql: `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'expense' AND created_at >= ? AND created_at < ?`, args: [startMonth, nextMonth] },
      `SELECT value FROM settings WHERE key = 'monthly_budget' LIMIT 1`,
      {
        sql: `SELECT t.*, a.name AS account_name, a2.name AS to_account_name, p.name AS person_name
              FROM transactions t
              LEFT JOIN accounts a ON t.account_id = a.id
              LEFT JOIN accounts a2 ON t.to_account_id = a2.id
              LEFT JOIN people p ON t.person_id = p.id
              WHERE t.created_at >= ? AND t.created_at < ?
              ORDER BY t.created_at DESC LIMIT 60`,
        args: [startMonth, nextMonth]
      },
      `SELECT id, name, amount, created_at FROM paused_items ORDER BY id DESC`,
      `SELECT value FROM settings WHERE key = 'saved_by_waiting' LIMIT 1`
    ], 'read');

    return sendJSON(res, {
      accounts: accRes.rows,
      people: peoRes.rows,
      monthlyExpense: Number(monRes.rows[0]?.total || 0),
      monthlyBudget: Number(budRes.rows[0]?.value || 25000),
      pausedItems: pauseRes.rows,
      savedByWaiting: Number(savedRes.rows[0]?.value || 0),
      currentMonth: month,
      transactions: txRes.rows,
      requiresPin: false
    });
  }

  // 4. Update Monthly Budget
  if (req.method === 'PUT' && pathname === '/api/budget') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { budget } = await getBody(req);
    const bVal = parseFloat(budget) || 0;
    await db.execute({
      sql: `INSERT INTO settings (key, value) VALUES ('monthly_budget', ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
      args: [String(bVal), String(bVal)]
    });
    return sendJSON(res, { success: true, budget: bVal });
  }

  // 5. Create Transaction (with Split-Expense support)
  if (req.method === 'POST' && pathname === '/api/transactions') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const body = await getBody(req);
    const { type, amount, account_id, to_account_id, note, category, merchant, utr, split_person, split_amount, split_friends } = body;
    let { person_id, person_name } = body;
    const val = parseFloat(amount);

    if (isNaN(val) || val <= 0) return sendJSON(res, { error: 'Valid positive amount required' }, 400);
    if (type === 'transfer' && account_id === to_account_id) {
      return sendJSON(res, { error: 'Source and destination accounts must differ' }, 400);
    }
    if (['lent', 'borrowed'].includes(type) && !person_id && !person_name) {
      return sendJSON(res, { error: 'Person is required for lent/borrowed' }, 400);
    }

    if (person_name && !person_id) {
      const pRes = await db.execute({ sql: `SELECT id FROM people WHERE name = ? COLLATE NOCASE`, args: [person_name.trim()] });
      if (pRes.rows.length) {
        person_id = pRes.rows[0].id;
      } else {
        const ins = await db.execute({ sql: `INSERT INTO people (name, net_balance) VALUES (?, 0) RETURNING id`, args: [person_name.trim()] });
        person_id = ins.rows[0].id;
      }
    }

    const stmts = [];

    // Split-Expense Atomic Multi-Person or Dual Entry
    const friends = Array.isArray(split_friends) && split_friends.length > 0
      ? split_friends
      : (split_person && parseFloat(split_amount) > 0 ? [{ name: split_person, amount: parseFloat(split_amount) }] : null);

    if (type === 'expense' && friends && friends.length > 0) {
      const totalSplitAmt = friends.reduce((sum, f) => sum + (parseFloat(f.amount) || 0), 0);
      const myShare = val - totalSplitAmt;
      if (myShare < 0) return sendJSON(res, { error: 'Total split shares cannot exceed paid amount' }, 400);

      // Total paid deducted from payer's account
      stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, account_id] });

      // Process each friend
      for (const friend of friends) {
        const fAmt = parseFloat(friend.amount) || 0;
        const fName = (friend.name || '').trim();
        if (!fName || fAmt <= 0) continue;

        let spId;
        const spRes = await db.execute({ sql: `SELECT id FROM people WHERE name = ? COLLATE NOCASE`, args: [fName] });
        if (spRes.rows.length) {
          spId = spRes.rows[0].id;
        } else {
          const insSp = await db.execute({ sql: `INSERT INTO people (name, net_balance) VALUES (?, 0) RETURNING id`, args: [fName] });
          spId = insSp.rows[0].id;
        }

        // Friend's debt increases by their share
        stmts.push({ sql: `UPDATE people SET net_balance = net_balance + ? WHERE id = ?`, args: [fAmt, spId] });
        // Friend's lent portion record
        stmts.push({
          sql: `INSERT INTO transactions (type, amount, account_id, person_id, category, merchant, note) VALUES ('lent', ?, ?, ?, ?, ?, ?)`,
          args: [fAmt, account_id, spId, category || 'Food', merchant || null, `Split with ${fName}`]
        });
      }

      // My personal expense share record
      if (myShare > 0) {
        stmts.push({
          sql: `INSERT INTO transactions (type, amount, account_id, category, merchant, note) VALUES ('expense', ?, ?, ?, ?, ?)`,
          args: [myShare, account_id, category || 'Food', merchant || null, `${note ? note + ' ' : ''}(My share)`]
        });
      }

      await db.batch(stmts, 'write');
      return sendJSON(res, { success: true, myShare, totalSplitAmt });
    }

    // Standard transactions
    if (type === 'expense') stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, account_id] });
    else if (type === 'income') stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, account_id] });
    else if (type === 'transfer') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, account_id] });
      stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, to_account_id] });
    } else if (type === 'lent') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance + ? WHERE id = ?`, args: [val, person_id] });
    } else if (type === 'borrowed') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance - ? WHERE id = ?`, args: [val, person_id] });
    } else if (type === 'settle_in') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance - ? WHERE id = ?`, args: [val, person_id] });
    } else if (type === 'settle_out') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance + ? WHERE id = ?`, args: [val, person_id] });
    }

    stmts.push({
      sql: `INSERT INTO transactions (type, amount, account_id, to_account_id, person_id, category, merchant, note, utr)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [type, val, account_id || null, to_account_id || null, person_id || null, category || null, merchant || null, note || null, utr || null]
    });

    await db.batch(stmts, 'write');
    return sendJSON(res, { success: true });
  }

  // 6. Update Account Balance
  const accMatch = pathname.match(/^\/api\/accounts\/(\d+)$/);
  if (req.method === 'PUT' && accMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { balance } = await getBody(req);
    await db.execute({ sql: `UPDATE accounts SET balance = ? WHERE id = ?`, args: [parseFloat(balance) || 0, accMatch[1]] });
    return sendJSON(res, { success: true });
  }

  // 7. Delete Transaction (Atomic reversal)
  const txMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
  if (req.method === 'DELETE' && txMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const txRes = await db.execute({ sql: `SELECT * FROM transactions WHERE id = ?`, args: [txMatch[1]] });
    if (!txRes.rows.length) return sendJSON(res, { error: 'Transaction not found' }, 404);

    const tx = txRes.rows[0];
    const val = tx.amount;
    const stmts = [];

    if (tx.type === 'expense') stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, tx.account_id] });
    else if (tx.type === 'income') stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, tx.account_id] });
    else if (tx.type === 'transfer') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, tx.account_id] });
      stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, tx.to_account_id] });
    } else if (tx.type === 'lent') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, tx.account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance - ? WHERE id = ?`, args: [val, tx.person_id] });
    } else if (tx.type === 'borrowed') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, tx.account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance + ? WHERE id = ?`, args: [val, tx.person_id] });
    } else if (tx.type === 'settle_in') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [val, tx.account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance + ? WHERE id = ?`, args: [val, tx.person_id] });
    } else if (tx.type === 'settle_out') {
      stmts.push({ sql: `UPDATE accounts SET balance = balance + ? WHERE id = ?`, args: [val, tx.account_id] });
      stmts.push({ sql: `UPDATE people SET net_balance = net_balance - ? WHERE id = ?`, args: [val, tx.person_id] });
    }

    stmts.push({ sql: `DELETE FROM transactions WHERE id = ?`, args: [tx.id] });
    await db.batch(stmts, 'write');
    return sendJSON(res, { success: true });
  }

  // 8. 24-Hour Impulse Cooldown ("Pause Vault") Endpoints
  if (req.method === 'POST' && pathname === '/api/cooldown') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { name, amount } = await getBody(req);
    const val = parseFloat(amount);
    if (!name || isNaN(val) || val <= 0) return sendJSON(res, { error: 'Valid item name and amount required' }, 400);

    const r = await db.execute({
      sql: `INSERT INTO paused_items (name, amount) VALUES (?, ?) RETURNING id, name, amount, created_at`,
      args: [name.trim(), val]
    });
    return sendJSON(res, { success: true, item: r.rows[0] });
  }

  const commitMatch = pathname.match(/^\/api\/cooldown\/(\d+)\/commit$/);
  if (req.method === 'POST' && commitMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const itemId = commitMatch[1];
    const itemRes = await db.execute({ sql: `SELECT * FROM paused_items WHERE id = ?`, args: [itemId] });
    if (!itemRes.rows.length) return sendJSON(res, { error: 'Cooldown item not found' }, 404);

    const item = itemRes.rows[0];
    const defAcc = (await db.execute(`SELECT id FROM accounts WHERE name LIKE '%UPI%' OR name LIKE '%Bank%' ORDER BY id ASC LIMIT 1`)).rows[0]?.id || 1;

    await db.batch([
      { sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [item.amount, defAcc] },
      {
        sql: `INSERT INTO transactions (type, amount, account_id, category, merchant, note) VALUES ('expense', ?, ?, 'General', ?, 'Committed after 24h cooldown')`,
        args: [item.amount, defAcc, item.name]
      },
      { sql: `DELETE FROM paused_items WHERE id = ?`, args: [itemId] }
    ], 'write');
    return sendJSON(res, { success: true });
  }

  const skipMatch = pathname.match(/^\/api\/cooldown\/(\d+)\/skip$/);
  if (req.method === 'POST' && skipMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const itemId = skipMatch[1];
    const itemRes = await db.execute({ sql: `SELECT * FROM paused_items WHERE id = ?`, args: [itemId] });
    if (!itemRes.rows.length) return sendJSON(res, { error: 'Cooldown item not found' }, 404);

    const item = itemRes.rows[0];
    const savedRes = await db.execute(`SELECT value FROM settings WHERE key = 'saved_by_waiting' LIMIT 1`);
    const curSaved = parseFloat(savedRes.rows[0]?.value || '0');
    const newSaved = curSaved + Number(item.amount);

    await db.batch([
      {
        sql: `INSERT INTO settings (key, value) VALUES ('saved_by_waiting', ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
        args: [String(newSaved), String(newSaved)]
      },
      { sql: `DELETE FROM paused_items WHERE id = ?`, args: [itemId] }
    ], 'write');
    return sendJSON(res, { success: true, savedByWaiting: newSaved });
  }

  // 9. SMS Webhook
  if (req.method === 'POST' && pathname === '/api/webhook/sms') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const body = await getBody(req);
    const raw = body.sms || body.raw_text || (typeof body === 'string' ? body : '');
    const lines = raw.split(/(?:\r?\n|---)+/).map(s => s.trim()).filter(Boolean);

    let imported = 0, duplicates = 0, ignored = 0;
    const defAcc = (await db.execute(`SELECT id FROM accounts WHERE name LIKE '%UPI%' OR name LIKE '%Bank%' ORDER BY id ASC LIMIT 1`)).rows[0]?.id || 1;

    for (const line of lines) {
      const parsed = parseSMS(line);
      if (!parsed) { ignored++; continue; }
      const accId = Number(body.account_id || defAcc);

      if (parsed.utr) {
        const u = await db.execute({ sql: `SELECT id FROM transactions WHERE utr = ?`, args: [parsed.utr] });
        if (u.rows.length) { duplicates++; continue; }
      } else {
        const f = await db.execute({
          sql: `SELECT id FROM transactions WHERE amount = ? AND type = ? AND created_at >= datetime('now', '+5 hours', '27 minutes')`,
          args: [parsed.amount, parsed.type]
        });
        if (f.rows.length) { duplicates++; continue; }
      }

      await db.batch([
        {
          sql: parsed.type === 'expense'
            ? `UPDATE accounts SET balance = balance - ? WHERE id = ?`
            : `UPDATE accounts SET balance = balance + ? WHERE id = ?`,
          args: [parsed.amount, accId]
        },
        {
          sql: `INSERT INTO transactions (type, amount, account_id, merchant, category, utr, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [parsed.type, parsed.amount, accId, parsed.merchant, parsed.category, parsed.utr, 'Imported from SMS']
        }
      ], 'write');
      imported++;
    }
    return sendJSON(res, { imported, duplicates, ignored });
  }

  // Test reset helper for test suites
  if (process.env.NODE_ENV === 'test' && req.method === 'POST' && pathname === '/api/test/reset') {
    await db.batch([
      `DELETE FROM transactions`,
      `DELETE FROM people`,
      `DELETE FROM accounts`,
      `DELETE FROM paused_items`,
      `INSERT INTO accounts (id, name, balance) VALUES (1, 'UPI / Bank', 0), (2, 'Cash', 0), (3, 'Savings', 0)`,
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('monthly_budget', '25000')`,
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('saved_by_waiting', '0')`
    ], 'write');
    return sendJSON(res, { reset: true });
  }

  sendJSON(res, { error: 'Not Found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Ledger running on http://0.0.0.0:${PORT}`));
export default server;
