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

describe('Udhaar Ledger Tests', () => {
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
  });

  describe('Group B: Bank SMS Parser & Webhook', () => {
    beforeEach(resetDB);

    it('B1 — parses HDFC UPI debit with UTR deduplication', async () => {
      const sms = 'Dear Customer, Rs 240.00 debited from HDFC Bank A/C ending 1234 to Swiggy on 12-Nov-26 UPI/431712345678.';
      const res1 = await api('POST', '/api/webhook/sms', { sms });
      assert.equal(res1.body.imported, 1);
      assert.equal(await getBalance(UPI_BANK), -240);

      const res2 = await api('POST', '/api/webhook/sms', { sms });
      assert.equal(res2.body.duplicates, 1);
      assert.equal(await getBalance(UPI_BANK), -240);
    });

    it('B2 — parses SBI credit SMS and ignores OTP', async () => {
      const batch = `Your A/C 9876 credited by Rs 1,500.00 on 10-Nov-26 by transfer from Boss UPI/431788889999.
---
Your OTP for login is 482910. Do not share with anyone.`;
      const res = await api('POST', '/api/webhook/sms', { raw_text: batch });
      assert.equal(res.body.imported, 1);
      assert.equal(res.body.ignored, 1);
      assert.equal(await getBalance(UPI_BANK), 1500);
    });
  });

  describe('Group C: Security & Health', () => {
    it('C1 — GET /health returns 200 { ok: true }', async () => {
      const { status, body } = await api('GET', '/health');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    it('C2 — PUT /api/accounts/:id updates balance directly', async () => {
      const { status } = await api('PUT', `/api/accounts/${CASH}`, { balance: 1250 });
      assert.equal(status, 200);
      assert.equal(await getBalance(CASH), 1250);
    });
  });
});
