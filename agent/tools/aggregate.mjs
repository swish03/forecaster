#!/usr/bin/env node
// Combines the independent pass outputs into one forecast, exactly as
// agent/method.md says: median (binary), median per option with a floor
// (multiple choice), pointwise median of pass CDFs (numeric, discrete, date);
// then the fixed blend toward a matched market or community signal, the
// clamp, and (numeric and discrete) the guard that keeps the 10-90 band at
// least a set share of the data series' own band for the same horizon.

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { CONTINUOUS_TYPES, buildCdfWithInfo, locationOf, validateCdf, valueAt } from '../../lib/cdf.mjs';
import { blendLogOdds, clamp, median, normalizeWithFloor } from '../../lib/prob.mjs';
import { DataError, loadMethod, readJson, required, runCli, writeJson } from './core/cli.mjs';
import { quantileOf, toNumber } from './core/quantile.mjs';
import { OPTION_TABLE_CODES, isToolTable } from './core/option-table.mjs';
import { scalingOf, toValidatorQuestion } from './core/question.mjs';

const HELP = `aggregate: combine the pass outputs into the final forecast object.

Usage:
  node tools/aggregate.mjs --question <questions/ID.json> --passes <folder> \\
       [--signals <signals.json>] [--out <aggregate.json>] [--fast-path]
       [--allow-few] [--passes-not-independent]

--passes   folder with pass-1.md ... pass-5.md (or .json); from a .md file the
           last fenced json block is read
--signals  { "market": {...}|null, "community": {...}|null, "base_rate": "..."|null,
             "context": { "status_quo": "yes"|"no"|null,
                          "status_quo_short_horizon": true|false,
                          "series_band_width_10_90": <number>|null } }
--fast-path  this question went the fast path, so the method requires
           fast_path_passes (3) passes instead of passes (5) (method.json)
--allow-few  accept fewer than min_valid_passes (3) valid passes (only after
           re-running the missing ones once); the shortfall is still flagged
--passes-not-independent  the passes were written one after another by one
           agent (no sub-agents): the comment's Passes line then says so

Passes are counted by pass number: two files for one number count once
(duplicate_pass_number) and numbers outside 1..required are ignored
(pass_number_out_of_range). Fewer valid passes than the method requires (5, or
3 on the fast path) sets the flag fewer_passes_than_required in flags,
checks.flags and the Passes line.

Series guard (numeric, discrete): a positive series_band_width_10_90 widens a
narrower 10-90 band by the largest safe factor that is not above the factor
needed for the target nor series_band_max_factor. Safe: the CDF check passes,
the 10th and 90th percentiles stay in range, the median moves under one bin,
and at most series_band_max_outside_growth extra mass lands outside each open
bound or in the 2 outermost bins of each closed bound. Flags:
band_widened_to_series (target reached), band_widened_partly with
band_widen_capped_by_<reason> (a smaller safe factor), or
band_guard_skipped_<reason> (no safe factor above 1.01). A band that is not a positive number is ignored
(series_band_invalid_ignored). A multiple-choice market table is blended only
when option-market.mjs built it (marker and table_hash re-checked).
Fewer than min_valid_passes is refused (exit 1, too_few_passes) unless --allow-few.

Prints (and with --out writes) { forecast, passes, signals, checks, flags, dropped_passes, comment_lines }.
Exit 0 = done, 1 = invalid data or too few valid passes, 2 = wrong command.`;

const FENCE = /```json\s*([\s\S]*?)```/g;

export function parsePassText(text, label) {
  if (label.endsWith('.json')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  const blocks = [...text.matchAll(FENCE)];
  if (!blocks.length) return null;
  try {
    return JSON.parse(blocks[blocks.length - 1][1]);
  } catch {
    return null;
  }
}

export const PASS_FILE = /^pass-\d+\.(md|json)$/;

export async function loadPasses(dir) {
  const names = (await readdir(dir)).filter((n) => PASS_FILE.test(n)).sort((a, b) => passNumber(a) - passNumber(b));
  const passes = [];
  for (const name of names) {
    passes.push({ file: name, data: parsePassText(await readFile(join(dir, name), 'utf8'), name) });
  }
  return passes;
}

export const passNumber = (name) => Number(basename(name).match(/\d+/)[0]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reasonOf = (d) => (typeof d?.reason === 'string' ? d.reason.trim().slice(0, 300) : '');
const fmt = (v) => (isNum(v) ? String(Number(v.toPrecision(4))) : String(v));
const pct = (p) => `${fmt(p * 100)}%`;

// How many passes the method requires for this question.
export const requiredPasses = (method, fastPath) => (fastPath ? method.fast_path_passes : method.passes);

// ---- signals and weights ----------------------------------------------------

export function marketWeight(market, method) {
  if (!isObj(market) || market.match !== 'same' || market.real_money === false || !isNum(market.volume_usd)) return 0;
  const v = market.volume_usd;
  const b = method.blend;
  if (v > b.market_volume_steps[2].up_to_usd) {
    return isNum(market.spread) && market.spread <= b.deep_market_max_spread ? b.deep_market_weight : b.market_volume_steps[2].weight;
  }
  if (v < b.market_volume_steps[0].below_usd) return b.market_volume_steps[0].weight;
  if (v < b.market_volume_steps[1].below_usd) return b.market_volume_steps[1].weight;
  return b.market_volume_steps[2].weight;
}

// The community signal counts only once the owner has switched it on in
// method.json (blend.community_enabled), after checking the tournament rules.
export function communityWeight(community, method) {
  if (method.blend.community_enabled !== true) return 0;
  if (!isObj(community) || !Number.isInteger(community.forecasters)) return 0;
  const step = method.blend.community_steps.find((s) => community.forecasters >= s.min_forecasters);
  return step ? step.weight : 0;
}

const MARKET_KEYS = ['venue', 'id', 'title', 'url', 'match', 'price_yes', 'probabilities', 'parts', 'volume_usd', 'volume_rule', 'liquidity_usd', 'spread', 'real_money', 'close_time', 'checked_at', 'mapping_problems', 'problem_codes', 'produced_by', 'table_hash'];
const COMMUNITY_KEYS = ['url', 'forecasters', 'probability_yes', 'checked_at'];
const pickKeys = (obj, keys) => (isObj(obj) ? Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]])) : null);

function normalizeSignals(raw) {
  const s = isObj(raw) ? raw : {};
  return {
    market: pickKeys(s.market, MARKET_KEYS),
    community: pickKeys(s.community, COMMUNITY_KEYS),
    base_rate: typeof s.base_rate === 'string' && s.base_rate.trim() ? s.base_rate.trim().slice(0, 500) : null,
    context: isObj(s.context) ? s.context : {},
  };
}

function signalLine(signals, chosen) {
  const m = signals.market;
  const parts = [];
  if (m) {
    const price = isNum(m.price_yes) ? ` price ${fmt(m.price_yes)}` : '';
    const vol = isNum(m.volume_usd) ? ` volume $${Math.round(m.volume_usd).toLocaleString('en-US')}` : '';
    parts.push(`${m.venue ?? 'market'} "${String(m.title ?? '').slice(0, 80)}"${price}${vol}, ${m.checked_at ?? 'date unknown'}, match ${m.match ?? 'unlabelled'}`);
  }
  const c = signals.community;
  if (c) parts.push(`Metaculus community ${isNum(c.probability_yes) ? fmt(c.probability_yes) : 'n/a'} from ${c.forecasters ?? '?'} forecasters, ${c.checked_at ?? 'date unknown'}`);
  const used = chosen.weight > 0 ? `${chosen.kind} used, weight w=${chosen.weight}` : `none used, weight w=0${chosen.why ? ` (${chosen.why})` : ''}`;
  return `Markets / community: ${parts.length ? parts.join('; ') : 'none matched'} -> ${used}`;
}

// ---- checking single passes -------------------------------------------------
// Each checker returns { ok: true, value } or { ok: false, reason }. They are
// shared by aggregate and by check-pass.mjs, so a pass the main session
// accepts right after it returns is exactly a pass aggregate accepts.

function checkBinary(data) {
  if (isNum(data?.p) && data.p >= 0 && data.p <= 1) return { ok: true, value: data.p };
  return { ok: false, reason: 'no valid "p" between 0 and 1' };
}

function checkMultipleChoice(data, options) {
  const probs = data?.probs;
  const keys = isObj(probs) ? Object.keys(probs) : [];
  const sameOptions = keys.length === options.length && options.every((o) => Object.hasOwn(probs, o));
  if (!sameOptions) return { ok: false, reason: 'option names do not match the question character for character' };
  const values = options.map((o) => probs[o]);
  const sum = values.reduce((a, b) => a + (isNum(b) ? b : Number.NaN), 0);
  if (values.some((v) => !isNum(v) || v < 0) || !(sum > 0)) return { ok: false, reason: 'probabilities must be non-negative numbers with a positive sum' };
  return { ok: true, value: Object.fromEntries(options.map((o) => [o, probs[o] / sum])) };
}

function checkContinuous(data, method, scaling) {
  const c = method.continuous;
  const axis = (v) => locationOf(v, scaling);
  const raw = data?.percentiles;
  if (!isObj(raw)) return { ok: false, reason: 'no percentiles object' };
  const keys = Object.keys(raw);
  const values = Object.fromEntries(keys.map((k) => [k, toNumber(raw[k])]));
  if (keys.some((k) => !c.percentiles.includes(k)) || !('50' in raw) || keys.length < c.min_percentiles
    || Object.values(values).some((v) => !Number.isFinite(v))) {
    return { ok: false, reason: `needs at least ${c.min_percentiles} of the listed percentiles, including 50, all numbers` };
  }
  const sorted = c.percentiles.filter((k) => k in values).map((k) => values[k]);
  if (sorted.some((v, i) => i > 0 && v < sorted[i - 1])) return { ok: false, reason: 'percentile values go down' };
  const medAxis = axis(values['50']);
  if (!Number.isFinite(medAxis) || medAxis < -c.max_median_range_widths_outside || medAxis > 1 + c.max_median_range_widths_outside) {
    return { ok: false, reason: 'unit check: median far outside the question range' };
  }
  const lowAxis = axis(sorted[0]);
  const highAxis = axis(sorted[sorted.length - 1]);
  if (Number.isFinite(lowAxis) && highAxis - lowAxis < c.min_spread_fraction_of_range) {
    return { ok: false, reason: 'unit check: spread is too narrow for the question range' };
  }
  return { ok: true, value: values };
}

function passChecker(item, method) {
  const question = toValidatorQuestion(item);
  if (question.type === 'binary') return (data) => checkBinary(data);
  if (question.type === 'multiple_choice') return (data) => checkMultipleChoice(data, question.options ?? []);
  if (CONTINUOUS_TYPES.has(question.type)) {
    const scaling = scalingOf(item);
    return (data) => checkContinuous(data, method, scaling);
  }
  throw new DataError('question_type_unsupported', String(question.type));
}

// One pass, as check-pass.mjs uses it: null data means the file is missing
// or holds no readable json block.
export function checkPass(item, data, method) {
  if (data === null || data === undefined) return { ok: false, reason: 'no fenced json block could be read' };
  const result = passChecker(item, method)(data);
  return result.ok ? { ok: true } : result;
}

// Passes are counted by pass number, never by file: a number outside
// 1..required is ignored, and two files for one number (pass-1.md and
// pass-1.json) count once (the first valid one, .md before .json). Both are
// flagged, so a shortfall can never be hidden by extra files.
function splitPasses(item, passes, method, required) {
  const check = passChecker(item, method);
  const valid = [];
  const dropped = [];
  const outOfRange = [];
  const duplicates = new Set();
  const seen = new Map();
  const ordered = [...passes].sort((a, b) => passNumber(a.file) - passNumber(b.file)
    || Number(a.file.endsWith('.json')) - Number(b.file.endsWith('.json')) || a.file.localeCompare(b.file));
  for (const { file, data } of ordered) {
    const k = passNumber(file);
    if (!Number.isInteger(k) || k < 1 || k > required) {
      outOfRange.push(file);
      dropped.push({ file, reason: `pass number outside 1..${required}: ignored` });
      continue;
    }
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (seen.get(k) > 1) duplicates.add(k);
    const result = check(data);
    if (!result.ok) dropped.push({ file, reason: result.reason });
    else if (valid.some((v) => passNumber(v.file) === k)) dropped.push({ file, reason: `another file for pass ${k} was already counted` });
    else valid.push({ file, value: result.value, reason: reasonOf(data) });
  }
  return { valid, dropped, outOfRange, duplicates: [...duplicates].sort((a, b) => a - b) };
}

// ---- binary -----------------------------------------------------------------

function aggregateBinary(valid, signals, method) {
  const values = valid.map((v) => v.value);
  const med = median(values);

  const guard = (p) => clamp(p, ...method.binary.logit_guard);
  const market = isNum(signals.market?.price_yes) && signals.market.price_yes > 0 && signals.market.price_yes < 1 ? marketWeight(signals.market, method) : 0;
  const community = isNum(signals.community?.probability_yes) && signals.community.probability_yes > 0 && signals.community.probability_yes < 1
    ? communityWeight(signals.community, method) : 0;
  // Spec order: a matched market when it has weight, otherwise the community.
  const chosen = market > 0
    ? { kind: 'market', weight: market, value: signals.market.price_yes }
    : community > 0 ? { kind: 'community', weight: community, value: signals.community.probability_yes } : { kind: 'none', weight: 0, value: null };
  const blended = chosen.weight > 0 ? blendLogOdds(guard(med), guard(chosen.value), chosen.weight) : med;

  const [lo, hi] = method.binary.clamp;
  // The wide clamp needs all five passes (method.passes), all on the same side.
  const allLow = valid.length >= method.passes && values.every((v) => v <= lo);
  const allHigh = valid.length >= method.passes && values.every((v) => v >= hi);
  const deepAgrees = chosen.kind === 'market' && chosen.weight === method.blend.deep_market_weight
    && ((allLow && chosen.value <= 0.05) || (allHigh && chosen.value >= 0.95));
  const wide = (allLow || allHigh) && (signals.context.status_quo_short_horizon === true || deepAgrees);
  const range = wide ? method.binary.wide_clamp : method.binary.clamp;
  const rounded = Number(blended.toFixed(4));
  const final = clamp(rounded, ...range);

  const flags = [];
  if (chosen.weight > 0 && Math.abs(med - chosen.value) > method.flags.signal_gap) flags.push('median_far_from_signal');
  if (Math.max(...values) - Math.min(...values) > method.flags.pass_spread) flags.push('wide_pass_spread');
  if (signals.context.status_quo === 'no' && final > method.flags.high_against_status_quo) flags.push('high_against_status_quo');
  if (wide) flags.push('wide_clamp_used');

  return {
    forecast: { probability_yes: final },
    passes: valid.map((v) => ({ pass: passNumber(v.file), value: v.value, reason: v.reason })),
    clamped: final !== rounded,
    weight: chosen.weight,
    flags,
    lines: {
      forecast: `Forecast: ${pct(final)} (bot v${method.version}, fully automated, no human input)`,
      markets: signalLine(signals, chosen),
      passes: `Passes: ${valid.map((v) => `P${passNumber(v.file)} ${fmt(v.value)}`).join(' ')}; aggregate = median ${fmt(med)}${chosen.weight ? `, blended to ${fmt(blended)}` : ''}; clamp applied: ${final !== rounded ? 'yes' : 'no'}.`,
    },
  };
}

// ---- multiple choice --------------------------------------------------------

function roundToSum(probs, decimals = 6) {
  const keys = Object.keys(probs);
  const rounded = Object.fromEntries(keys.map((k) => [k, Number(probs[k].toFixed(decimals))]));
  const largest = keys.reduce((a, b) => (rounded[a] >= rounded[b] ? a : b));
  const rest = keys.filter((k) => k !== largest).reduce((s, k) => s + rounded[k], 0);
  rounded[largest] = Number((1 - rest).toFixed(decimals));
  return rounded;
}

// A per-option market table can be blended only when option-market.mjs built
// it (its produced_by marker and a table_hash that still matches the option
// names and prices), the tool found no problem, it names every option exactly
// once, every price is a number from 0 to 1, and the prices add up to 1
// within multiple_choice.market_sum_tolerance. Otherwise every reason is a
// flag: the tool's own codes as option_market_<code> (partial, bad_sum,
// duplicate_market, ...), then aggregate's own checks, then
// option_market_not_from_tool for a table typed or edited by hand.
export function optionMarketProblems(market, options, method) {
  if (!isObj(market)) return [];
  const out = [];
  const codes = Array.isArray(market.problem_codes) ? market.problem_codes.filter((c) => OPTION_TABLE_CODES.includes(c)) : [];
  for (const code of codes) out.push(`option_market_${code}`);
  if (!codes.length && Array.isArray(market.mapping_problems) && market.mapping_problems.length) out.push('option_market_mapping_refused');
  const probs = market.probabilities;
  if (!isObj(probs)) {
    out.push('option_market_missing_probabilities');
    return [...new Set(out)];
  }
  const keys = Object.keys(probs);
  if (!(keys.length === options.length && options.every((o) => Object.hasOwn(probs, o)))) out.push('option_market_partial');
  else if (options.some((o) => !isNum(probs[o]) || probs[o] < 0 || probs[o] > 1)) out.push('option_market_bad_price');
  else {
    const sum = options.reduce((s, o) => s + probs[o], 0);
    if (!(Math.abs(sum - 1) <= method.multiple_choice.market_sum_tolerance)) out.push('option_market_bad_sum');
  }
  if (!isToolTable(market)) out.push('option_market_not_from_tool');
  return [...new Set(out)];
}

// The first reason, or null when the table can be blended.
export function optionMarketProblem(market, options, method) {
  return optionMarketProblems(market, options, method)[0] ?? null;
}

function aggregateMultipleChoice(valid, signals, method, options) {
  const floor = method.multiple_choice.floor;
  const medians = Object.fromEntries(options.map((o) => [o, median(valid.map((v) => v.value[o]))]));
  let combined = normalizeWithFloor(medians, floor);
  const flags = [];
  const m = signals.market;
  const problems = m ? optionMarketProblems(m, options, method) : [];
  let weight = 0;
  let why = '';
  if (m && problems.length) {
    flags.push(...problems);
    why = `not blended: ${problems.map((p) => p.replace(/_/g, ' ')).join(', ')}`;
  } else if (m) {
    weight = marketWeight(m, method);
    if (weight > 0) {
      // The market table gets the same floor and renormalising as the passes.
      const marketProbs = normalizeWithFloor(Object.fromEntries(options.map((o) => [o, m.probabilities[o]])), floor);
      combined = normalizeWithFloor(Object.fromEntries(options.map((o) => [o, (1 - weight) * combined[o] + weight * marketProbs[o]])), floor);
      flags.push('option_market_blended');
    } else {
      why = 'no weight: thin, play-money or not the same event';
    }
  }
  const plainSum = options.reduce((s, o) => s + medians[o], 0);
  const floored = options.some((o) => medians[o] / plainSum < floor);
  const final = roundToSum(combined);

  const spread = Math.max(...options.map((o) => Math.max(...valid.map((v) => v.value[o])) - Math.min(...valid.map((v) => v.value[o]))));
  if (spread > method.flags.pass_spread) flags.push('wide_pass_spread');

  const short = (o) => (o.length > 40 ? `${o.slice(0, 37)}...` : o);
  return {
    forecast: { probabilities: final },
    passes: valid.map((v) => ({ pass: passNumber(v.file), probabilities: roundToSum(v.value, 4), reason: v.reason })),
    clamped: floored,
    weight,
    flags,
    lines: {
      forecast: `Forecast: ${options.map((o) => `${short(o)} ${pct(final[o])}`).join(', ')} (bot v${method.version}, fully automated, no human input)`,
      markets: signalLine({ ...signals, community: null }, { kind: 'market', weight, why }),
      passes: `Passes: ${valid.map((v) => `P${passNumber(v.file)} ${options.map((o) => fmt(v.value[o])).join('/')}`).join(' ')}; aggregate = median per option${weight ? `, blended with the market table at w=${weight}` : ''}; floor applied: ${floored ? 'yes' : 'no'}.`,
    },
  };
}

// ---- numeric, discrete, date ------------------------------------------------

// Stretches every pass along the question's own axis (linear or log) around
// the axis point `center` by the factor k. On a log scale this widens in
// ratios, so a price band grows the way prices move.
function stretchSets(sets, center, k, scaling) {
  return sets.map((set) => Object.fromEntries(Object.entries(set).map(([p, v]) => {
    const x = locationOf(v, scaling);
    return [p, Number.isFinite(x) ? valueAt(center + k * (x - center), scaling) : v];
  })));
}

function bandOf(cdf, scaling) {
  const p10 = quantileOf(cdf, 0.1, scaling);
  const p90 = quantileOf(cdf, 0.9, scaling);
  return { p10, p90, width: p10 !== null && p90 !== null ? p90 - p10 : null };
}

const BISECTION_STEPS = 40;
const FACTOR_TOLERANCE = 1e-4;
// A widening by a factor at or below this is no widening: the guard is skipped.
const MIN_USEFUL_FACTOR = 1.01;
// Grid points scanned below an unsafe needed factor before the bisection.
const GRID_STEPS = 64;
// On a closed bound, values pushed past the bound are folded into the bins at
// the bound, so the guard watches the mass in the outermost EDGE_BINS bins of
// each closed side (cdf[2] - cdf[0] below, cdf[last] - cdf[last - 2] above).
export const EDGE_BINS = 2;

// Mass watched on each side: outside an open bound, or in the edge region of
// a closed one.
export function sideMasses(cdf, scaling) {
  const last = cdf.length - 1;
  const edge = Math.min(EDGE_BINS, Math.floor(last / 2));
  return {
    lower: scaling.open_lower_bound === true ? cdf[0] : cdf[edge] - cdf[0],
    upper: scaling.open_upper_bound === true ? 1 - cdf[last] : cdf[last] - cdf[last - edge],
  };
}

// The series guard: if the 10-90 band is under share x the series band for the
// same horizon, widen the whole distribution around its median by a factor k.
//
// k is the LARGEST factor that is (a) not above the factor needed to reach the
// target width, (b) not above maxFactor, and (c) safe. A factor is safe when
// every check holds:
//   - the CDF can be built and passes the CDF validator ('invalid_cdf');
//   - the 10th and 90th percentiles stay inside the question range ('bounds');
//   - the mass outside each open bound, or in the outermost EDGE_BINS bins of
//     each closed bound, grew by at most maxOutsideGrowth
//     ('outside_mass_lower' / 'outside_mass_upper' / 'edge_mass_lower' /
//     'edge_mass_upper');
//   - the median moved by less than one bin of the question's grid
//     ('median_moved').
//
// Step 1 bisects for the needed factor (a factor whose band leaves the range
// counts as an upper limit, never "too narrow"). Step 2 tests that factor;
// if it is unsafe, a grid of GRID_STEPS points below it is scanned from the
// top for the largest safe point, and a bisection between that point and the
// unsafe point above it refines the factor (k = 1, the unwidened curve, is
// always safe). The safe end is used.
//
// Result: reached (the target width was reached), capped (why a smaller
// factor was used: 'bounds', 'max_factor' or a check name), skipped (no factor
// above MIN_USEFUL_FACTOR is safe; the unwidened curve is kept), and the mass
// change per side.
export function widenToSeriesBand(sets, scaling, targetWidth, { maxFactor = 3, maxOutsideGrowth = 0.05 } = {}) {
  const first = buildCdfWithInfo(sets, scaling);
  const before = bandOf(first.cdf, scaling);
  const mass0 = sideMasses(first.cdf, scaling);
  const regions = {
    lower: scaling.open_lower_bound === true ? 'outside' : 'edge',
    upper: scaling.open_upper_bound === true ? 'outside' : 'edge',
  };
  const unchanged = (extra = {}) => ({
    built: first, widened: false, reached: false, before, after: before, factor: 1, capped: null, skipped: null,
    neededFactor: null, massChange: { lower: 0, upper: 0 }, regions, ...extra,
  });
  if (!(isNum(targetWidth) && targetWidth > 0) || before.width === null || !(before.width < targetWidth)) return unchanged();
  if (!(isNum(maxFactor) && maxFactor > 1)) return unchanged({ skipped: 'max_factor_invalid' });
  const medianValue = quantileOf(first.cdf, 0.5, scaling);
  if (medianValue === null) return unchanged({ skipped: 'median_not_computable' });
  const center = locationOf(medianValue, scaling);
  const limit = isNum(maxOutsideGrowth) && maxOutsideGrowth >= 0 ? maxOutsideGrowth : 0;

  const cache = new Map();
  const tryFactor = (k) => {
    if (cache.has(k)) return cache.get(k);
    let result;
    let built = null;
    try {
      built = buildCdfWithInfo(stretchSets(sets, center, k, scaling), scaling);
    } catch {
      built = null;
    }
    if (built === null) {
      result = { k, state: 'over', built: null, band: null, fail: 'invalid_cdf' };
    } else {
      const band = bandOf(built.cdf, scaling);
      const state = band.width === null ? 'over' : band.width >= targetWidth ? 'reaches' : 'short';
      const cdf = built.cdf;
      const mass = sideMasses(cdf, scaling);
      const massChange = { lower: mass.lower - mass0.lower, upper: mass.upper - mass0.upper };
      let fail = null;
      if (validateCdf(cdf, scaling).length) fail = 'invalid_cdf';
      else if (band.width === null) fail = 'bounds';
      else if (massChange.lower > limit) fail = `${regions.lower}_mass_lower`;
      else if (massChange.upper > limit) fail = `${regions.upper}_mass_upper`;
      else {
        const m = quantileOf(cdf, 0.5, scaling);
        if (m === null || !(Math.abs(locationOf(m, scaling) - center) < 1 / (cdf.length - 1))) fail = 'median_moved';
      }
      result = { k, state, built, band, fail, massChange };
    }
    cache.set(k, result);
    return result;
  };

  // Step 1: the factor needed for the target, bounded by maxFactor and the range.
  let upper;
  let capped = null;
  const top = tryFactor(maxFactor);
  if (top.state === 'short') {
    upper = top;
    capped = 'max_factor';
  } else {
    // Invariant: lo is short (narrower than the target, inside the range),
    // hi is not short (reaches the target, or leaves the range).
    let lo = { k: 1, state: 'short' };
    let hi = top;
    for (let i = 0; i < BISECTION_STEPS && hi.k - lo.k > FACTOR_TOLERANCE; i += 1) {
      const mid = tryFactor((lo.k + hi.k) / 2);
      if (mid.state === 'short') lo = mid;
      else hi = mid;
    }
    if (hi.state === 'reaches') upper = hi;
    else {
      upper = lo.k > 1 ? lo : tryFactor(1 + FACTOR_TOLERANCE);
      capped = 'bounds';
    }
  }
  // Closed bounds stop the band growing: the target is then out of reach
  // because of the bounds, not because of the factor limit.
  if (capped === 'max_factor') {
    const span = Math.abs(scaling.range_max - scaling.range_min);
    const pastClosed = stretchSets(sets, center, maxFactor, scaling).some((set) => Object.values(set).some((v) => (
      (scaling.open_lower_bound !== true && v <= scaling.range_min) || (scaling.open_upper_bound !== true && v >= scaling.range_max))));
    if (targetWidth >= span || pastClosed) capped = 'bounds';
  }
  const neededFactor = upper.state === 'reaches' ? upper.k : null;

  // Step 2: the largest safe factor not above `upper`.
  let chosen = upper;
  if (upper.fail !== null) {
    // Safety is not always monotone in k (a percentile crossing a closed
    // bound changes how mass is folded into the edge bins), so first scan a
    // grid from the top down for the largest safe grid point, then refine by
    // bisection between it and the unsafe grid point just above.
    let lo = { k: 1, fail: null };
    let hi = upper;
    for (let i = GRID_STEPS - 1; i >= 1; i -= 1) {
      const g = tryFactor(1 + ((upper.k - 1) * i) / GRID_STEPS);
      if (g.fail === null) {
        lo = g;
        break;
      }
      hi = g;
    }
    for (let i = 0; i < BISECTION_STEPS && hi.k - lo.k > FACTOR_TOLERANCE; i += 1) {
      const mid = tryFactor((lo.k + hi.k) / 2);
      if (mid.fail === null) lo = mid;
      else hi = mid;
    }
    chosen = lo;
    // The check that stopped the search is the one failing just above it.
    capped = hi.fail;
  }
  const reached = chosen === upper && upper.state === 'reaches' && upper.fail === null;
  // A partial widening by 1.01 or less is not worth stating: the guard is
  // skipped. A target reached by a small safe factor is still used.
  if (!chosen.built || !(chosen.k > 1) || (!reached && !(chosen.k > MIN_USEFUL_FACTOR))) {
    return unchanged({ capped, skipped: capped ?? 'no_safe_factor', neededFactor, attempt: { factor: upper.k, band: upper.band } });
  }
  return {
    built: chosen.built, widened: true, reached, before, after: chosen.band, factor: chosen.k,
    capped: reached ? null : capped, skipped: null, neededFactor, massChange: chosen.massChange, regions,
  };
}

function aggregateContinuous(valid, signals, method, item) {
  const scaling = scalingOf(item);
  const c = method.continuous;
  const lo = scaling.range_min;
  const hi = scaling.range_max;
  const axis = (v) => locationOf(v, scaling);

  const passMedian = median(valid.map((v) => v.value['50']));
  const passMedianAxis = axis(passMedian);
  if (passMedianAxis < -2 || passMedianAxis > 3) throw new DataError('median_outside_range', 'the combined median is more than 2 range widths outside the range');

  const band = signals.context.series_band_width_10_90;
  // A band that is given but is not a positive number (a string, 0, -5) is
  // ignored, and the flag says so.
  const bandGiven = band !== undefined && band !== null;
  const bandUsable = isNum(band) && band > 0;
  const guardOn = bandUsable && item.type !== 'date';
  const target = guardOn ? c.series_band_min_share * band : 0;
  let guard;
  try {
    guard = widenToSeriesBand(valid.map((v) => v.value), scaling, target, {
      maxFactor: c.series_band_max_factor,
      maxOutsideGrowth: c.series_band_max_outside_growth,
    });
  } catch (error) {
    throw new DataError('cdf_build_failed', error.message);
  }
  const { cdf } = guard.built;
  const outside = valid.some((v) => Object.values(v.value).some((x) => (!scaling.open_lower_bound && x <= lo) || (!scaling.open_upper_bound && x >= hi)));

  // The comment states what is actually posted: quantiles of the final CDF.
  const cdfMedian = quantileOf(cdf, 0.5, scaling);
  const { p10, p90 } = guard.after;
  const flags = [];
  const gap = cdfMedian === null ? Infinity : Math.abs(axis(cdfMedian) - passMedianAxis);
  if (gap > c.median_gap_flag_axis_share) flags.push('cdf_median_far_from_pass_median');
  if (guard.built.binCapApplied) flags.push('bin_cap_applied');
  if (guardOn && guard.before.width !== null && guard.before.width < c.series_band_flag_ratio * band) flags.push('band_narrower_than_history');
  if (bandGiven && !bandUsable) flags.push('series_band_invalid_ignored');
  if (guard.widened && guard.reached) flags.push('band_widened_to_series');
  if (guard.widened && !guard.reached) {
    flags.push('band_widened_partly');
    if (guard.capped) flags.push(`band_widen_capped_by_${guard.capped}`);
  }
  if (guard.skipped) flags.push(`band_guard_skipped_${guard.skipped}`);

  const show = (v) => (v === null ? 'beyond range' : item.type === 'date' ? new Date(v * 1000).toISOString().slice(0, 10) : fmt(v));
  const unit = typeof item.unit === 'string' && item.unit ? ` ${item.unit}` : '';
  const g = c.series_band_max_outside_growth;
  const SKIP_TEXT = {
    bounds: 'the 10th or 90th percentile would leave the question range',
    max_factor: `the maximum factor ${c.series_band_max_factor}`,
    invalid_cdf: 'the widened curve failed the CDF check',
    outside_mass_lower: `more than ${g} extra probability below the range`,
    outside_mass_upper: `more than ${g} extra probability above the range`,
    edge_mass_lower: `more than ${g} extra probability in the ${EDGE_BINS} bins at the closed lower bound`,
    edge_mass_upper: `more than ${g} extra probability in the ${EDGE_BINS} bins at the closed upper bound`,
    median_moved: 'the median would move by a bin or more',
    no_safe_factor: 'no safe widening factor',
    median_not_computable: 'the median could not be computed',
    max_factor_invalid: 'no valid maximum factor in the method',
  };
  let widenNote = '';
  const CAP_TEXT = {
    bounds: ', stopped by the question range',
    max_factor: `, stopped at the maximum factor ${c.series_band_max_factor}`,
  };
  if (guard.widened && guard.reached) {
    widenNote = `; 10-90% band widened from ${show(guard.before.p10)}-${show(guard.before.p90)} to ${show(p10)}-${show(p90)} (series guard: at least ${c.series_band_min_share} x the series band ${fmt(band)}${unit})`;
  } else if (guard.widened) {
    const cap = CAP_TEXT[guard.capped] ?? `, stopped before ${SKIP_TEXT[guard.capped] ?? guard.capped}`;
    widenNote = `; 10-90% band widened partly from ${show(guard.before.p10)}-${show(guard.before.p90)} to ${show(p10)}-${show(p90)} by a factor of ${fmt(guard.factor)} (series guard: target ${c.series_band_min_share} x the series band ${fmt(band)}${unit} not reached${cap})`;
  } else if (guard.skipped) {
    widenNote = `; series guard skipped, band kept at ${show(guard.before.p10)}-${show(guard.before.p90)} (${SKIP_TEXT[guard.skipped] ?? guard.skipped})`;
  }
  return {
    forecast: { cdf },
    passes: valid.map((v) => ({ pass: passNumber(v.file), percentiles: v.value, reason: v.reason })),
    clamped: outside,
    weight: 0,
    flags,
    extraChecks: guardOn ? {
      series_band_width_10_90: band,
      band_width_10_90_before_guard: guard.before.width === null ? null : Number(guard.before.width.toPrecision(6)),
      band_width_10_90: guard.after.width === null ? null : Number(guard.after.width.toPrecision(6)),
      band_widened: guard.widened,
      band_widen_factor: Number(guard.factor.toPrecision(6)),
      band_guard_skipped: guard.skipped,
      band_widen_reached_target: guard.reached,
      band_widen_capped_by: guard.capped,
      band_widen_needed_factor: guard.neededFactor === null ? null : Number(guard.neededFactor.toPrecision(6)),
      band_widen_target_width: Number(target.toPrecision(6)),
      band_mass_region_lower: guard.regions.lower,
      band_mass_region_upper: guard.regions.upper,
      band_mass_change_lower: Number(guard.massChange.lower.toPrecision(4)),
      band_mass_change_upper: Number(guard.massChange.upper.toPrecision(4)),
    } : bandGiven && !bandUsable ? { series_band_width_10_90_ignored: typeof band === 'string' ? band.slice(0, 40) : band } : {},
    lines: {
      forecast: `Forecast: median ${show(cdfMedian)}${unit}, 10-90% band ${show(p10)} to ${show(p90)} (bot v${method.version}, fully automated, no human input)`,
      markets: signalLine({ ...signals, community: null }, { kind: 'market', weight: 0 }).replace('none used', 'not blended for this type'),
      passes: `Passes: ${valid.map((v) => `P${passNumber(v.file)} median ${show(v.value['50'])}`).join(' ')}; aggregate = pointwise median of pass CDFs (median of pass medians ${show(passMedian)})${widenNote}; values moved inside closed bounds: ${outside ? 'yes' : 'no'}.`,
    },
  };
}

function requireCount(count, minValid) {
  if (count === 0) throw new DataError('no_valid_passes');
  if (count < minValid) throw new DataError('too_few_passes', `${count} valid, need ${minValid}; re-run the missing passes once, then use --allow-few`);
}

// ---- main -------------------------------------------------------------------

// Group and conditional questions share one post, so each comment names its part.
function scopeText(item) {
  if (item.post_kind === 'group' && typeof item.label === 'string' && item.label.trim()) {
    return ` for "${item.label.trim().slice(0, 60)}"`;
  }
  if (item.post_kind === 'conditional' && ['yes', 'no'].includes(item.conditional?.branch)) {
    return ` if the condition resolves ${item.conditional.branch}`;
  }
  return '';
}

export const NOT_INDEPENDENT_NOTE = ' (passes written in sequence by one agent, not independent)';

export function aggregate({ item, passes, signals: rawSignals, method, allowFew = false, passesNotIndependent = false, fastPath = false }) {
  const question = toValidatorQuestion(item);
  const signals = normalizeSignals(rawSignals);
  const minValid = allowFew ? 1 : method.min_valid_passes;
  const required = requiredPasses(method, fastPath);
  if (!Number.isInteger(required) || required < 1) throw new DataError('method_passes_invalid', 'method.json passes / fast_path_passes');
  const { valid, dropped, outOfRange, duplicates } = splitPasses(item, passes, method, required);
  requireCount(valid.length, minValid);

  let result;
  if (question.type === 'binary') result = aggregateBinary(valid, signals, method);
  else if (question.type === 'multiple_choice') result = aggregateMultipleChoice(valid, signals, method, question.options ?? []);
  else result = aggregateContinuous(valid, signals, method, item);
  result.lines.forecast = result.lines.forecast.replace(' (bot v', `${scopeText(item)} (bot v`);

  // Passes the method requires but that are missing or unusable.
  const validNumbers = new Set(valid.map((v) => passNumber(v.file)));
  const missing = Array.from({ length: required }, (_, i) => i + 1).filter((k) => !validNumbers.has(k));
  if (valid.length < required) {
    result.flags.unshift('fewer_passes_than_required');
    const which = missing.length ? ` (missing or invalid: ${missing.map((k) => `P${k}`).join(', ')})` : '';
    result.lines.passes = result.lines.passes.replace(/\.$/, `; only ${valid.length} of ${required} required passes valid${which}.`);
  }
  if (duplicates.length) {
    result.flags.push('duplicate_pass_number');
    result.lines.passes = result.lines.passes.replace(/\.$/, `; several files for ${duplicates.map((k) => `P${k}`).join(', ')}, each counted once.`);
  }
  if (outOfRange.length) {
    result.flags.push('pass_number_out_of_range');
    result.lines.passes = result.lines.passes.replace(/\.$/, `; ${outOfRange.length} file(s) numbered outside P1-P${required} ignored.`);
  }
  if (passesNotIndependent) {
    result.lines.passes = result.lines.passes.replace(/\.$/, `${NOT_INDEPENDENT_NOTE}.`);
    result.flags.push('passes_not_independent');
  }

  return {
    question_id: question.question_id,
    type: question.type,
    method_version: method.version,
    forecast: result.forecast,
    passes: result.passes,
    signals: { market: signals.market, community: signals.community, base_rate: signals.base_rate },
    checks: {
      validated: true,
      clamped: result.clamped,
      blend_weight: result.weight,
      passes_required: required,
      passes_valid: valid.length,
      ...(result.extraChecks ?? {}),
      flags: [...result.flags],
    },
    flags: result.flags,
    dropped_passes: dropped,
    comment_lines: result.lines,
  };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: {
    question: { type: 'string' }, passes: { type: 'string' }, signals: { type: 'string' },
    out: { type: 'string' }, 'allow-few': { type: 'boolean', default: false },
    'passes-not-independent': { type: 'boolean', default: false },
    'fast-path': { type: 'boolean', default: false },
  },
  async main(values) {
    required(values, 'question', 'passes');
    const method = await loadMethod();
    const item = await readJson(values.question, 'question file');
    const signals = values.signals ? await readJson(values.signals, 'signals file') : {};
    const passes = await loadPasses(values.passes).catch((error) => {
      if (error instanceof DataError) throw error;
      throw new DataError('passes_unreadable', values.passes);
    });
    const result = aggregate({
      item, passes, signals, method,
      allowFew: values['allow-few'], passesNotIndependent: values['passes-not-independent'], fastPath: values['fast-path'],
    });
    if (values.out) await writeJson(values.out, result);
    return result;
  },
});
