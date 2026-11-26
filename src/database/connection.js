import { createClient } from '@libsql/client';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const IS_TURSO = Boolean(config.TURSO_DATABASE_URL && config.TURSO_AUTH_TOKEN && !config.IS_TEST);

let clientUrl;
let clientToken = undefined;

if (IS_TURSO) {
  clientUrl = config.TURSO_DATABASE_URL;
  clientToken = config.TURSO_AUTH_TOKEN;
  logger.info('🌐 Connected to persistent cloud SQLite (Turso)');
} else {
  const resolvedPath = path.resolve(config.DB_PATH);
  clientUrl = resolvedPath.startsWith('file:') ? resolvedPath : `file:${resolvedPath}`;
  logger.info(`📁 Connected to local SQLite file: ${clientUrl}`);
}

export const client = createClient({
  url: clientUrl,
  authToken: clientToken,
});

export const isCloud = IS_TURSO;

export async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

export async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows.length > 0 ? res.rows[0] : null;
}

export async function run(sql, args = []) {
  const res = await client.execute({ sql, args });
  return {
    lastInsertRowid: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null,
    rowsAffected: res.rowsAffected,
  };
}

/**
 * Executes a batch of statements in a single network roundtrip to Turso.
 */
export async function batch(stmts, mode = 'deferred') {
  return client.batch(stmts, mode);
}

/**
 * Interactive write transaction with automatic rollback on error.
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
    try { await tx.rollback(); } catch { /* ignore rollback errors */ }
    throw err;
  }
}
