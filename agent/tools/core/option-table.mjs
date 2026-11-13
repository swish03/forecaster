// The marker and hash that a per-option market table carries when
// option-market.mjs built it. aggregate.mjs blends a multiple-choice market
// table only when both are present and the hash still matches the option
// names and prices, so a table typed by hand (or edited afterwards) is not
// blended and is flagged instead.

import { createHash } from 'node:crypto';

export const OPTION_TABLE_MARKER = 'option-market';

// Problem codes option-market.mjs writes into problem_codes; aggregate turns
// each one into the flag option_market_<code>.
export const OPTION_TABLE_CODES = ['unknown_option', 'partial', 'missing_market', 'no_price', 'duplicate_market', 'mixed_venues', 'bad_sum'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// SHA-256 of the option names and prices, in sorted name order.
export function optionTableHash(probabilities) {
  const entries = isObj(probabilities) ? Object.keys(probabilities).sort().map((k) => [k, probabilities[k]]) : [];
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

// True when the table carries the marker and a hash that matches its prices.
export function isToolTable(market) {
  return isObj(market) && market.produced_by === OPTION_TABLE_MARKER
    && typeof market.table_hash === 'string' && market.table_hash === optionTableHash(market.probabilities);
}
