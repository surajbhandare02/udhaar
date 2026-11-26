import * as db from '../database/connection.js';
import { cache } from '../cache/memoryCache.js';
import { transactionService } from './transactionService.js';
import { accountService } from './accountService.js';

const CATEGORY_MAP = [
  [/zomato|swiggy|food|restaurant|cafe|burger|pizza|eat/i,                       'Food'],
  [/uber|ola|rapido|metro|bus|train|irctc|flight|makemytrip/i,                   'Travel'],
  [/amazon|flipkart|myntra|meesho|ajio|shopping|mart/i,                          'Shopping'],
  [/electricity|water|gas|airtel|jio|\bvi\b|bsnl|broadband|internet|recharge/i,  'Bills'],
  [/netflix|spotify|prime|hotstar|zee5|youtube/i,                                'Entertainment'],
  [/hospital|pharmacy|medical|apollo|1mg|netmedi/i,                              'Health'],
  [/rent|maintenance|society/i,                                                  'Rent'],
  [/salary|payroll/i,                                                            'Salary'],
];

export function guessCategory(merchant = '', text = '') {
  const combined = `${merchant} ${text}`.toLowerCase();
  for (const [pat, cat] of CATEGORY_MAP) {
    if (pat.test(combined)) return cat;
  }
  return 'Other';
}

export function isIgnoredSMS(text) {
  if (!text || typeof text !== 'string' || text.trim().length < 15) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  // 1. OTP / PIN messages
  if (
    /\b(?:OTP|one[\s-]time\s+(?:password|pin)|verification\s+code)\b/i.test(text) ||
    /\bis your OTP\b/i.test(text) ||
    /\buse\s+(?:code|otp)\b/i.test(text)
  ) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  // 2. Failed / declined alerts
  if (/\b(?:payment\s+failed|transaction\s+failed|declined|unsuccessful|rejected|reversed|timed?\s*out)\b/i.test(text)) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  // 3. Balance-only notifications
  const hasDebit  = /\b(?:debited|sent|spent|paid|withdrawn)\b/i.test(text);
  const hasCredit = /\b(?:credited|received|deposited|refund)\b/i.test(text);
  if (!hasDebit && !hasCredit) {
    return { ignored: true, reason: 'otp_or_non_tx' };
  }

  return { ignored: false };
}

export function parseSMS(text) {
  if (!text || text.length < 15) return null;

  if (
    /\b(?:OTP|one[\s-]time\s+(?:password|pin)|verification\s+code)\b/i.test(text) &&
    !/\b(?:debited|credited)\b/i.test(text)
  ) return null;

  if (/\b(?:payment\s+failed|transaction\s+failed|declined|unsuccessful|rejected|reversed|timed?\s*out)\b/i.test(text)) {
    return null;
  }

  // 1. Amount
  const amtM = text.match(/(?:Rs\.?\s*|INR\s*)([\d,]+(?:\.\d{1,2})?)/i);
  if (!amtM) return null;
  const amount = parseFloat(amtM[1].replace(/,/g, ''));
  if (!isFinite(amount) || amount <= 0) return null;

  // 2. Direction
  const hasDebit  = /\b(?:debited|sent|spent|paid|withdrawn)\b/i.test(text);
  const hasCredit = /\b(?:credited|received|deposited|refund)\b/i.test(text);
  if (!hasDebit && !hasCredit) return null;
  const type = hasDebit ? 'expense' : 'income';

  // 3. UTR / Ref (10–12 digits)
  const refM = text.match(
    /(?:UPI\s*Ref\s*(?:No\.?\s*)?|Ref\s*(?:No\.?\s*)?|UPI:|Ref#\s*)(\d{10,12})/i
  );
  const utr_ref = refM ? refM[1] : null;

  // 4. Merchant
  let merchant = '';
  const vpaM = text.match(
    /(?:VPA|to\s+VPA|UPI\s+ID|to\s+UPI)\s+([\w.\-@]+@[\w.\-]+)/i
  );
  if (vpaM) {
    merchant = vpaM[1];
  } else {
    const toM = text.match(
      /\bto\s+([A-Z][A-Z0-9\s&.\-]{2,30}?)(?:\s+on\b|\s+via\b|\s*[.,;]|\s*\d)/i
    );
    if (toM) merchant = toM[1].trim();
  }

  return { amount, type, merchant, utr_ref, category: guessCategory(merchant, text) };
}

export const smsService = {
  async processSingle(message, targetAccount = null) {
    const ignoreCheck = isIgnoredSMS(message);
    if (ignoreCheck.ignored) {
      return { status: 'ignored', reason: ignoreCheck.reason, unrecognized: true };
    }

    const parsed = parseSMS(message);
    if (!parsed) {
      return { status: 'ignored', reason: 'otp_or_non_tx', unrecognized: true };
    }

    const { amount, type, merchant, utr_ref, category } = parsed;

    let accountId = 1;
    if (targetAccount) {
      if (typeof targetAccount === 'number') {
        const a = await accountService.getById(targetAccount);
        if (a) accountId = a.id;
      } else if (typeof targetAccount === 'string') {
        const a = await accountService.getByName(targetAccount);
        if (a) accountId = a.id;
      }
    }

    if (utr_ref) {
      const hit = await db.get('SELECT id FROM transactions WHERE utr_ref = ?', [utr_ref]);
      if (hit) return { status: 'duplicate', duplicate: true, utr_ref };
    }

    const fuzzy = await db.get(`
      SELECT id FROM transactions
      WHERE amount = ? AND type = ? AND account_id = ?
        AND created_at >= datetime('now', '-3 minutes')
    `, [amount, type, accountId]);
    if (fuzzy) return { status: 'duplicate', duplicate: true };

    const params = { type, amount, account_id: accountId, to_account_id: null, person_id: null };
    const tx = await db.withTransaction(async (txRunner) => {
      await transactionService.applyBalanceDeltas(txRunner, params, 1);
      const r = await txRunner.run(`
        INSERT INTO transactions (type, amount, account_id, category, merchant, utr_ref)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [type, amount, accountId, category, merchant, utr_ref || null]);
      return txRunner.get('SELECT * FROM transactions WHERE id = ?', [r.lastInsertRowid]);
    });

    cache.invalidateFinancials();
    return { status: 'created', transaction: tx };
  },

  async processBatch({ raw_text, messages = [], targetAccount = null }) {
    let msgList = [];
    if (typeof raw_text === 'string') {
      msgList = raw_text
        .split(/(?:\r?\n\s*[-—]{3,}\s*\r?\n|\r?\n\s*\r?\n+)/g)
        .map(s => s.trim())
        .filter(Boolean);

      if (msgList.length <= 1 && raw_text.includes('\n')) {
        const lines = raw_text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (lines.length > 1 && lines.every(l => /(?:rs\.?|inr|debited|credited|paid|sent)/i.test(l))) {
          msgList = lines;
        }
      }
    } else if (Array.isArray(messages)) {
      msgList = messages.map(s => String(s).trim()).filter(Boolean);
    }

    let accountId = 1;
    if (targetAccount) {
      if (typeof targetAccount === 'number') {
        const a = await accountService.getById(targetAccount);
        if (a) accountId = a.id;
      } else if (typeof targetAccount === 'string') {
        const a = await accountService.getByName(targetAccount);
        if (a) accountId = a.id;
      }
    }

    const outcome = await db.withTransaction(async (txRunner) => {
      const summary = { imported: 0, duplicates: 0, ignored: 0 };
      const results = [];
      const seenUtrs = new Set();

      for (const msg of msgList) {
        try {
          const ignoreCheck = isIgnoredSMS(msg);
          if (ignoreCheck.ignored) {
            summary.ignored++;
            results.push({ message: String(msg).slice(0, 70), status: 'ignored', reason: ignoreCheck.reason });
            continue;
          }

          const parsed = parseSMS(msg);
          if (!parsed) {
            summary.ignored++;
            results.push({ message: String(msg).slice(0, 70), status: 'ignored', reason: 'otp_or_non_tx' });
            continue;
          }

          const { amount, type, merchant, utr_ref, category } = parsed;

          if (utr_ref) {
            if (seenUtrs.has(utr_ref)) {
              summary.duplicates++;
              results.push({ message: String(msg).slice(0, 70), status: 'duplicate', duplicate: true, utr_ref });
              continue;
            }
            const hit = await txRunner.get('SELECT id FROM transactions WHERE utr_ref = ?', [utr_ref]);
            if (hit) {
              summary.duplicates++;
              results.push({ message: String(msg).slice(0, 70), status: 'duplicate', duplicate: true, utr_ref });
              continue;
            }
          }

          const fuzzy = await txRunner.get(`
            SELECT id FROM transactions
            WHERE amount = ? AND type = ? AND account_id = ?
              AND created_at >= datetime('now', '-3 minutes')
          `, [amount, type, accountId]);
          if (fuzzy) {
            summary.duplicates++;
            results.push({ message: String(msg).slice(0, 70), status: 'duplicate', duplicate: true });
            continue;
          }

          const params = { type, amount, account_id: accountId, to_account_id: null, person_id: null };
          await transactionService.applyBalanceDeltas(txRunner, params, 1);
          const r = await txRunner.run(`
            INSERT INTO transactions (type, amount, account_id, category, merchant, utr_ref)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [type, amount, accountId, category, merchant, utr_ref || null]);

          if (utr_ref) seenUtrs.add(utr_ref);
          summary.imported++;
          results.push({ message: String(msg).slice(0, 70), status: 'created', id: r.lastInsertRowid });
        } catch (e) {
          summary.ignored++;
          results.push({ status: 'error', error: e.message });
        }
      }

      return {
        imported: summary.imported,
        duplicates: summary.duplicates,
        ignored: summary.ignored,
        summary,
        results,
      };
    });

    if (outcome.imported > 0) {
      cache.invalidateFinancials();
    }

    return outcome;
  },
};
