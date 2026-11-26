/**
 * Udhaar Ledger — Automated Test Suite
 *
 * Uses ONLY Node.js built-ins:
 *   node:test          — test runner (describe / it / before / after / beforeEach)
 *   node:assert/strict — assertion library
 *   node:child_process — spawn test server
 *   node:fs/promises   — cleanup
 *
 * Run:
 *   node --test tests/ledger.test.js
 *
 * The suite spins up a real HTTP server against a temporary SQLite file
 * (test-ledger.db) so production data is never touched.
 * Every test resets the DB via POST /api/test/reset before it runs.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Configuration ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');          // project root (server.js lives here)
const TEST_DB   = path.join(ROOT, 'test-ledger.db');   // isolated DB for this run
const TEST_PORT = 3099;                                // avoids clash with prod server on 3000
const BASE      = `http://localhost:${TEST_PORT}`;

// Well-known account IDs (guaranteed by the reset + re-seed logic)
const UPI_BANK = 1;
const CASH     = 2;
// const SAVINGS = 3;  // available if needed

// ─── Helper: HTTP client ──────────────────────────────────────────────────────

/**
 * Thin fetch wrapper. Returns { status, body } where body is the parsed JSON
 * (or null if the response is not JSON).
 */
async function api(method, endpoint, payload) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (payload !== undefined) opts.body = JSON.stringify(payload);
  const res  = await fetch(`${BASE}${endpoint}`, opts);
  let   body = null;
  try { body = await res.json(); } catch { /* non-JSON (CSV, etc.) */ }
  return { status: res.status, body };
}

// ─── Helper: DB state queries ─────────────────────────────────────────────────

/** Returns the current balance of a given account id. */
async function getBalance(accountId) {
  const { body } = await api('GET', '/api/summary');
  return body.accounts.find(a => a.id === accountId)?.balance ?? null;
}

/** Returns this month's { expense, income } totals. */
async function getMonthly() {
  const { body } = await api('GET', '/api/summary');
  return body.monthly;
}

/** Returns the people record matching name (case-insensitive), or null. */
async function getPerson(name) {
  const { body } = await api('GET', '/api/people');
  return body.find(p => p.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Returns the total number of transaction rows in the DB. */
async function txCount() {
  const { body } = await api('GET', '/api/transactions');
  return body.total;
}

// ─── DB Reset ─────────────────────────────────────────────────────────────────

/**
 * Clears all data and re-seeds default accounts (IDs restart at 1, 2, 3).
 * Called in beforeEach of every describe block.
 */
async function resetDB() {
  const { status } = await api('POST', '/api/test/reset');
  assert.equal(status, 200, 'DB reset must succeed — is NODE_ENV=test set on the server?');
}

// ─── Server Lifecycle ─────────────────────────────────────────────────────────

let srv; // child process handle

before(async () => {
  // Remove any stale test DB from a previous interrupted run
  if (existsSync(TEST_DB)) await unlink(TEST_DB);

  srv = spawn('node', ['server.js'], {
    cwd:   ROOT,
    env:   { ...process.env, PORT: String(TEST_PORT), DB_PATH: TEST_DB, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Surface server logs with a prefix so they're easy to spot
  srv.stdout.on('data', d => process.stdout.write(`\x1b[2m[srv] ${d}\x1b[0m`));
  srv.stderr.on('data', d => process.stderr.write(`\x1b[31m[srv:err] ${d}\x1b[0m`));

  // Wait until the server is ready (max 10 s)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/summary`);
      if (r.ok) return; // server is up
    } catch { /* still starting */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Test server did not become ready within 10 seconds');
});

after(async () => {
  if (srv) {
    srv.kill('SIGTERM');
    await new Promise(resolve => srv.once('exit', resolve));
  }
  if (existsSync(TEST_DB)) await unlink(TEST_DB);
});

// =============================================================================
// GROUP A: Zero-Overlap Accounting Math
// =============================================================================

describe('Group A: Zero-Overlap Accounting Math', () => {
  beforeEach(resetDB);

  // ── A1: Expense ─────────────────────────────────────────────────────────────
  it('A1a — expense reduces UPI/Bank balance by exact amount', async () => {
    const before = await getBalance(UPI_BANK); // 0 after reset

    const { status, body: tx } = await api('POST', '/api/transactions', {
      type: 'expense', amount: 500, account_id: UPI_BANK, category: 'Food', merchant: 'Test',
    });

    assert.equal(status, 201, 'should create with 201');
    assert.equal(tx.amount, 500);
    assert.equal(await getBalance(UPI_BANK), before - 500, 'UPI/Bank must decrease by ₹500');
  });

  it('A1b — expense adds to Monthly Expense and leaves Monthly Income at ₹0', async () => {
    await api('POST', '/api/transactions', {
      type: 'expense', amount: 500, account_id: UPI_BANK, category: 'Food',
    });

    const { expense, income } = await getMonthly();
    assert.equal(expense, 500, 'Monthly Expense must be ₹500');
    assert.equal(income,  0,   'Monthly Income must stay ₹0');
  });

  // ── A1: Income ───────────────────────────────────────────────────────────────
  it('A1c — income increases UPI/Bank balance by exact amount', async () => {
    const before = await getBalance(UPI_BANK);

    const { status } = await api('POST', '/api/transactions', {
      type: 'income', amount: 2000, account_id: UPI_BANK, category: 'Salary',
    });

    assert.equal(status, 201);
    assert.equal(await getBalance(UPI_BANK), before + 2000, 'UPI/Bank must increase by ₹2000');
  });

  it('A1d — income adds to Monthly Income and leaves Monthly Expense at ₹0', async () => {
    await api('POST', '/api/transactions', {
      type: 'income', amount: 2000, account_id: UPI_BANK, category: 'Salary',
    });

    const { expense, income } = await getMonthly();
    assert.equal(income,  2000, 'Monthly Income must be ₹2000');
    assert.equal(expense, 0,    'Monthly Expense must stay ₹0');
  });

  // ── A2: Self-Transfer Isolation ──────────────────────────────────────────────
  it('A2 — transfer of ₹1000 from UPI/Bank to Cash adjusts both balances, expense=income=0', async () => {
    const bankBefore = await getBalance(UPI_BANK);
    const cashBefore = await getBalance(CASH);

    const { status } = await api('POST', '/api/transactions', {
      type: 'transfer', amount: 1000, account_id: UPI_BANK, to_account_id: CASH,
    });

    assert.equal(status, 201);
    assert.equal(await getBalance(UPI_BANK), bankBefore - 1000, 'UPI/Bank must decrease by ₹1000');
    assert.equal(await getBalance(CASH),     cashBefore + 1000, 'Cash must increase by ₹1000');

    const { expense, income } = await getMonthly();
    assert.equal(expense, 0, 'transfer must NOT touch Monthly Expense');
    assert.equal(income,  0, 'transfer must NOT touch Monthly Income');
  });

  // ── A3: Lent & Borrowed ──────────────────────────────────────────────────────
  it('A3a — lent ₹800 to Rahul: UPI/Bank -800, Rahul.net_balance=+800, expense=0', async () => {
    const bankBefore = await getBalance(UPI_BANK);

    const { status } = await api('POST', '/api/transactions', {
      type: 'lent', amount: 800, account_id: UPI_BANK, person_name: 'Rahul',
    });

    assert.equal(status, 201);
    assert.equal(await getBalance(UPI_BANK), bankBefore - 800, 'UPI/Bank must decrease by ₹800');

    const rahul = await getPerson('Rahul');
    assert.ok(rahul, 'Rahul must be auto-created');
    assert.equal(rahul.net_balance, 800, 'Rahul owes me ₹800 (positive = they owe me)');

    const { expense, income } = await getMonthly();
    assert.equal(expense, 0, 'lent must NOT count as expense');
    assert.equal(income,  0, 'lent must NOT count as income');
  });

  it('A3b — borrowed ₹300 from Amit: Cash +300, Amit.net_balance=-300, income=0', async () => {
    const cashBefore = await getBalance(CASH);

    const { status } = await api('POST', '/api/transactions', {
      type: 'borrowed', amount: 300, account_id: CASH, person_name: 'Amit',
    });

    assert.equal(status, 201);
    assert.equal(await getBalance(CASH), cashBefore + 300, 'Cash must increase by ₹300');

    const amit = await getPerson('Amit');
    assert.ok(amit, 'Amit must be auto-created');
    assert.equal(amit.net_balance, -300, 'I owe Amit ₹300 (negative = I owe them)');

    const { expense, income } = await getMonthly();
    assert.equal(income,  0, 'borrowed must NOT count as income');
    assert.equal(expense, 0, 'borrowed must NOT count as expense');
  });

  // ── A4: Settlements ──────────────────────────────────────────────────────────
  it('A4a — settle_in ₹500 from Rahul: Cash +500, Rahul.net_balance 800→300, income=0', async () => {
    // Setup: lend 800 to Rahul
    await api('POST', '/api/transactions', {
      type: 'lent', amount: 800, account_id: UPI_BANK, person_name: 'Rahul',
    });
    const rahulMid  = await getPerson('Rahul');
    const cashBefore = await getBalance(CASH);

    // Rahul pays back 500 in cash
    const { status } = await api('POST', '/api/transactions', {
      type: 'settle_in', amount: 500, account_id: CASH, person_name: 'Rahul',
    });

    assert.equal(status, 201);
    assert.equal(await getBalance(CASH), cashBefore + 500, 'Cash must increase by ₹500');

    const rahulAfter = await getPerson('Rahul');
    assert.equal(
      rahulAfter.net_balance,
      rahulMid.net_balance - 500,
      'Rahul net_balance must decrease by ₹500'
    );
    assert.equal(rahulAfter.net_balance, 300, 'Rahul still owes me ₹300');

    // Settlements must NOT appear in monthly income
    const { income } = await getMonthly();
    assert.equal(income, 0, 'settle_in must NOT count as income');
  });

  it('A4b — settle_out ₹300 to Amit: UPI/Bank -300, Amit.net_balance -300→0, expense=0', async () => {
    // Setup: borrow 300 from Amit
    await api('POST', '/api/transactions', {
      type: 'borrowed', amount: 300, account_id: UPI_BANK, person_name: 'Amit',
    });
    const bankBefore = await getBalance(UPI_BANK);

    // Pay Amit back
    const { status } = await api('POST', '/api/transactions', {
      type: 'settle_out', amount: 300, account_id: UPI_BANK, person_name: 'Amit',
    });

    assert.equal(status, 201);
    assert.equal(await getBalance(UPI_BANK), bankBefore - 300, 'UPI/Bank must decrease by ₹300');

    const amit = await getPerson('Amit');
    assert.equal(amit.net_balance, 0, 'Amit is fully settled');

    const { expense } = await getMonthly();
    assert.equal(expense, 0, 'settle_out must NOT count as expense');
  });

  // ── A5: Atomic Delete Reversal ───────────────────────────────────────────────
  it('A5a — deleting a lent transaction cleanly reverses both account and person balances', async () => {
    // Create the lent transaction
    const { body: lentTx } = await api('POST', '/api/transactions', {
      type: 'lent', amount: 800, account_id: UPI_BANK, person_name: 'Rahul',
    });
    const bankAfterLend  = await getBalance(UPI_BANK);
    const rahulAfterLend = await getPerson('Rahul');

    // Delete it
    const { status } = await api('DELETE', `/api/transactions/${lentTx.id}`);
    assert.equal(status, 200);

    // Balance must be restored (increases by 800 since lend had decreased it)
    assert.equal(
      await getBalance(UPI_BANK),
      bankAfterLend + 800,
      'UPI/Bank must revert: +₹800 back'
    );

    // Rahul's net_balance must be restored to 0
    const rahulAfterDel = await getPerson('Rahul');
    assert.equal(
      rahulAfterDel.net_balance,
      rahulAfterLend.net_balance - 800,
      'Rahul net_balance must revert: -₹800'
    );
    assert.equal(rahulAfterDel.net_balance, 0);
  });

  it('A5b — deleting a transfer cleanly reverses both account balances to exact prior values', async () => {
    const bankBefore = await getBalance(UPI_BANK);
    const cashBefore = await getBalance(CASH);

    const { body: transferTx } = await api('POST', '/api/transactions', {
      type: 'transfer', amount: 1000, account_id: UPI_BANK, to_account_id: CASH,
    });

    // Verify transfer applied correctly
    assert.equal(await getBalance(UPI_BANK), bankBefore - 1000);
    assert.equal(await getBalance(CASH),     cashBefore + 1000);

    // Delete and verify full reversal
    const { status } = await api('DELETE', `/api/transactions/${transferTx.id}`);
    assert.equal(status, 200);

    assert.equal(await getBalance(UPI_BANK), bankBefore, 'UPI/Bank must return to pre-transfer value');
    assert.equal(await getBalance(CASH),     cashBefore, 'Cash must return to pre-transfer value');
  });
});

// =============================================================================
// GROUP B: Indian Bank SMS Regex Parser
// =============================================================================

describe('Group B: Indian Bank SMS Regex Parser', () => {
  beforeEach(resetDB);

  it('B1 — HDFC UPI debit: type=expense, amount=240, category=Food, UTR captured', async () => {
    const sms = "Rs.240.00 debited from a/c **1234 on 26-11-26 to VPA swiggy@icici (UPI Ref No 633012345678).";

    const { status, body } = await api('POST', '/api/webhook/sms', { message: sms });

    assert.equal(status, 201,         'HDFC debit SMS must create a transaction');
    assert.equal(body.status,         'created');
    assert.equal(body.transaction.type,     'expense', 'debited → expense');
    assert.equal(body.transaction.amount,   240,       'amount must be 240');
    assert.equal(body.transaction.category, 'Food',    'swiggy → Food category');
    assert.equal(body.transaction.utr_ref,  '633012345678', 'UTR must be captured');
  });

  it('B2 — SBI UPI credit: type=income, amount=1500, UTR captured', async () => {
    const sms = "Dear UPI user A/C X5678 credited by Rs 1500.00 on 26Nov26 transfer from RAHUL SHARMA Ref No 633098765432 -SBI";

    const { status, body } = await api('POST', '/api/webhook/sms', { message: sms });

    assert.equal(status, 201,          'SBI credit SMS must create a transaction');
    assert.equal(body.status,          'created');
    assert.equal(body.transaction.type,   'income',       'credited → income');
    assert.equal(body.transaction.amount, 1500,            'amount must be 1500');
    assert.equal(body.transaction.utr_ref, '633098765432', 'UTR must be captured');
  });

  it('B3 — ICICI merchant spend: type=expense, amount=1299.5, category=Shopping', async () => {
    const sms = "ICICI Bank Acct XX890 debited for Rs 1,299.50 on 26-Nov-26; AMAZON SELLER SERVICES credited. UPI:633055544433.";

    const { status, body } = await api('POST', '/api/webhook/sms', { message: sms });

    assert.equal(status, 201, 'ICICI debit SMS must create a transaction');
    assert.equal(body.status, 'created');
    assert.equal(body.transaction.type,     'expense',  'debited → expense (debit wins when both present)');
    assert.equal(body.transaction.amount,   1299.5,     'comma-formatted amount must parse to 1299.5');
    assert.equal(body.transaction.category, 'Shopping', 'AMAZON → Shopping category');
  });

  it('B4 — OTP / PIN message is unrecognized, zero rows inserted, balances unchanged', async () => {
    const sms = "849201 is your OTP for transaction of Rs. 5000.00 at Flipkart. Do not share with anyone.";
    const balBefore = await getBalance(UPI_BANK);

    const { body } = await api('POST', '/api/webhook/sms', { message: sms });

    assert.ok(['ignored', 'unrecognized'].includes(body.status), 'OTP SMS must be rejected as ignored or unrecognized');
    assert.equal(await txCount(), 0,          'no transaction row must be created');
    assert.equal(await getBalance(UPI_BANK), balBefore, 'account balance must remain unchanged');
  });
});

// =============================================================================
// GROUP C: Anti-Duplicate & Offline Catch-Up Sync
// =============================================================================

describe('Group C: Anti-Duplicate & Offline Catch-Up Sync', () => {
  beforeEach(resetDB);

  // Canonical HDFC SMS used across C-group tests
  const HDFC_SMS =
    "Rs.500.00 debited from a/c **1234 on 26-11-26 to VPA test@icici (UPI Ref No 633000111222).";

  it('C1 — UTR deduplication: second identical SMS is rejected, account debited only once', async () => {
    // First POST — must succeed
    const r1 = await api('POST', '/api/webhook/sms', { message: HDFC_SMS });
    assert.equal(r1.status,      201,       'first SMS must be created (201)');
    assert.equal(r1.body.status, 'created', 'first result must be "created"');

    // Second POST — same UTR — must be rejected as duplicate
    const r2 = await api('POST', '/api/webhook/sms', { message: HDFC_SMS });
    assert.equal(r2.body.status,     'duplicate', 'second result must be "duplicate"');
    assert.equal(r2.body.duplicate,  true,         'duplicate flag must be true');

    // Only one transaction must exist in the DB
    assert.equal(await txCount(), 1, 'exactly 1 transaction row must exist (not 2)');

    // UPI/Bank balance should reflect only one debit of ₹500
    assert.equal(await getBalance(UPI_BANK), -500, 'UPI/Bank must be debited exactly once');
  });

  it('C2 — 3-minute fuzzy dedup: SMS without UTR with same (amount, type) is saved only once', async () => {
    // A realistic balance-alert SMS — no Ref/UPI number
    const noUtrSMS =
      "Your HDFC bank account has been debited Rs 200.00. Available balance: Rs 4800.00.";

    const r1 = await api('POST', '/api/webhook/sms', { message: noUtrSMS });
    assert.equal(r1.status,      201,       'first SMS without UTR must be created');
    assert.equal(r1.body.status, 'created');

    const r2 = await api('POST', '/api/webhook/sms', { message: noUtrSMS });
    assert.equal(r2.body.status, 'duplicate',
      'second identical SMS without UTR must be caught by fuzzy (amount+type+3-min) dedup');

    assert.equal(await txCount(), 1, 'only 1 transaction row must exist');
  });

  it('C3 — batch sync: 4 messages → imported=2, duplicates=1, ignored=1', async () => {
    // Pre-log the HDFC_SMS so it becomes a duplicate in the batch
    const pre = await api('POST', '/api/webhook/sms', { message: HDFC_SMS });
    assert.equal(pre.status, 201, 'pre-log must succeed');

    const messages = [
      // ① duplicate — UTR 633000111222 already in DB
      HDFC_SMS,
      // ② new income — SBI credit with fresh UTR
      "Dear UPI user A/C X9999 credited by Rs 3000.00 on 26Nov26 transfer from FRIEND Ref No 633111222333 -SBI",
      // ③ new expense — Uber with fresh UTR
      "Rs.150.00 debited from a/c **5555 on 26-11-26 to VPA uber@upi (UPI Ref No 633444555666).",
      // ④ promotional spam — no Rs/INR → parseSMS returns null → ignored
      "Congratulations! You have won a prize. Click here to claim your reward.",
    ];

    const { status, body } = await api('POST', '/api/webhook/batch', { messages });

    assert.equal(status, 200, 'batch endpoint must return 200');
    assert.ok(body.summary,          'response must include a summary object');
    assert.equal(body.summary.imported,   2, 'exactly 2 messages must be imported');
    assert.equal(body.summary.duplicates, 1, 'exactly 1 message must be a duplicate');
    assert.equal(body.summary.ignored,    1, 'exactly 1 message must be ignored/unrecognized');

    // Total in DB: 1 pre-logged + 2 from batch = 3
    assert.equal(await txCount(), 3, 'DB must contain exactly 3 transaction rows');
  });
});

// =============================================================================
// GROUP D: Edge Cases & Input Validation
// =============================================================================

describe('Group D: Edge Cases & Input Validation', () => {
  beforeEach(resetDB);

  // ── D1: Amount Validation ────────────────────────────────────────────────────
  it('D1a — negative amount is rejected with HTTP 400', async () => {
    const { status, body } = await api('POST', '/api/transactions', {
      type: 'expense', amount: -100, account_id: UPI_BANK, category: 'Food',
    });
    assert.equal(status, 400, 'negative amount must return 400');
    assert.ok(body.error, 'response must include an error message');
  });

  it('D1b — zero amount is rejected with HTTP 400', async () => {
    const { status, body } = await api('POST', '/api/transactions', {
      type: 'expense', amount: 0, account_id: UPI_BANK, category: 'Food',
    });
    assert.equal(status, 400, 'zero amount must return 400');
    assert.ok(body.error);
  });

  it('D1c — non-numeric string amount is rejected with HTTP 400', async () => {
    const { status, body } = await api('POST', '/api/transactions', {
      type: 'expense', amount: 'abc', account_id: UPI_BANK, category: 'Food',
    });
    assert.equal(status, 400, 'string amount must return 400');
    assert.ok(body.error);
  });

  // ── D2: Transfer Same-Account Guard ──────────────────────────────────────────
  it('D2 — transfer where account_id === to_account_id is rejected with HTTP 400', async () => {
    const { status, body } = await api('POST', '/api/transactions', {
      type: 'transfer', amount: 500, account_id: UPI_BANK, to_account_id: UPI_BANK,
    });
    assert.equal(status, 400, 'self-transfer must return 400');
    assert.ok(body.error, 'response must include an error message');
  });

  // ── D3: Person Required for Lent / Borrowed ───────────────────────────────────
  it('D3a — lent without person_name or person_id is rejected with HTTP 400', async () => {
    const { status, body } = await api('POST', '/api/transactions', {
      type: 'lent', amount: 500, account_id: UPI_BANK,
      // deliberately omit person_name and person_id
    });
    assert.equal(status, 400, 'lent without person must return 400');
    assert.ok(body.error);
  });

  it('D3b — borrowed without person_name or person_id is rejected with HTTP 400', async () => {
    const { status, body } = await api('POST', '/api/transactions', {
      type: 'borrowed', amount: 500, account_id: CASH,
      // deliberately omit person_name and person_id
    });
    assert.equal(status, 400, 'borrowed without person must return 400');
    assert.ok(body.error);
  });

  // ── D4: Case-Insensitive Person Matching ──────────────────────────────────────
  it('D4 — "rahul" and "Rahul" map to the same people record (no duplicate person rows)', async () => {
    // First transaction: "rahul" (lowercase)
    await api('POST', '/api/transactions', {
      type: 'lent', amount: 100, account_id: UPI_BANK, person_name: 'rahul',
    });
    // Second transaction: "Rahul" (PascalCase)
    await api('POST', '/api/transactions', {
      type: 'lent', amount: 200, account_id: UPI_BANK, person_name: 'Rahul',
    });

    const { body: people } = await api('GET', '/api/people');

    // Only ONE person entry for "rahul" / "Rahul"
    const rahulEntries = people.filter(p => p.name.toLowerCase() === 'rahul');
    assert.equal(
      rahulEntries.length, 1,
      'case variants of the same name must map to exactly one person record'
    );

    // Both lend amounts must be reflected in that single record (100 + 200 = 300)
    assert.equal(
      rahulEntries[0].net_balance, 300,
      'combined net_balance must be ₹300 (both lent amounts on the same person)'
    );
  });
});

// =============================================================================
// GROUP E: iPhone 14 Shortcuts & Offline Sync Endpoints
// =============================================================================

describe('Group E: iPhone 14 Shortcuts & Offline Sync Endpoints', () => {
  beforeEach(resetDB);

  it('E1 — POST /api/webhook/sms with custom account', async () => {
    const sms = "Rs.750.00 debited from your card on 26-11-26 to VPA supermarket@upi Ref No 987654321012";
    const { status, body } = await api('POST', '/api/webhook/sms', {
      message: sms,
      account: 'Cash'
    });

    assert.equal(status, 201);
    assert.equal(body.status, 'created');
    assert.equal(body.transaction.amount, 750);
    assert.equal(body.transaction.account_id, CASH);
    assert.equal(await getBalance(CASH), -750);
  });

  it('E2 — POST /api/webhook/sms returns HTTP 200 { status: "ignored", reason: "otp_or_non_tx" } for OTP, balance alert & failed SMS', async () => {
    const otpSMS = "Dear customer, 654321 is your OTP for transaction of Rs. 999.00 at Swiggy. Do not share.";
    const r1 = await api('POST', '/api/webhook/sms', { message: otpSMS });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.status, 'ignored');
    assert.equal(r1.body.reason, 'otp_or_non_tx');

    const balSMS = "Your account balance for a/c **1234 is Rs. 15,400.00 as of 26-Nov-2026.";
    const r2 = await api('POST', '/api/webhook/sms', { message: balSMS });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.status, 'ignored');
    assert.equal(r2.body.reason, 'otp_or_non_tx');

    const failSMS = "Transaction failed for Rs. 250.00 to VPA cafe@upi due to bank network error.";
    const r3 = await api('POST', '/api/webhook/sms', { message: failSMS });
    assert.equal(r3.status, 200);
    assert.equal(r3.body.status, 'ignored');
    assert.equal(r3.body.reason, 'otp_or_non_tx');

    assert.equal(await txCount(), 0, 'no transaction should be logged for ignored SMS');
  });

  it('E3 — POST /api/webhook/batch with raw_text (--- separated)', async () => {
    const raw_text = `
Rs.350.00 debited from a/c **1234 on 26-11-26 to VPA chai@upi Ref No 112233445566.
---
Rs.1200.00 credited to a/c **1234 on 26-11-26 from VPA client@upi Ref No 998877665544.
---
849201 is your OTP for transaction of Rs. 5000.00. Do not share.
---
Rs.350.00 debited from a/c **1234 on 26-11-26 to VPA chai@upi Ref No 112233445566.
`;

    const { status, body } = await api('POST', '/api/webhook/batch', { raw_text });
    assert.equal(status, 200);
    assert.equal(body.imported, 2, '2 new transactions imported');
    assert.equal(body.duplicates, 1, '1 duplicate skipped');
    assert.equal(body.ignored, 1, '1 OTP ignored');
    assert.equal(await txCount(), 2);
  });

  it('E4 — POST /api/quick with mode=cash_expense logs cash expense', async () => {
    const cashBefore = await getBalance(CASH);
    const { status, body } = await api('POST', '/api/quick', {
      mode: 'cash_expense',
      amount: 150,
      category: 'Food',
      note: 'Chai and Samosa'
    });

    assert.equal(status, 201);
    assert.equal(body.success, true);
    assert.equal(body.transaction.amount, 150);
    assert.equal(body.transaction.type, 'expense');
    assert.equal(body.transaction.account_id, CASH);
    assert.equal(await getBalance(CASH), cashBefore - 150);

    const { expense } = await getMonthly();
    assert.equal(expense, 150);
  });

  it('E5 — POST /api/quick with mode=lent and mode=borrowed', async () => {
    const { status: s1, body: b1 } = await api('POST', '/api/quick', {
      mode: 'lent',
      amount: 400,
      person: 'Pooja',
      note: 'Movie tickets'
    });
    assert.equal(s1, 201);
    assert.equal(b1.transaction.type, 'lent');

    const pooja = await getPerson('Pooja');
    assert.ok(pooja);
    assert.equal(pooja.net_balance, 400);

    const { status: s2, body: b2 } = await api('POST', '/api/quick', {
      mode: 'borrowed',
      amount: 100,
      person: 'Pooja',
      note: 'Auto rickshaw'
    });
    assert.equal(s2, 201);
    assert.equal(b2.transaction.type, 'borrowed');

    const poojaUpdated = await getPerson('Pooja');
    assert.equal(poojaUpdated.net_balance, 300, '400 lent - 100 borrowed = 300');

    // Lent and borrowed do NOT affect monthly expense or income
    const { expense, income } = await getMonthly();
    assert.equal(expense, 0);
    assert.equal(income, 0);
  });
});

// =============================================================================
// GROUP F: Cloud Readiness & Public Security (Health & Auth)
// =============================================================================

describe('Group F: Cloud Readiness & Security Endpoints', () => {
  it('F1 — GET /health returns 200 { ok: true } without database dependency', async () => {
    const res = await fetch(`${BASE}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('F2 — POST /api/login rejects incorrect PIN with 401 and accepts correct PIN with Set-Cookie', async () => {
    const rBad = await api('POST', '/api/login', { pin: '9999' });
    assert.equal(rBad.status, 401);
    assert.equal(rBad.body.error, 'Incorrect PIN');

    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const cookie = res.headers.get('set-cookie');
    assert.ok(cookie, 'response must include Set-Cookie header');
    assert.ok(cookie.includes('session='), 'cookie must contain session token');
  });

  it('F3 — Dashboard endpoints reject unauthenticated requests when auth check is enforced', async () => {
    const res = await fetch(`${BASE}/api/summary`, {
      headers: { 'x-force-auth-check': '1' }
    });
    assert.equal(res.status, 401);
  });
});
