import * as db from '../database/connection.js';
import { cache } from '../cache/memoryCache.js';
import { currency } from '../utils/currency.js';
import { peopleService } from './peopleService.js';
import { config } from '../config/index.js';

export const transactionService = {
  /**
   * Applies balance delta updates using exact paise integer math.
   */
  async applyBalanceDeltas(dbHandle, tx, multiplier) {
    const { type, amount, account_id, to_account_id, person_id } = tx;
    const m = multiplier;
    // Compute exact delta
    const delta = amount * m;

    switch (type) {
      case 'expense':
        await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [delta, account_id]);
        break;

      case 'income':
        await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [delta, account_id]);
        break;

      case 'transfer':
        await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [delta, account_id]);
        await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [delta, to_account_id]);
        break;

      case 'lent':
        await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [delta, account_id]);
        if (person_id) {
          await dbHandle.run('UPDATE people SET net_balance = net_balance + ? WHERE id = ?', [delta, person_id]);
        }
        break;

      case 'borrowed':
        await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [delta, account_id]);
        if (person_id) {
          await dbHandle.run('UPDATE people SET net_balance = net_balance - ? WHERE id = ?', [delta, person_id]);
        }
        break;

      case 'settle_in':
        await dbHandle.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [delta, account_id]);
        if (person_id) {
          await dbHandle.run('UPDATE people SET net_balance = net_balance - ? WHERE id = ?', [delta, person_id]);
        }
        break;

      case 'settle_out':
        await dbHandle.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [delta, account_id]);
        if (person_id) {
          await dbHandle.run('UPDATE people SET net_balance = net_balance + ? WHERE id = ?', [delta, person_id]);
        }
        break;
    }
  },

  /**
   * High performance summary using parallel or single-batch execution.
   */
  async getSummary() {
    const cached = cache.get('summary:current');
    if (cached) return cached;

    // Single-roundtrip batch pipeline
    const batchRes = await db.batch([
      'SELECT id, name, balance FROM accounts ORDER BY id',
      `SELECT
        SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expense,
        SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income
      FROM transactions
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
      'SELECT COALESCE(SUM(net_balance), 0) AS total FROM people WHERE net_balance > 0'
    ], 'read');

    const accounts = batchRes[0].rows;
    const monthlyRow = batchRes[1].rows[0] || {};
    const recvRow = batchRes[2].rows[0] || {};

    const summary = {
      accounts,
      monthly: {
        expense: currency.toRupees(currency.toPaise(monthlyRow.expense || 0)),
        income: currency.toRupees(currency.toPaise(monthlyRow.income || 0)),
      },
      people_receivables: currency.toRupees(currency.toPaise(recvRow.total || 0)),
    };

    cache.set('summary:current', summary, config.CACHE_TTL_SUMMARY);
    return summary;
  },

  async getFiltered({ type, account_id, category, search, limit = 50, offset = 0 }) {
    const conds = [], args = [];
    if (type)       { conds.push('t.type = ?');  args.push(type); }
    if (account_id) { conds.push('(t.account_id = ? OR t.to_account_id = ?)'); args.push(account_id, account_id); }
    if (category)   { conds.push('t.category = ?'); args.push(category); }
    if (search)     {
      conds.push('(t.merchant LIKE ? OR t.note LIKE ? OR t.category LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const [rows, countRow] = await Promise.all([
      db.all(`
        SELECT t.id, t.type, t.amount, t.account_id, t.to_account_id, t.person_id,
               t.category, t.merchant, t.note, t.utr_ref, t.created_at,
               a.name  AS account_name,
               ta.name AS to_account_name,
               p.name  AS person_name
        FROM transactions t
        LEFT JOIN accounts a  ON t.account_id    = a.id
        LEFT JOIN accounts ta ON t.to_account_id = ta.id
        LEFT JOIN people   p  ON t.person_id     = p.id
        ${where}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ? OFFSET ?
      `, [...args, limit, offset]),
      db.get(`SELECT COUNT(*) AS c FROM transactions t ${where}`, args)
    ]);

    return { transactions: rows, total: countRow?.c || 0, limit, offset };
  },

  async create(body) {
    const {
      type, amount, account_id, to_account_id = null,
      person_id = null, person_name = null, phone = null,
      category = '', merchant = '', note = '', utr_ref = null, created_at = null,
    } = body;

    const tx = await db.withTransaction(async (txRunner) => {
      let resolvedPersonId = person_id;
      if (!resolvedPersonId && person_name) {
        const p = await peopleService.getOrCreate(txRunner, person_name, phone);
        resolvedPersonId = p ? p.id : null;
      }

      const params = {
        type, amount,
        account_id:    account_id    ? Number(account_id)    : null,
        to_account_id: to_account_id ? Number(to_account_id) : null,
        person_id:     resolvedPersonId,
      };

      await this.applyBalanceDeltas(txRunner, params, 1);

      const r = created_at
        ? await txRunner.run(`
            INSERT INTO transactions
              (type, amount, account_id, to_account_id, person_id, category, merchant, note, utr_ref, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [type, amount, params.account_id, params.to_account_id, params.person_id,
              category, merchant, note, utr_ref || null, created_at])
        : await txRunner.run(`
            INSERT INTO transactions
              (type, amount, account_id, to_account_id, person_id, category, merchant, note, utr_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [type, amount, params.account_id, params.to_account_id, params.person_id,
              category, merchant, note, utr_ref || null]);

      return txRunner.get('SELECT * FROM transactions WHERE id = ?', [r.lastInsertRowid]);
    });

    cache.invalidateFinancials();
    return tx;
  },

  async update(id, body) {
    const old = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
    if (!old) return null;

    const {
      type = old.type,
      amount = old.amount,
      account_id = old.account_id,
      to_account_id = old.to_account_id,
      person_id = old.person_id,
      person_name = null,
      phone = null,
      category = old.category,
      merchant = old.merchant,
      note = old.note,
      utr_ref = old.utr_ref,
      created_at = old.created_at,
    } = body;

    const updated = await db.withTransaction(async (txRunner) => {
      let resolvedPersonId = person_id;
      if (!resolvedPersonId && person_name) {
        const p = await peopleService.getOrCreate(txRunner, person_name, phone);
        resolvedPersonId = p ? p.id : null;
      }

      const newDelta = { type, amount, account_id, to_account_id, person_id: resolvedPersonId };

      await this.applyBalanceDeltas(txRunner, old, -1);
      await this.applyBalanceDeltas(txRunner, newDelta, 1);

      await txRunner.run(`
        UPDATE transactions
        SET type=?, amount=?, account_id=?, to_account_id=?, person_id=?,
            category=?, merchant=?, note=?, utr_ref=?, created_at=?
        WHERE id=?
      `, [type, amount, account_id || null, to_account_id || null, resolvedPersonId,
          category, merchant, note, utr_ref || null, created_at, id]);

      return txRunner.get('SELECT * FROM transactions WHERE id = ?', [id]);
    });

    cache.invalidateFinancials();
    return updated;
  },

  async delete(id) {
    const tx = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
    if (!tx) return false;

    await db.withTransaction(async (txRunner) => {
      await this.applyBalanceDeltas(txRunner, tx, -1);
      await txRunner.run('DELETE FROM transactions WHERE id = ?', [id]);
    });

    cache.invalidateFinancials();
    return true;
  },
};
