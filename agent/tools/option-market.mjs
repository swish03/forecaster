#!/usr/bin/env node
// Multiple choice: turns a mapping "option -> market" written by the research
// step into a per-option market table for signals.json. Prices, volumes and
// spreads are copied from markets.json by code, never typed by hand.
// Two shapes are allowed:
//   - one multi-outcome market whose outcomes are the options;
//   - a set of yes/no markets on the same event, one per option.
// If any option is unmapped, two options point at the same market, or the
// prices do not add up to about 1, the table is still written (as
// background) with mapping_problems and problem_codes, and aggregate.mjs then
// does not blend it and names each code in its flags (option_market_<code>).
// Every table carries produced_by "option-market" and a table_hash of the
// option names and prices; aggregate re-checks both and does not blend a
// table without them.

import { DataError, loadMethod, readJson, required, runCli, writeJson } from './core/cli.mjs';
import { OPTION_TABLE_MARKER, optionTableHash } from './core/option-table.mjs';
import { toValidatorQuestion } from './core/question.mjs';

const HELP = `option-market: build the per-option market table for a multiple-choice question.

Usage:
  node tools/option-market.mjs --question <questions/ID.json> --markets <WORK/markets.json> \\
       --map <WORK/option-map.json> [--out <WORK/option-market.json>]

The map file:
  { "match": "same" | "related",
    "options": {
      "<option exactly as in the question>": { "venue": "kalshi", "id": "<market id>" },
      "<option>": { "venue": "polymarket", "id": "<market id>", "outcome": "<outcome name>" },
      "<option>": null } }
A yes/no market gives its price_yes; "outcome" picks one outcome of a
multi-outcome market. null means no market covers that option. Two options
may not point at the same market (or the same outcome of one market).

The table's volume is the smallest volume among its markets (one
multi-outcome market: its own volume), so several thin markets never count
as one deep market.

Prints { status: "ok" | "not_blended", market, problems, problem_codes }. Put
"market" into signals.json exactly as it is: aggregate checks its
produced_by marker and table_hash, and a table typed or edited by hand is not
blended. status not_blended means aggregate will not blend it; the codes
(unknown_option, partial, missing_market, no_price, duplicate_market,
mixed_venues, bad_sum) reach aggregate's flags as option_market_<code>.
Exit 0 = table built (even if not blendable), 1 = unreadable input, 2 = wrong command.`;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function buildOptionMarket({ item, markets, map, method }) {
  const question = toValidatorQuestion(item);
  if (question.type !== 'multiple_choice') throw new DataError('not_multiple_choice', `question is ${question.type}`);
  if (!isObj(map) || !isObj(map.options)) throw new DataError('map_invalid', 'needs an "options" object');
  if (!isObj(markets) || !Array.isArray(markets.results)) throw new DataError('markets_invalid', 'needs markets.json from markets.mjs');
  const options = question.options;
  const problems = [];
  const codes = [];
  const problem = (code, text) => {
    codes.push(code);
    problems.push(text);
  };
  for (const key of Object.keys(map.options)) {
    if (!options.includes(key)) problem('unknown_option', 'map names an option that is not in the question (names must match character for character)');
  }

  const probabilities = {};
  const parts = [];
  const usedBy = new Map();
  for (const option of options) {
    const ref = map.options[option];
    if (!isObj(ref)) {
      problem('partial', `option not mapped: ${option.slice(0, 60)}`);
      continue;
    }
    const target = `${ref.venue}:${ref.id}:${typeof ref.outcome === 'string' ? ref.outcome : ''}`;
    if (usedBy.has(target)) {
      problem('duplicate_market', `two options map to one market: ${usedBy.get(target).slice(0, 40)} and ${option.slice(0, 40)}`);
      continue;
    }
    usedBy.set(target, option);
    const found = markets.results.find((r) => r.venue === ref.venue && String(r.id) === String(ref.id));
    if (!found) {
      problem('missing_market', `market not in markets.json: ${ref.venue ?? '?'} ${String(ref.id ?? '?').slice(0, 40)}`);
      continue;
    }
    let price = null;
    if (typeof ref.outcome === 'string') price = isObj(found.outcomes) && isNum(found.outcomes[ref.outcome]) ? found.outcomes[ref.outcome] : null;
    else price = isNum(found.price_yes) ? found.price_yes : null;
    if (price === null || price < 0 || price > 1) {
      problem('no_price', `no usable price for option: ${option.slice(0, 60)}`);
      continue;
    }
    probabilities[option] = price;
    parts.push({ option, venue: found.venue, id: found.id, title: found.title, url: found.url, price, volume_usd: found.volume_usd ?? null, spread: found.spread ?? null, real_money: found.real_money !== false, close_time: found.close_time ?? null });
  }

  const venues = new Set(parts.map((p) => p.venue));
  if (venues.size > 1) problem('mixed_venues', 'options come from more than one venue');
  // One multi-outcome market counts once; a set of yes/no markets is only as
  // deep as its thinnest market, so the blend weight uses the smallest volume.
  const distinct = [...new Map(parts.map((p) => [`${p.venue}:${p.id}`, p])).values()];
  const volumes = distinct.map((p) => p.volume_usd);
  const volume = volumes.length && volumes.every(isNum) ? Math.min(...volumes) : null;
  const spreads = distinct.map((p) => p.spread);
  const spread = spreads.length && spreads.every(isNum) ? Math.max(...spreads) : null;
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (parts.length === options.length && Math.abs(sum - 1) > method.multiple_choice.market_sum_tolerance) {
    problem('bad_sum', `prices add up to ${Number(sum.toFixed(3))}, not 1 within ${method.multiple_choice.market_sum_tolerance}`);
  }
  const first = distinct[0];
  const market = {
    venue: first?.venue ?? null,
    id: distinct.map((p) => p.id).join(','),
    title: distinct.length === 1 ? first.title : `${distinct.length} markets on one event: ${String(first?.title ?? '').slice(0, 60)}`,
    url: first?.url ?? null,
    match: map.match === 'same' ? 'same' : 'related',
    probabilities,
    parts,
    volume_usd: volume,
    volume_rule: distinct.length > 1 ? 'smallest market' : 'one market',
    spread,
    real_money: distinct.length > 0 && distinct.every((p) => p.real_money),
    close_time: first?.close_time ?? null,
    checked_at: markets.checked_at ?? null,
    mapping_problems: [...new Set(problems)],
    problem_codes: [...new Set(codes)],
    produced_by: OPTION_TABLE_MARKER,
    table_hash: optionTableHash(probabilities),
  };
  return {
    status: market.mapping_problems.length ? 'not_blended' : 'ok',
    market,
    problems: market.mapping_problems,
    problem_codes: market.problem_codes,
    price_sum: Number(sum.toFixed(4)),
  };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: { question: { type: 'string' }, markets: { type: 'string' }, map: { type: 'string' }, out: { type: 'string' } },
  async main(values) {
    required(values, 'question', 'markets', 'map');
    const result = buildOptionMarket({
      item: await readJson(values.question, 'question file'),
      markets: await readJson(values.markets, 'markets file'),
      map: await readJson(values.map, 'map file'),
      method: await loadMethod(),
    });
    if (values.out) await writeJson(values.out, result);
    return result;
  },
});
