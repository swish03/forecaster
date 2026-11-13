// Small helpers for continuous questions: percentile values in, values back out of a CDF.

import { valueAt } from '../../../lib/cdf.mjs';

// Real-world value where the CDF reaches level p, or null if it lies beyond the range.
export function quantileOf(cdf, p, scaling) {
  if (cdf[0] >= p || cdf[cdf.length - 1] < p) return null;
  const n = cdf.length - 1;
  for (let i = 1; i <= n; i += 1) {
    if (cdf[i] >= p) {
      const x = (i - 1 + (p - cdf[i - 1]) / (cdf[i] - cdf[i - 1])) / n;
      return valueAt(x, scaling);
    }
  }
  return null;
}

// Percentile values are numbers; date questions may give ISO dates (the range is in Unix seconds).
export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value) / 1000;
  return Number.NaN;
}
