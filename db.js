import { createClient } from '@libsql/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // .env file is optional (e.g. in cloud environments where env vars are set via dashboard)
}

const TURSO_URL   = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const IS_TURSO    = Boolean(TURSO_URL && TURSO_TOKEN);

let clientUrl;
let clientToken = undefined;

if (IS_TURSO) {
  clientUrl = TURSO_URL;
  clientToken = TURSO_TOKEN;
  console.log('🌐 Connected to persistent cloud SQLite (Turso)');
} else {
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'udhaar.db');
  clientUrl = dbPath.startsWith('file:') ? dbPath : `file:${path.resolve(dbPath)}`;
  console.log(`📁 Connected to local SQLite file: ${clientUrl}`);
}

export const client = createClient({
  url: clientUrl,
  authToken: clientToken,
});

export const isCloud = IS_TURSO;

/**
 * Executes a query with arguments and returns array of row objects.
 */
export async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

/**
 * Executes a query and returns the first row or null.
 */
export async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows.length > 0 ? res.rows[0] : null;
}

/**
 * Executes a mutation (INSERT, UPDATE, DELETE).
 * Returns { lastInsertRowid, rowsAffected }.
 */
export async function run(sql, args = []) {
  const res = await client.execute({ sql, args });
  return {
    lastInsertRowid: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null,
    rowsAffected: res.rowsAffected,
  };
}

/**
 * Executes an interactive write transaction with auto-commit / rollback.
 */
export async function withTransaction(fn) {
  const tx = await client.transaction('write');
  try {
    const wrappedTx = {
      all: async (sql, args = []) => {
        const res = await tx.execute({ sql, args });
        return res.rows;
      },
      get: async (sql, args = []) => {
        const res = await tx.execute({ sql, args });
        return res.rows.length > 0 ? res.rows[0] : null;
      },
      run: async (sql, args = []) => {
        const res = await tx.execute({ sql, args });
        return {
          lastInsertRowid: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null,
          rowsAffected: res.rowsAffected,
        };
      },
      execute: (stmt) => tx.execute(stmt),
    };
    const result = await fn(wrappedTx);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch { /* ignore rollback failure */ }
    throw err;
  }
}

/**
 * Initializes database tables and default accounts.
 */
export async function initDB() {
  await client.execute('PRAGMA foreign_keys=ON;');

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

  const countRow = await get('SELECT COUNT(*) AS c FROM accounts');
  if (countRow && countRow.c === 0) {
    await run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['UPI / Bank']);
    await run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Cash']);
    await run("INSERT INTO accounts (name, balance) VALUES (?, 0)", ['Savings']);
  }
}
