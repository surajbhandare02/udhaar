import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db, initDB } from './db.js';

await initDB();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve('public');

const sendJSON = (res, data, code = 200) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  });
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
  if (/otp|one time password|verification code|promo|discount|code is/i.test(text)) return null;
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
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
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

  // 3. State Endpoint with Complete Financial Modules
  if (req.method === 'GET' && pathname === '/api/state') {
    if (!isAuthed(req)) return sendJSON(res, { requiresPin: true }, 401);

    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const startMonth = `${month}-01 00:00:00`;
    const nextMonth = m === 12 ? `${y + 1}-01-01 00:00:00` : `${y}-${String(m + 1).padStart(2, '0')}-01 00:00:00`;

    // Weekly range (past 7 days) and yearly range
    const startYear = `${y}-01-01 00:00:00`;
    const nextYear = `${y + 1}-01-01 00:00:00`;

    const [
      accRes, peoRes, monExpRes, monIncRes, budSetRes, txRes, pauseRes, savedRes,
      budgetsRes, subsRes, billsRes, goalsRes, tplsRes
    ] = await db.batch([
      `SELECT id, name, balance, type, credit_limit, statement_date, due_date FROM accounts ORDER BY id ASC`,
      `SELECT id, name, phone, net_balance FROM people WHERE net_balance != 0 ORDER BY ABS(net_balance) DESC`,
      { sql: `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'expense' AND created_at >= ? AND created_at < ?`, args: [startMonth, nextMonth] },
      { sql: `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'income' AND created_at >= ? AND created_at < ?`, args: [startMonth, nextMonth] },
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
      `SELECT value FROM settings WHERE key = 'saved_by_waiting' LIMIT 1`,
      `SELECT id, category, period, amount FROM budgets ORDER BY id ASC`,
      `SELECT id, name, amount, billing_cycle, next_renewal_date, account_id, category FROM subscriptions ORDER BY next_renewal_date ASC`,
      `SELECT id, name, amount, category, account_id, frequency, due_date, last_paid_at FROM recurring_bills ORDER BY due_date ASC`,
      `SELECT id, name, target_amount, current_amount, target_date, account_id FROM savings_goals ORDER BY id ASC`,
      `SELECT id, name, type, amount, account_id, category, note FROM templates ORDER BY id ASC`
    ], 'read');

    // Calculate Accounts & Credit Cards metrics
    const accounts = accRes.rows.map(a => {
      const isCC = a.type === 'credit_card';
      const limit = Number(a.credit_limit || 0);
      const balance = Number(a.balance || 0);
      const available_credit = isCC ? Math.max(0, limit - balance) : balance;
      const utilization_pct = isCC && limit > 0 ? Math.min(100, Math.round((balance / limit) * 100)) : 0;
      return {
        ...a,
        balance,
        credit_limit: limit,
        available_credit,
        utilization_pct
      };
    });

    // Net Worth Calculation: (Bank + Cash + Prepaid + Savings Assets) - (Credit Card Debt + Money Owed to People)
    let totalAssets = 0;
    let totalLiabilities = 0;

    for (const a of accounts) {
      if (a.type === 'credit_card') {
        totalLiabilities += a.balance; // Utilized debt
      } else {
        totalAssets += Math.max(0, a.balance);
      }
    }
    for (const p of peoRes.rows) {
      if (p.net_balance > 0) totalAssets += p.net_balance; // Money owed to me
      if (p.net_balance < 0) totalLiabilities += Math.abs(p.net_balance); // Money I owe
    }
    const netWorth = totalAssets - totalLiabilities;

    // Subscriptions Normalization & Days until renewal
    let totalMonthlySubscriptions = 0;
    const now = Date.now();
    const subscriptions = subsRes.rows.map(s => {
      const amt = Number(s.amount || 0);
      let monthlyCost = amt;
      let yearlyCost = amt * 12;
      if (s.billing_cycle === 'yearly') {
        monthlyCost = amt / 12;
        yearlyCost = amt;
      } else if (s.billing_cycle === 'quarterly') {
        monthlyCost = amt / 3;
        yearlyCost = amt * 4;
      }
      totalMonthlySubscriptions += monthlyCost;

      const renewalMs = new Date(s.next_renewal_date + 'T00:00:00').getTime();
      const diffDays = Math.ceil((renewalMs - now) / (1000 * 3600 * 24));
      const daysUntilRenewal = isNaN(diffDays) ? 0 : diffDays;
      const isUpcoming = daysUntilRenewal >= 0 && daysUntilRenewal <= 3;

      return {
        ...s,
        monthlyCost: +monthlyCost.toFixed(2),
        yearlyCost: +yearlyCost.toFixed(2),
        daysUntilRenewal,
        isUpcoming
      };
    });

    // Calculate Budgets residuals & statuses
    const budgets = [];
    for (const b of budgetsRes.rows) {
      const bAmt = Number(b.amount || 0);
      let spent = 0;
      if (b.period === 'weekly') {
        const weekRes = await db.execute({
          sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
                WHERE type = 'expense' AND category = ? AND created_at >= datetime('now', '-7 days')`,
          args: [b.category]
        });
        spent = Number(weekRes.rows[0]?.total || 0);
      } else if (b.period === 'yearly') {
        const yearRes = await db.execute({
          sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
                WHERE type = 'expense' AND category = ? AND created_at >= ? AND created_at < ?`,
          args: [b.category, startYear, nextYear]
        });
        spent = Number(yearRes.rows[0]?.total || 0);
      } else {
        // Monthly
        const monRes = await db.execute({
          sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
                WHERE type = 'expense' AND category = ? AND created_at >= ? AND created_at < ?`,
          args: [b.category, startMonth, nextMonth]
        });
        spent = Number(monRes.rows[0]?.total || 0);
      }

      const residual = bAmt - spent;
      const percentage = bAmt > 0 ? Math.round((spent / bAmt) * 100) : 0;
      const status = percentage > 100 ? 'exceeded' : percentage >= 80 ? 'warning' : 'normal';

      budgets.push({
        ...b,
        amount: bAmt,
        spent,
        residual,
        percentage,
        status
      });
    }

    // Savings Goals percentages
    const savingsGoals = goalsRes.rows.map(g => {
      const target = Number(g.target_amount || 0);
      const current = Number(g.current_amount || 0);
      const percentage = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
      return {
        ...g,
        target_amount: target,
        current_amount: current,
        percentage
      };
    });

    return sendJSON(res, {
      accounts,
      netWorth: +netWorth.toFixed(2),
      people: peoRes.rows,
      monthlyExpense: Number(monExpRes.rows[0]?.total || 0),
      monthlyIncome: Number(monIncRes.rows[0]?.total || 0),
      monthlyBudget: Number(budSetRes.rows[0]?.value || 25000),
      budgets,
      subscriptions,
      totalMonthlySubscriptions: +totalMonthlySubscriptions.toFixed(2),
      recurringBills: billsRes.rows,
      savingsGoals,
      templates: tplsRes.rows,
      pausedItems: pauseRes.rows,
      savedByWaiting: Number(savedRes.rows[0]?.value || 0),
      currentMonth: month,
      transactions: txRes.rows,
      requiresPin: false
    });
  }

  // 4. Update Monthly Budget Target
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

  // 5. Create Transaction (Zero-Overlap Accounting Engine)
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

        stmts.push({ sql: `UPDATE people SET net_balance = net_balance + ? WHERE id = ?`, args: [fAmt, spId] });
        stmts.push({
          sql: `INSERT INTO transactions (type, amount, account_id, person_id, category, merchant, note) VALUES ('lent', ?, ?, ?, ?, ?, ?)`,
          args: [fAmt, account_id, spId, category || 'Food', merchant || null, `Split with ${fName}`]
        });
      }

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

  // 6. Accounts Management (Create, Update Balance/Details, Delete)
  if (req.method === 'POST' && pathname === '/api/accounts') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { name, balance, type, credit_limit, statement_date, due_date } = await getBody(req);
    if (!name) return sendJSON(res, { error: 'Account name required' }, 400);

    const r = await db.execute({
      sql: `INSERT INTO accounts (name, balance, type, credit_limit, statement_date, due_date)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name`,
      args: [
        name.trim(),
        parseFloat(balance) || 0,
        type || 'bank',
        parseFloat(credit_limit) || 0,
        parseInt(statement_date) || 15,
        parseInt(due_date) || 5
      ]
    });
    return sendJSON(res, { success: true, account: r.rows[0] });
  }

  const accMatch = pathname.match(/^\/api\/accounts\/(\d+)$/);
  if (accMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const accId = accMatch[1];

    if (req.method === 'PUT') {
      const body = await getBody(req);
      const updates = [];
      const args = [];
      if (body.balance !== undefined) { updates.push('balance = ?'); args.push(parseFloat(body.balance) || 0); }
      if (body.credit_limit !== undefined) { updates.push('credit_limit = ?'); args.push(parseFloat(body.credit_limit) || 0); }
      if (body.statement_date !== undefined) { updates.push('statement_date = ?'); args.push(parseInt(body.statement_date) || 15); }
      if (body.due_date !== undefined) { updates.push('due_date = ?'); args.push(parseInt(body.due_date) || 5); }

      if (updates.length > 0) {
        args.push(accId);
        await db.execute({ sql: `UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, args });
      }
      return sendJSON(res, { success: true });
    }

    if (req.method === 'DELETE') {
      await db.execute({ sql: `DELETE FROM accounts WHERE id = ?`, args: [accId] });
      return sendJSON(res, { success: true });
    }
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

  // 8. Smart Budgets Endpoints
  if (req.method === 'POST' && pathname === '/api/budgets') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { category, period, amount } = await getBody(req);
    const val = parseFloat(amount);
    if (!category || isNaN(val) || val <= 0) return sendJSON(res, { error: 'Valid category and positive amount required' }, 400);

    const r = await db.execute({
      sql: `INSERT INTO budgets (category, period, amount) VALUES (?, ?, ?) RETURNING id`,
      args: [category.trim(), period || 'monthly', val]
    });
    return sendJSON(res, { success: true, id: r.rows[0]?.id });
  }

  const budMatch = pathname.match(/^\/api\/budgets\/(\d+)$/);
  if (req.method === 'DELETE' && budMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    await db.execute({ sql: `DELETE FROM budgets WHERE id = ?`, args: [budMatch[1]] });
    return sendJSON(res, { success: true });
  }

  // 9. Subscriptions Endpoints
  if (req.method === 'POST' && pathname === '/api/subscriptions') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { name, amount, billing_cycle, next_renewal_date, account_id, category } = await getBody(req);
    const val = parseFloat(amount);
    if (!name || isNaN(val) || val <= 0 || !next_renewal_date) {
      return sendJSON(res, { error: 'Valid name, amount, and renewal date required' }, 400);
    }

    const r = await db.execute({
      sql: `INSERT INTO subscriptions (name, amount, billing_cycle, next_renewal_date, account_id, category)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [name.trim(), val, billing_cycle || 'monthly', next_renewal_date, account_id || null, category || 'Entertainment']
    });
    return sendJSON(res, { success: true, id: r.rows[0]?.id });
  }

  const subMatch = pathname.match(/^\/api\/subscriptions\/(\d+)$/);
  if (req.method === 'DELETE' && subMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    await db.execute({ sql: `DELETE FROM subscriptions WHERE id = ?`, args: [subMatch[1]] });
    return sendJSON(res, { success: true });
  }

  // 10. Recurring Bills Endpoints
  if (req.method === 'POST' && pathname === '/api/recurring-bills') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { name, amount, category, account_id, frequency, due_date } = await getBody(req);
    const val = parseFloat(amount);
    if (!name || isNaN(val) || val <= 0 || !due_date) {
      return sendJSON(res, { error: 'Valid name, amount, and due date required' }, 400);
    }

    const r = await db.execute({
      sql: `INSERT INTO recurring_bills (name, amount, category, account_id, frequency, due_date)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [name.trim(), val, category || 'Bills', account_id || null, frequency || 'monthly', due_date]
    });
    return sendJSON(res, { success: true, id: r.rows[0]?.id });
  }

  const billPayMatch = pathname.match(/^\/api\/recurring-bills\/(\d+)\/pay$/);
  if (req.method === 'POST' && billPayMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const billId = billPayMatch[1];
    const bRes = await db.execute({ sql: `SELECT * FROM recurring_bills WHERE id = ?`, args: [billId] });
    if (!bRes.rows.length) return sendJSON(res, { error: 'Bill not found' }, 404);
    const bill = bRes.rows[0];

    const defAcc = bill.account_id || (await db.execute(`SELECT id FROM accounts WHERE name LIKE '%UPI%' OR name LIKE '%Bank%' ORDER BY id ASC LIMIT 1`)).rows[0]?.id || 1;

    // Advance due date by 1 month or 1 year
    const curDate = new Date(bill.due_date);
    if (bill.frequency === 'yearly') curDate.setFullYear(curDate.getFullYear() + 1);
    else if (bill.frequency === 'quarterly') curDate.setMonth(curDate.getMonth() + 3);
    else curDate.setMonth(curDate.getMonth() + 1);
    const nextDue = curDate.toISOString().slice(0, 10);

    await db.batch([
      { sql: `UPDATE accounts SET balance = balance - ? WHERE id = ?`, args: [bill.amount, defAcc] },
      {
        sql: `INSERT INTO transactions (type, amount, account_id, category, merchant, note) VALUES ('expense', ?, ?, ?, ?, 'Recurring bill payment')`,
        args: [bill.amount, defAcc, bill.category || 'Bills', bill.name]
      },
      {
        sql: `UPDATE recurring_bills SET due_date = ?, last_paid_at = datetime('now') WHERE id = ?`,
        args: [nextDue, billId]
      }
    ], 'write');
    return sendJSON(res, { success: true, nextDue });
  }

  const billMatch = pathname.match(/^\/api\/recurring-bills\/(\d+)$/);
  if (req.method === 'DELETE' && billMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    await db.execute({ sql: `DELETE FROM recurring_bills WHERE id = ?`, args: [billMatch[1]] });
    return sendJSON(res, { success: true });
  }

  // 11. Savings Goals Endpoints
  if (req.method === 'POST' && pathname === '/api/savings-goals') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { name, target_amount, current_amount, target_date, account_id } = await getBody(req);
    const tVal = parseFloat(target_amount);
    if (!name || isNaN(tVal) || tVal <= 0) return sendJSON(res, { error: 'Valid goal name and target required' }, 400);

    const r = await db.execute({
      sql: `INSERT INTO savings_goals (name, target_amount, current_amount, target_date, account_id)
            VALUES (?, ?, ?, ?, ?) RETURNING id`,
      args: [name.trim(), tVal, parseFloat(current_amount) || 0, target_date || null, account_id || null]
    });
    return sendJSON(res, { success: true, id: r.rows[0]?.id });
  }

  const goalDepMatch = pathname.match(/^\/api\/savings-goals\/(\d+)\/deposit$/);
  if (req.method === 'POST' && goalDepMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const goalId = goalDepMatch[1];
    const { amount } = await getBody(req);
    const val = parseFloat(amount);
    if (isNaN(val) || val === 0) return sendJSON(res, { error: 'Valid non-zero amount required' }, 400);

    await db.execute({
      sql: `UPDATE savings_goals SET current_amount = MAX(0, current_amount + ?) WHERE id = ?`,
      args: [val, goalId]
    });
    return sendJSON(res, { success: true });
  }

  const goalMatch = pathname.match(/^\/api\/savings-goals\/(\d+)$/);
  if (req.method === 'DELETE' && goalMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    await db.execute({ sql: `DELETE FROM savings_goals WHERE id = ?`, args: [goalMatch[1]] });
    return sendJSON(res, { success: true });
  }

  // 12. Transaction Templates Endpoints
  if (req.method === 'POST' && pathname === '/api/templates') {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const { name, type, amount, account_id, category, note } = await getBody(req);
    const val = parseFloat(amount);
    if (!name || isNaN(val) || val <= 0) return sendJSON(res, { error: 'Valid template name and amount required' }, 400);

    const r = await db.execute({
      sql: `INSERT INTO templates (name, type, amount, account_id, category, note) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [name.trim(), type || 'expense', val, account_id || null, category || 'General', note || null]
    });
    return sendJSON(res, { success: true, id: r.rows[0]?.id });
  }

  const tplMatch = pathname.match(/^\/api\/templates\/(\d+)$/);
  if (req.method === 'DELETE' && tplMatch) {
    if (!isAuthed(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
    await db.execute({ sql: `DELETE FROM templates WHERE id = ?`, args: [tplMatch[1]] });
    return sendJSON(res, { success: true });
  }

  // 13. 24-Hour Impulse Cooldown ("Pause Vault") Endpoints
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

  // 14. SMS Webhook
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
      `DELETE FROM budgets`,
      `DELETE FROM subscriptions`,
      `DELETE FROM recurring_bills`,
      `DELETE FROM savings_goals`,
      `DELETE FROM templates`,
      `INSERT INTO accounts (id, name, balance, type, credit_limit, statement_date, due_date) VALUES
        (1, 'UPI / Bank', 0, 'bank', 0, 15, 5),
        (2, 'Cash', 0, 'cash', 0, 15, 5),
        (3, 'Savings', 0, 'bank', 0, 15, 5)`,
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('monthly_budget', '25000')`,
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('saved_by_waiting', '0')`
    ], 'write');
    return sendJSON(res, { reset: true });
  }

  sendJSON(res, { error: 'Not Found' }, 404);
});

server.listen(PORT, '0.0.0.0', () => console.log(`Ledger running on http://0.0.0.0:${PORT}`));
export default server;
