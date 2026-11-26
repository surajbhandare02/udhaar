/**
 * Financial calculation accuracy utility.
 * Operates on integer paise (1 Rupee = 100 Paise) to avoid IEEE 754 floating-point rounding errors.
 */

export const currency = {
  /**
   * Converts a rupee value (number, float, or string) to exact integer paise.
   * e.g. 10.50 -> 1050
   */
  toPaise(rupees) {
    if (rupees == null) return 0;
    const num = Number(rupees);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100);
  },

  /**
   * Converts integer paise back to a decimal rupee number.
   * e.g. 1050 -> 10.5
   */
  toRupees(paise) {
    if (paise == null) return 0;
    const num = Number(paise);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num) / 100;
  },

  /**
   * Safe financial addition in paise.
   */
  add(aRupees, bRupees) {
    return this.toRupees(this.toPaise(aRupees) + this.toPaise(bRupees));
  },

  /**
   * Safe financial subtraction in paise.
   */
  subtract(aRupees, bRupees) {
    return this.toRupees(this.toPaise(aRupees) - this.toPaise(bRupees));
  },

  /**
   * Formats a rupee value as Indian Rupee currency.
   */
  formatINR(rupees, includeDecimals = false) {
    const r = Number(rupees) || 0;
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: includeDecimals ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(r);
  },
};
