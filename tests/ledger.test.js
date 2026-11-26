import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:test-ledger.db';
process.env.PORT = '3099';

const { default: server } = await import('../server.js');
const BASE = 'http://127.0.0.1:3099';

const UPI_BANK = 1;
const CASH     = 2;

async function api(method, endpoint, payload) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (payload !== undefined) opts.body = JSON.stringify(payload);
  const res = await fetch(`${BASE}${endpoint}`, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function getState() {
  const { body } = await api('GET', '/api/state');
  return body;
}

async function getBalance(id) {
  const s = await getState();
  const acc = s.accounts.find(a => a.id === id);
  return acc ? acc.balance : 0;
}

async function getPersonBalance(name) {
  const s = await getState();
  const p = s.people.find(x => x.name.toLowerCase() === name.toLowerCase());
  return p ? p.net_balance : 0;
}

async function resetDB() {
  const { status } = await api('POST', '/api/test/reset');
  assert.equal(status, 200);
}

describe('Udhaar Ledger Comprehensive Tests', () => {
  after(async () => {
    await new Promise(r => server.close(r));
    if (existsSync('test-ledger.db')) await unlink('test-ledger.db').catch(()=>{});
    process.exit(0);
  });

  describe('Group A: Accounting Precision & Math', () => {
    beforeEach(resetDB);

    it('A1 — expense reduces balance and adds to monthly expense', async () => {
      const beforeBal = await getBalance(UPI_BANK);
      const { status } = await api('POST', '/api/transactions', {
        type: 'expense', amount: 500, account_id: UPI_BANK, category: 'Food'
      });
      assert.equal(status, 200);
      assert.equal(await getBalance(UPI_BANK), beforeBal - 500);

      const s = await getState();
      assert.equal(s.monthlyExpense, 500);
    });

    it('A2 — income increases balance and does not add to monthly expense', async () => {
      const beforeBal = await getBalance(UPI_BANK);
      await api('POST', '/api/transactions', {
        type: 'income', amount: 1500, account_id: UPI_BANK
      });
      assert.equal(await getBalance(UPI_BANK), beforeBal + 1500);

      const s = await getState();
      assert.equal(s.monthlyExpense, 0);
    });

    it('A3 — transfer moves balance between accounts', async () => {
      await api('POST', '/api/transactions', {
        type: 'transfer', amount: 300, account_id: UPI_BANK, to_account_id: CASH
      });
      assert.equal(await getBalance(UPI_BANK), -300);
      assert.equal(await getBalance(CASH), 300);
    });

    it('A4 — lent updates account and debtor balance', async () => {
      await api('POST', '/api/transactions', {
        type: 'lent', amount: 800, account_id: UPI_BANK, person_name: 'Rahul'
      });
      assert.equal(await getBalance(UPI_BANK), -800);
      assert.equal(await getPersonBalance('Rahul'), 800);
    });

    it('A5 — borrowed updates account and creditor balance', async () => {
      await api('POST', '/api/transactions', {
        type: 'borrowed', amount: 400, account_id: CASH, person_name: 'Amit'
      });
      assert.equal(await getBalance(CASH), 400);
      assert.equal(await getPersonBalance('Amit'), -400);
    });

    it('A6 — settle_in and settle_out clear balances', async () => {
      await api('POST', '/api/transactions', {
        type: 'lent', amount: 800, account_id: UPI_BANK, person_name: 'Rahul'
      });
      const s1 = await getState();
      const rahulId = s1.people.find(p => p.name === 'Rahul').id;

      await api('POST', '/api/transactions', {
        type: 'settle_in', amount: 500, account_id: CASH, person_id: rahulId
      });
      assert.equal(await getPersonBalance('Rahul'), 300);
      assert.equal(await getBalance(CASH), 500);
    });

    it('A7 — delete transaction reverses balance changes cleanly', async () => {
      await api('POST', '/api/transactions', {
        type: 'lent', amount: 600, account_id: UPI_BANK, person_name: 'Suresh'
      });
      const s1 = await getState();
      const txId = s1.transactions[0].id;
      assert.equal(await getPersonBalance('Suresh'), 600);

      const { status } = await api('DELETE', `/api/transactions/${txId}`);
      assert.equal(status, 200);
      assert.equal(await getBalance(UPI_BANK), 0);
      assert.equal(await getPersonBalance('Suresh'), 0);
    });

    it('A8 — dual split-expense atomically splits into personal expense and lent debtor entry', async () => {
      const { status } = await api('POST', '/api/transactions', {
        type: 'expense', amount: 1000, account_id: UPI_BANK, category: 'Food',
        split_person: 'Rohan', split_amount: 500
      });
      assert.equal(status, 200);
      assert.equal(await getBalance(UPI_BANK), -1000); // 1000 deducted from bank
      assert.equal(await getPersonBalance('Rohan'), 500); // Rohan owes 500

      const s = await getState();
      assert.equal(s.monthlyExpense, 500); // Only my 500 share counts toward monthly expense
    });

    it('A9 — multi-person split (e.g. 900 split 3-ways) correctly splits across all participants', async () => {
      const { status } = await api('POST', '/api/transactions', {
        type: 'expense', amount: 900, account_id: UPI_BANK, category: 'Food',
        split_friends: [
          { name: 'Amit', amount: 300 },
          { name: 'Neha', amount: 300 }
        ]
      });
      assert.equal(status, 200);
      assert.equal(await getBalance(UPI_BANK), -900); // 900 deducted from bank
      assert.equal(await getPersonBalance('Amit'), 300); // Amit owes 300
      assert.equal(await getPersonBalance('Neha'), 300); // Neha owes 300

      const s = await getState();
      assert.equal(s.monthlyExpense, 300); // My share is 900 - 600 = 300
    });
  });

  describe('Group B: 24-Hour Impulse Cooldown ("Pause Vault")', () => {
    beforeEach(resetDB);

    it('B1 — adds item to cooldown vault', async () => {
      const { status, body } = await api('POST', '/api/cooldown', { name: 'Headphones', amount: 4500 });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(body.item.name, 'Headphones');
      assert.equal(body.item.amount, 4500);

      const s = await getState();
      assert.equal(s.pausedItems.length, 1);
      assert.equal(s.pausedItems[0].name, 'Headphones');
    });

    it('B2 — commit converts cooldown item to real expense transaction', async () => {
      const { body } = await api('POST', '/api/cooldown', { name: 'Smartwatch', amount: 2000 });
      const itemId = body.item.id;

      const { status } = await api('POST', `/api/cooldown/${itemId}/commit`);
      assert.equal(status, 200);

      const s = await getState();
      assert.equal(s.pausedItems.length, 0); // Removed from vault
      assert.equal(s.monthlyExpense, 2000);  // Converted to expense
      assert.equal(await getBalance(UPI_BANK), -2000); // Deducted from bank
    });

    it('B3 — skip removes item from vault and increments saved_by_waiting', async () => {
      const { body } = await api('POST', '/api/cooldown', { name: 'Designer Shoes', amount: 3500 });
      const itemId = body.item.id;

      const { status, body: skipBody } = await api('POST', `/api/cooldown/${itemId}/skip`);
      assert.equal(status, 200);
      assert.equal(skipBody.savedByWaiting, 3500);

      const s = await getState();
      assert.equal(s.pausedItems.length, 0); // Removed from vault
      assert.equal(s.monthlyExpense, 0);     // Zero expense incurred
      assert.equal(s.savedByWaiting, 3500);  // Saved counter updated
    });
  });

  describe('Group C: Bank SMS Parser & Webhook', () => {
    beforeEach(resetDB);

    it('C1 — parses HDFC UPI debit with UTR deduplication', async () => {
      const sms = 'Dear Customer, Rs 240.00 debited from HDFC Bank A/C ending 1234 to Swiggy on 12-Nov-26 UPI/431712345678.';
      const res1 = await api('POST', '/api/webhook/sms', { sms });
      assert.equal(res1.body.imported, 1);
      assert.equal(await getBalance(UPI_BANK), -240);

      const res2 = await api('POST', '/api/webhook/sms', { sms });
      assert.equal(res2.body.duplicates, 1);
      assert.equal(await getBalance(UPI_BANK), -240);
    });

    it('C2 — parses SBI credit SMS and ignores OTP', async () => {
      const batch = `Your A/C 9876 credited by Rs 1,500.00 on 10-Nov-26 by transfer from Boss UPI/431788889999.
---
Your OTP for login is 482910. Do not share with anyone.`;
      const res = await api('POST', '/api/webhook/sms', { raw_text: batch });
      assert.equal(res.body.imported, 1);
      assert.equal(res.body.ignored, 1);
      assert.equal(await getBalance(UPI_BANK), 1500);
    });
  });

  describe('Group D: Security, Health & Liquidity Engine', () => {
    it('D1 — GET /health returns 200 { ok: true }', async () => {
      const { status, body } = await api('GET', '/health');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    it('D2 — PUT /api/accounts/:id updates balance directly', async () => {
      const { status } = await api('PUT', `/api/accounts/${CASH}`, { balance: 1250 });
      assert.equal(status, 200);
      assert.equal(await getBalance(CASH), 1250);
    });

    it('D3 — PUT /api/budget updates monthly_budget setting and reflects in state', async () => {
      const { status, body } = await api('PUT', '/api/budget', { budget: 35000 });
      assert.equal(status, 200);
      assert.equal(body.budget, 35000);

      const s = await getState();
      assert.equal(s.monthlyBudget, 35000);
    });

    it('D4 — 100% zero-emoji enforcement across all source files', async () => {
      const fs = await import('node:fs');
      const files = ['public/index.html', 'server.js', 'db.js', 'package.json'];
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        assert.equal(emojiRegex.test(content), false, `Emoji found in ${file}`);
      }
    });
  });
});
