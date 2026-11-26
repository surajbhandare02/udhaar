import { currency } from '../utils/currency.js';

export function validateTransactionInput(body) {
  const { type, amount: rawAmount, to_account_id, account_id, person_id, person_name } = body;

  if (!type) {
    return { valid: false, error: 'type is required' };
  }

  const validTypes = ['expense', 'income', 'transfer', 'lent', 'borrowed', 'settle_in', 'settle_out'];
  if (!validTypes.includes(type)) {
    return { valid: false, error: `Invalid type: ${type}` };
  }

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { valid: false, error: 'amount must be a positive number' };
  }

  if (type === 'transfer') {
    if (!to_account_id) {
      return { valid: false, error: 'to_account_id is required for transfers' };
    }
    if (Number(account_id) === Number(to_account_id)) {
      return { valid: false, error: 'transfer source and destination accounts must differ' };
    }
  }

  if (type === 'lent' || type === 'borrowed') {
    if (!person_id && !person_name) {
      return { valid: false, error: 'person_name or person_id is required for lent/borrowed' };
    }
  }

  return {
    valid: true,
    data: {
      type,
      amount: currency.toRupees(currency.toPaise(amount)),
    },
  };
}
