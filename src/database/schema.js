import { client, get, run } from './connection.js';
import { logger } from '../utils/logger.js';

export async function initSchema() {
  await client.execute('PRAGMA foreign_keys=ON;');

  // Tables
  await client.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT    NOT NULL UNIQUE,
      balance REAL    NOT NULL DEFAULT 0
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS people (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      phone       TEXT,
      net_balance REAL    NOT NULL DEFAULT 0
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT    NOT NULL CHECK(type IN (
                      'expense','income','transfer',
                      'lent','borrowed','settle_in','settle_out')),
      amount        REAL    NOT NULL,
      account_id    INTEGER REFERENCES accounts(id),
      to_account_id INTEGER REFERENCES accounts(id),
      person_id     INTEGER REFERENCES people(id),
      category      TEXT    DEFAULT '',
      merchant      TEXT    DEFAULT '',
      note          TEXT    DEFAULT '',
      utr_ref       TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Performance Indexes for fast queries & deduplication
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);',
    'CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);',
    'CREATE INDEX IF NOT EXISTS idx_transactions_person ON transactions(person_id);',
    'CREATE INDEX IF NOT EXISTS idx_transactions_utr ON transactions(utr_ref);',
    'CREATE INDEX IF NOT EXISTS idx_people_net_balance ON people(net_balance);',
    'CREATE INDEX IF NOT EXISTS idx_people_name ON people(name COLLATE NOCASE);'
  ];

  for (const idx of indexes) {
    await client.execute(idx);
  }

  // Seed default accounts if empty
  const countRow = await get('SELECT COUNT(*) AS c FROM accounts');
  if (countRow && countRow.c === 0) {
    await run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['UPI / Bank']);
    await run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Cash']);
    await run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Savings']);
    logger.info('Initialized default accounts (UPI / Bank, Cash, Savings)');
  }
}
