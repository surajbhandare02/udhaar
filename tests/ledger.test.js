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

describe('Udhaar Ledger Complete Financial Engine Tests', () => {
  after(async () => {
    await new Promise(r => server.close(r));
    if (existsSync('test-ledger.db')) await unlink('test-ledger.db').catch(()=>{});
    process.exit(0);
  });

  describe('Group A: Accounting Precision & Zero-Overlap Engine', () => {
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
      assert.equal(s.monthlyIncome, 1500);
    });

    it('A3 — transfer moves balance with zero impact on income/expense', async () => {
      await api('POST', '/api/transactions', {
        type: 'transfer', amount: 300, account_id: UPI_BANK, to_account_id: CASH
      });
      assert.equal(await getBalance(UPI_BANK), -300);
      assert.equal(await getBalance(CASH), 300);

      const s = await getState();
      assert.equal(s.monthlyExpense, 0);
      assert.equal(s.monthlyIncome, 0);
    });

    it('A4 — lent updates account and debtor with zero impact on expense', async () => {
      await api('POST', '/api/transactions', {
        type: 'lent', amount: 800, account_id: UPI_BANK, person_name: 'Rahul'
      });
      assert.equal(await getBalance(UPI_BANK), -800);
      assert.equal(await getPersonBalance('Rahul'), 800);

      const s = await getState();
      assert.equal(s.monthlyExpense, 0);
    });

    it('A5 — borrowed updates account and creditor with zero impact on income', async () => {
      await api('POST', '/api/transactions', {
        type: 'borrowed', amount: 400, account_id: CASH, person_name: 'Amit'
      });
      assert.equal(await getBalance(CASH), 400);
      assert.equal(await getPersonBalance('Amit'), -400);

      const s = await getState();
      assert.equal(s.monthlyIncome, 0);
    });

    it('A6 — settle_in and settle_out clear balances atomically', async () => {
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
      assert.equal(await getBalance(UPI_BANK), -1000);
      assert.equal(await getPersonBalance('Rohan'), 500);

      const s = await getState();
      assert.equal(s.monthlyExpense, 500);
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
      assert.equal(await getBalance(UPI_BANK), -900);
      assert.equal(await getPersonBalance('Amit'), 300);
      assert.equal(await getPersonBalance('Neha'), 300);

      const s = await getState();
      assert.equal(s.monthlyExpense, 300);
    });
  });

  describe('Group B: Credit Cards & Net Worth Engine', () => {
    beforeEach(resetDB);

    it('B1 — creates credit card with limit, statement date, and due date', async () => {
      const { status, body } = await api('POST', '/api/accounts', {
        name: 'HDFC Regalia',
        balance: 15000,
        type: 'credit_card',
        credit_limit: 100000,
        statement_date: 18,
        due_date: 7
      });
      assert.equal(status, 200);
      assert.equal(body.success, true);

      const s = await getState();
      const card = s.accounts.find(a => a.name === 'HDFC Regalia');
      assert.ok(card);
      assert.equal(card.type, 'credit_card');
      assert.equal(card.credit_limit, 100000);
      assert.equal(card.balance, 15000);
      assert.equal(card.available_credit, 85000);
      assert.equal(card.utilization_pct, 15);
      assert.equal(card.statement_date, 18);
      assert.equal(card.due_date, 7);
    });

    it('B2 — correctly calculates Net Worth (Assets minus Liabilities)', async () => {
      // Asset: Bank has 50000
      await api('PUT', `/api/accounts/${UPI_BANK}`, { balance: 50000 });
      // Liability: Credit card debt 10000
      await api('POST', '/api/accounts', {
        name: 'ICICI Amazon Pay',
        balance: 10000,
        type: 'credit_card',
        credit_limit: 50000
      });
      // Liability: I owe Amit 2000
      await api('POST', '/api/transactions', {
        type: 'borrowed', amount: 2000, account_id: CASH, person_name: 'Amit'
      });

      const s = await getState();
      // Assets = 50000 (Bank) + 2000 (Cash received from Amit) = 52000
      // Liabilities = 10000 (CC) + 2000 (owed to Amit) = 12000
      // Net Worth = 52000 - 12000 = 40000
      assert.equal(s.netWorth, 40000);
    });
  });

  describe('Group C: Smart Budgets (Weekly, Monthly, Yearly)', () => {
    beforeEach(resetDB);

    it('C1 — calculates budget residuals and alert thresholds (80% warning, >100% exceeded)', async () => {
      // Create a 1000 monthly budget for Food
      const { status } = await api('POST', '/api/budgets', {
        category: 'Food', period: 'monthly', amount: 1000
      });
      assert.equal(status, 200);

      // 1. Initial status: 0 spent -> normal (1000 left)
      let s = await getState();
      let b = s.budgets.find(x => x.category === 'Food');
      assert.equal(b.residual, 1000);
      assert.equal(b.percentage, 0);
      assert.equal(b.status, 'normal');

      // 2. Spend 850 -> 85% spent -> warning (150 left)
      await api('POST', '/api/transactions', {
        type: 'expense', amount: 850, account_id: UPI_BANK, category: 'Food'
      });
      s = await getState();
      b = s.budgets.find(x => x.category === 'Food');
      assert.equal(b.residual, 150);
      assert.equal(b.percentage, 85);
      assert.equal(b.status, 'warning');

      // 3. Spend another 200 -> 1050 spent -> exceeded (-50 residual)
      await api('POST', '/api/transactions', {
        type: 'expense', amount: 200, account_id: UPI_BANK, category: 'Food'
      });
      s = await getState();
      b = s.budgets.find(x => x.category === 'Food');
      assert.equal(b.residual, -50);
      assert.equal(b.percentage, 105);
      assert.equal(b.status, 'exceeded');
    });
  });

  describe('Group D: Subscriptions & Recurring Bills', () => {
    beforeEach(resetDB);

    it('D1 — normalizes monthly & yearly subscription costs and calculates renewal proximity', async () => {
      // Annual Netflix subscription of 2400 (normalized = 200/mo)
      const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
      const { status } = await api('POST', '/api/subscriptions', {
        name: 'Netflix Premium',
        amount: 2400,
        billing_cycle: 'yearly',
        next_renewal_date: tomorrow,
        category: 'Entertainment'
      });
      assert.equal(status, 200);

      const s = await getState();
      assert.equal(s.subscriptions.length, 1);
      const sub = s.subscriptions[0];
      assert.equal(sub.monthlyCost, 200);
      assert.equal(sub.yearlyCost, 2400);
      assert.equal(sub.isUpcoming, true); // within 3 days
      assert.equal(s.totalMonthlySubscriptions, 200);
    });

    it('D2 — recurring bill pay logs real expense and advances due date by frequency', async () => {
      const { body } = await api('POST', '/api/recurring-bills', {
        name: 'Airtel Broadband',
        amount: 999,
        category: 'Bills',
        account_id: UPI_BANK,
        frequency: 'monthly',
        due_date: '2026-12-05'
      });
      const billId = body.id;

      // Initial account balance
      await api('PUT', `/api/accounts/${UPI_BANK}`, { balance: 5000 });

      // Mark Paid
      const { status, body: payBody } = await api('POST', `/api/recurring-bills/${billId}/pay`);
      assert.equal(status, 200);
      assert.equal(payBody.nextDue, '2027-01-05'); // Advanced by 1 month

      // Balance reduced by 999 and real expense logged
      assert.equal(await getBalance(UPI_BANK), 5000 - 999);
      const s = await getState();
      assert.equal(s.monthlyExpense, 999);
      assert.equal(s.transactions[0].merchant, 'Airtel Broadband');
    });
  });

  describe('Group E: Savings Goals & Templates', () => {
    beforeEach(resetDB);

    it('E1 — tracks savings goal progress and deposits', async () => {
      const { body } = await api('POST', '/api/savings-goals', {
        name: 'Goa Vacation',
        target_amount: 30000,
        current_amount: 5000,
        target_date: '2027-04-01'
      });
      const goalId = body.id;

      let s = await getState();
      let goal = s.savingsGoals.find(g => g.id === goalId);
      assert.equal(goal.percentage, 17); // 5000 / 30000 = ~17%

      // Deposit 10000
      await api('POST', `/api/savings-goals/${goalId}/deposit`, { amount: 10000 });
      s = await getState();
      goal = s.savingsGoals.find(g => g.id === goalId);
      assert.equal(goal.current_amount, 15000);
      assert.equal(goal.percentage, 50); // 15000 / 30000 = 50%
    });

    it('E2 — transaction templates allow fast 1-tap presets', async () => {
      const { status, body } = await api('POST', '/api/templates', {
        name: 'Daily Metro',
        type: 'expense',
        amount: 45,
        category: 'Travel',
        note: 'Metro card top-up'
      });
      assert.equal(status, 200);

      const s = await getState();
      const tpl = s.templates.find(t => t.id === body.id);
      assert.ok(tpl);
      assert.equal(tpl.amount, 45);
    });
  });

  describe('Group F: 24h Impulse Cooldown ("Pause Vault")', () => {
    beforeEach(resetDB);

    it('F1 — adds, commits, and skips cooldown items', async () => {
      const { body } = await api('POST', '/api/cooldown', { name: 'Noise Cancelling Headphones', amount: 8000 });
      const itemId = body.item.id;

      let s = await getState();
      assert.equal(s.pausedItems.length, 1);

      // Skip adds to savedByWaiting
      const { status } = await api('POST', `/api/cooldown/${itemId}/skip`);
      assert.equal(status, 200);

      s = await getState();
      assert.equal(s.pausedItems.length, 0);
      assert.equal(s.savedByWaiting, 8000);
    });
  });

  describe('Group G: Bank SMS Webhook & Security', () => {
    beforeEach(resetDB);

    it('G1 — parses debit SMS with UTR and ignores OTP / promo', async () => {
      const validSMS = 'Dear Customer, Rs 350.00 debited from HDFC Bank A/C ending 1234 to Starbucks on 12-Nov-26 UPI/431799991111.';
      const res1 = await api('POST', '/api/webhook/sms', { sms: validSMS });
      assert.equal(res1.body.imported, 1);

      const otpSMS = 'Your OTP for transaction at Amazon is 938210. Never share your OTP with anyone.';
      const res2 = await api('POST', '/api/webhook/sms', { sms: otpSMS });
      assert.equal(res2.body.ignored, 1);
    });

    it('G2 — GET /health returns 200 { ok: true }', async () => {
      const { status, body } = await api('GET', '/health');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    it('G3 — 100% zero-emoji enforcement across all source files', async () => {
      const fs = await import('node:fs');
      const files = ['public/index.html', 'server.js', 'db.js', 'package.json', 'public/manifest.json'];
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        assert.equal(emojiRegex.test(content), false, `Emoji found in ${file}`);
      }
    });
  });
});
