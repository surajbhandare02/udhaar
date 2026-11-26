import { createClient } from '@libsql/client';

const isTest = process.env.NODE_ENV === 'test';
const url = (isTest && process.env.DATABASE_URL)
  ? process.env.DATABASE_URL
  : (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:ledger.db');

export const db = createClient({
  url,
  authToken: isTest ? undefined : process.env.TURSO_AUTH_TOKEN
});

export async function initDB() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0,
      type TEXT DEFAULT 'bank',
      credit_limit REAL DEFAULT 0,
      statement_date INTEGER DEFAULT 15,
      due_date INTEGER DEFAULT 5
    )`,
    `CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT,
      net_balance REAL NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      account_id INTEGER,
      to_account_id INTEGER,
      person_id INTEGER,
      category TEXT,
      merchant TEXT,
      note TEXT,
      utr TEXT,
      created_at TEXT DEFAULT (datetime('now', '+5 hours', '30 minutes'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_utr ON transactions(utr)`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS paused_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now', '+5 hours', '30 minutes'))
    )`,
    `CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT 'monthly',
      amount REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      billing_cycle TEXT NOT NULL DEFAULT 'monthly',
      next_renewal_date TEXT NOT NULL,
      account_id INTEGER,
      category TEXT DEFAULT 'Entertainment'
    )`,
    `CREATE TABLE IF NOT EXISTS recurring_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT DEFAULT 'Bills',
      account_id INTEGER,
      frequency TEXT DEFAULT 'monthly',
      due_date TEXT NOT NULL,
      last_paid_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS savings_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL DEFAULT 0,
      target_date TEXT,
      account_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'expense',
      amount REAL NOT NULL,
      account_id INTEGER,
      category TEXT,
      note TEXT
    )`
  ], 'write');

  // Safe migrations for existing accounts table
  const colMigrations = [
    `ALTER TABLE accounts ADD COLUMN type TEXT DEFAULT 'bank'`,
    `ALTER TABLE accounts ADD COLUMN credit_limit REAL DEFAULT 0`,
    `ALTER TABLE accounts ADD COLUMN statement_date INTEGER DEFAULT 15`,
    `ALTER TABLE accounts ADD COLUMN due_date INTEGER DEFAULT 5`
  ];
  for (const sql of colMigrations) {
    try { await db.execute(sql); } catch {}
  }

  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('monthly_budget', '25000')`);
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('saved_by_waiting', '0')`);

  const accs = await db.execute('SELECT COUNT(*) as c FROM accounts');
  if (Number(accs.rows[0].c) === 0) {
    await db.batch([
      { sql: 'INSERT INTO accounts (name, balance, type) VALUES (?, ?, ?)', args: ['UPI / Bank', 0, 'bank'] },
      { sql: 'INSERT INTO accounts (name, balance, type) VALUES (?, ?, ?)', args: ['Cash', 0, 'cash'] },
      { sql: 'INSERT INTO accounts (name, balance, type) VALUES (?, ?, ?)', args: ['Savings', 0, 'bank'] }
    ], 'write');
  }

  // Seed default templates if empty
  const tplCount = await db.execute('SELECT COUNT(*) as c FROM templates');
  if (Number(tplCount.rows[0].c) === 0) {
    await db.batch([
      { sql: `INSERT INTO templates (name, type, amount, category, note) VALUES (?, 'expense', ?, ?, ?)`, args: ['Daily Chai / Coffee', 40, 'Food', 'Coffee & snacks'] },
      { sql: `INSERT INTO templates (name, type, amount, category, note) VALUES (?, 'expense', ?, ?, ?)`, args: ['Metro / Auto Commute', 50, 'Travel', 'Daily transit'] },
      { sql: `INSERT INTO templates (name, type, amount, category, note) VALUES (?, 'expense', ?, ?, ?)`, args: ['Grocery Restock', 500, 'Food', 'Weekly essentials'] }
    ], 'write');
  }
}
