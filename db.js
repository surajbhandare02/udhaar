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
      balance REAL NOT NULL DEFAULT 0
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
    )`
  ], 'write');

  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('monthly_budget', '25000')`);
  await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('saved_by_waiting', '0')`);

  const accs = await db.execute('SELECT COUNT(*) as c FROM accounts');
  if (Number(accs.rows[0].c) === 0) {
    await db.batch([
      { sql: 'INSERT INTO accounts (name, balance) VALUES (?, ?)', args: ['UPI / Bank', 0] },
      { sql: 'INSERT INTO accounts (name, balance) VALUES (?, ?)', args: ['Cash', 0] },
      { sql: 'INSERT INTO accounts (name, balance) VALUES (?, ?)', args: ['Savings', 0] }
    ], 'write');
  }
}
