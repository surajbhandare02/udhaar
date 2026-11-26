import * as db from '../database/connection.js';
import { cache } from '../cache/memoryCache.js';

export const peopleService = {
  async getAll() {
    const cached = cache.get('people:all');
    if (cached) return cached;

    const people = await db.all('SELECT id, name, phone, net_balance FROM people ORDER BY ABS(net_balance) DESC');
    cache.set('people:all', people, 30);
    return people;
  },

  async getById(id) {
    return db.get('SELECT id, name, phone, net_balance FROM people WHERE id = ?', [id]);
  },

  async getOrCreate(dbHandle, name, phone = null) {
    if (!name) return null;
    const trimmed = name.trim();
    let p = await dbHandle.get('SELECT id, name, phone, net_balance FROM people WHERE name = ? COLLATE NOCASE', [trimmed]);
    if (!p) {
      const r = await dbHandle.run(
        'INSERT INTO people (name, phone, net_balance) VALUES (?, ?, 0)',
        [trimmed, phone || null]
      );
      p = await dbHandle.get('SELECT id, name, phone, net_balance FROM people WHERE id = ?', [r.lastInsertRowid]);
      cache.invalidatePrefix('people');
    }
    return p;
  },

  async create(name, phone = null) {
    const trimmed = name.trim();
    const r = await db.run(
      'INSERT INTO people (name, phone, net_balance) VALUES (?, ?, 0)',
      [trimmed, phone || null]
    );
    cache.invalidatePrefix('people');
    return this.getById(r.lastInsertRowid);
  },

  async getTransactions(personId) {
    const person = await this.getById(personId);
    if (!person) return null;

    const transactions = await db.all(`
      SELECT t.id, t.type, t.amount, t.account_id, t.to_account_id, t.person_id,
             t.category, t.merchant, t.note, t.utr_ref, t.created_at,
             a.name AS account_name, p.name AS person_name
      FROM transactions t
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN people   p ON t.person_id  = p.id
      WHERE t.person_id = ?
      ORDER BY t.created_at DESC
    `, [personId]);

    return { person, transactions };
  },
};
