import * as db from '../database/connection.js';
import { cache } from '../cache/memoryCache.js';
import { config } from '../config/index.js';

export const accountService = {
  async getAll() {
    const cached = cache.get('accounts:all');
    if (cached) return cached;

    const accounts = await db.all('SELECT id, name, balance FROM accounts ORDER BY id');
    cache.set('accounts:all', accounts, config.CACHE_TTL_ACCOUNTS);
    return accounts;
  },

  async getById(id) {
    return db.get('SELECT id, name, balance FROM accounts WHERE id = ?', [id]);
  },

  async getByName(name) {
    return db.get('SELECT id, name, balance FROM accounts WHERE name = ? COLLATE NOCASE', [name.trim()]);
  },

  async create(name, balance = 0) {
    const r = await db.run('INSERT INTO accounts (name, balance) VALUES (?, ?)', [name.trim(), balance]);
    cache.invalidatePrefix('accounts');
    cache.invalidatePrefix('summary');
    return this.getById(r.lastInsertRowid);
  },

  async updateBalance(id, balance) {
    await db.run('UPDATE accounts SET balance = ? WHERE id = ?', [balance, id]);
    cache.invalidatePrefix('accounts');
    cache.invalidatePrefix('summary');
    return this.getById(id);
  },
};
