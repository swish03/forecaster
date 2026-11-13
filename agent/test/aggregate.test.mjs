import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { aggregate, communityWeight, marketWeight, parsePassText, loadPasses } from '../tools/aggregate.mjs';
import { cdfFromPercentiles, medianCdf, standardizeCdf, validateCdf } from '../../lib/cdf.mjs';
import { logit, sigmoid } from '../../lib/prob.mjs';
import { toValidatorQuestion } from '../tools/core/question.mjs';
import { OPTION_TABLE_MARKER, optionTableHash } from '../tools/core/option-table.mjs';
import { binaryPasses, itemFor, mcPasses, pctPasses, spreadAround, tempDataRepo, writeJsonFile } from './helpers.mjs';
import { writeFile } from 'node:fs/promises';

const METHOD = JSON.parse(readFileSync(new URL('../method.json', import.meta.url), 'utf8'));
// The community signal is off until the owner switches it on; these tests check the rule when it is on.
const WITH_COMMUNITY = { ...METHOD, blend: { ...METHOD.blend, community_enabled: true } };
const run = (item, passes, signals = {}, extra = {}) => aggregate({ item, passes, signals, method: METHOD, ...extra });
const market = (volume, extra = {}) => ({ venue: 'polymarket', id: '1', title: 'same event', match: 'same', price_yes: 0.6, volume_usd: volume, spread: 0.02, real_money: true, checked_at: '2026-11-16T09:50:00Z', ...extra });

// ---- binary -----------------------------------------------------------------

test('binary: median of five passes, no signal, no clamp', () => {
  const out = run(itemFor('binary'), binaryPasses([0.2, 0.3, 0.25, 0.4, 0.1]));
  assert.deepEqual(out.forecast, { probability_yes: 0.25 });
  assert.deepEqual(out.checks, { validated: true, clamped: false, blend_weight: 0, passes_required: 5, passes_valid: 5, flags: [] });
  assert.equal(out.passes.length, 5);
  assert.match(out.comment_lines.forecast, new RegExp(`^Forecast: 25% \\(bot v${METHOD.version.replace('.', '\\.')}, fully automated, no human input\\)$`));
});

test('binary: four valid passes use the mean of the middle two; a broken pass is dropped', () => {
  const passes = binaryPasses([0.2, 0.3, 0.4, 0.5]);
  passes.push({ file: 'pass-5.md', data: null });
  const out = run(itemFor('binary'), passes);
  assert.equal(out.forecast.probability_yes, 0.35);
  assert.equal(out.dropped_passes.length, 1);
});

test('binary: fewer than three valid passes is refused unless --allow-few', () => {
  assert.throws(() => run(itemFor('binary'), binaryPasses([0.2, 0.3])), { code: 'too_few_passes' });
  assert.equal(run(itemFor('binary'), binaryPasses([0.2, 0.3]), {}, { allowFew: true }).forecast.probability_yes, 0.25);
  assert.throws(() => run(itemFor('binary'), [{ file: 'pass-1.md', data: { p: 2 } }], {}, { allowFew: true }), { code: 'no_valid_passes' });
});

test('blend weights follow market volume and spread, and community size', () => {
  const cases = [
    [market(5000), 0], [market(9999), 0], [market(10000), 0.15], [market(49999), 0.15], [market(50000), 0.3],
    [market(250000), 0.3], [market(300000, { spread: 0.03 }), 0.5], [market(300000, { spread: 0.05 }), 0.3],
    [market(300000, { spread: null }), 0.3], [market(1e6, { match: 'related' }), 0], [market(1e6, { real_money: false }), 0],
    [market(null), 0], [null, 0],
  ];
  for (const [m, w] of cases) assert.equal(marketWeight(m, METHOD), w, JSON.stringify(m));
  assert.equal(communityWeight({ forecasters: 29 }, WITH_COMMUNITY), 0);
  assert.equal(communityWeight({ forecasters: 30 }, WITH_COMMUNITY), 0.25);
  assert.equal(communityWeight({ forecasters: 99 }, WITH_COMMUNITY), 0.25);
  assert.equal(communityWeight({ forecasters: 100 }, WITH_COMMUNITY), 0.4);
  assert.equal(communityWeight(null, WITH_COMMUNITY), 0);
  assert.equal(communityWeight({ forecasters: 500 }, METHOD), 0, 'off by default');
});

test('binary: blend is in log-odds; a weighted same market comes first, else the community', () => {
  const passes = binaryPasses([0.3, 0.3, 0.3, 0.3, 0.3]);
  const out = run(itemFor('binary'), passes, { market: market(60000), community: null, base_rate: 'about 30%' });
  const expected = Number(sigmoid(0.7 * logit(0.3) + 0.3 * logit(0.6)).toFixed(4));
  assert.equal(out.forecast.probability_yes, expected);
  assert.equal(out.checks.blend_weight, 0.3);
  assert.equal(out.signals.base_rate, 'about 30%');
  assert.match(out.comment_lines.markets, /market used, weight w=0\.3/);

  const community = { forecasters: 120, probability_yes: 0.5 };
  const both = run(itemFor('binary'), passes, { market: market(20000), community }, { method: WITH_COMMUNITY });
  assert.equal(both.checks.blend_weight, 0.15, 'spec 3.5: the same market is used when it has weight');
  assert.match(both.comment_lines.markets, /market used/);
  const thinAndCommunity = run(itemFor('binary'), passes, { market: market(2000), community }, { method: WITH_COMMUNITY });
  assert.equal(thinAndCommunity.checks.blend_weight, 0.4);
  assert.match(thinAndCommunity.comment_lines.markets, /community used/);
  assert.equal(run(itemFor('binary'), passes, { community }).checks.blend_weight, 0, 'community off by default');

  const thin = run(itemFor('binary'), passes, { market: market(2000) });
  assert.equal(thin.forecast.probability_yes, 0.3);
  assert.equal(thin.checks.blend_weight, 0);
  assert.ok(thin.signals.market, 'a thin market is still recorded');
});

test('binary: clamp to [0.02, 0.98]; the wide clamp needs all five passes extreme and a reason', () => {
  const high = binaryPasses([0.995, 0.99, 0.999, 0.985, 0.99]);
  const normal = run(itemFor('binary'), high);
  assert.equal(normal.forecast.probability_yes, 0.98);
  assert.equal(normal.checks.clamped, true);

  const wide = run(itemFor('binary'), high, { context: { status_quo_short_horizon: true } });
  assert.equal(wide.forecast.probability_yes, 0.99);
  assert.ok(wide.flags.includes('wide_clamp_used'));

  const deep = run(itemFor('binary'), binaryPasses([0.01, 0.005, 0.01, 0.015, 0.02]), { market: market(500000, { price_yes: 0.03 }) });
  assert.ok(deep.forecast.probability_yes >= 0.01 && deep.forecast.probability_yes < 0.02, String(deep.forecast.probability_yes));

  const notAll = run(itemFor('binary'), binaryPasses([0.995, 0.99, 0.999, 0.9, 0.99]), { context: { status_quo_short_horizon: true } });
  assert.equal(notAll.forecast.probability_yes, 0.98);

  const low = run(itemFor('binary'), binaryPasses([0, 0, 0.001, 0, 0]));
  assert.equal(low.forecast.probability_yes, 0.02);
});

test('binary: sanity flags are raised but never block', () => {
  const out = run(itemFor('binary'), binaryPasses([0.05, 0.5, 0.95, 0.94, 0.96]), { context: { status_quo: 'no' } });
  assert.ok(out.flags.includes('wide_pass_spread'));
  assert.ok(out.flags.includes('high_against_status_quo'));
  const gap = run(itemFor('binary'), binaryPasses([0.1, 0.1, 0.1, 0.1, 0.1]), { market: market(400000, { price_yes: 0.8 }) });
  assert.ok(gap.flags.includes('median_far_from_signal'));
});

// ---- multiple choice --------------------------------------------------------

test('multiple choice: median per option, floor at 1%, renormalised to exactly 1', () => {
  const sets = [
    { Alpha: 0.7, Beta: 0.3, 'Gamma (Δ)': 0 },
    { Alpha: 0.6, Beta: 0.4, 'Gamma (Δ)': 0 },
    { Alpha: 0.8, Beta: 0.2, 'Gamma (Δ)': 0 },
    { Alpha: 0.65, Beta: 0.35, 'Gamma (Δ)': 0 },
    { Alpha: 0.75, Beta: 0.25, 'Gamma (Δ)': 0 },
  ];
  const out = run(itemFor('multiple_choice'), mcPasses(sets));
  const p = out.forecast.probabilities;
  assert.deepEqual(Object.keys(p), ['Alpha', 'Beta', 'Gamma (Δ)']);
  assert.equal(p['Gamma (Δ)'], 0.01);
  assert.ok(Math.abs(p.Alpha - 0.7 * 0.99) < 1e-6);
  assert.ok(Math.abs(p.Alpha + p.Beta + p['Gamma (Δ)'] - 1) < 1e-9);
  assert.equal(out.checks.clamped, true);
});

test('multiple choice: a pass whose option names differ in any character is dropped', () => {
  const good = { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 };
  const passes = mcPasses([good, good, good, { Alpha: 0.1, Beta: 0.1, 'Gamma (D)': 0.8 }]);
  const out = run(itemFor('multiple_choice'), passes);
  assert.equal(out.passes.length, 3);
  assert.equal(out.dropped_passes.length, 1);
  assert.equal(out.forecast.probabilities.Alpha, 0.5);
});

test('multiple choice: unnormalised passes are scaled first; a matched market with the same options is blended', () => {
  const passes = mcPasses([{ Alpha: 5, Beta: 3, 'Gamma (Δ)': 2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }]);
  // The table carries the marker and hash option-market.mjs writes (method 1.3);
  // the same table without them is typed by hand and is not blended.
  const probabilities = { Alpha: 0.1, Beta: 0.1, 'Gamma (Δ)': 0.8 };
  const handTyped = market(100000, { price_yes: undefined, probabilities });
  const m = { ...handTyped, produced_by: OPTION_TABLE_MARKER, table_hash: optionTableHash(probabilities), problem_codes: [], mapping_problems: [] };
  const typed = run(itemFor('multiple_choice'), passes, { market: handTyped });
  assert.equal(typed.checks.blend_weight, 0);
  assert.ok(typed.flags.includes('option_market_not_from_tool'));
  const out = run(itemFor('multiple_choice'), passes, { market: m });
  assert.equal(out.checks.blend_weight, 0.3);
  assert.ok(Math.abs(out.forecast.probabilities['Gamma (Δ)'] - (0.7 * 0.2 + 0.3 * 0.8)) < 1e-6);
  const wrongOptions = run(itemFor('multiple_choice'), passes, { market: market(100000, { probabilities: { Alpha: 1 } }) });
  assert.equal(wrongOptions.checks.blend_weight, 0);
});

// ---- continuous -------------------------------------------------------------

test('numeric: the CDF is the pointwise median of the pass CDFs, then standardised', () => {
  const item = itemFor('numeric');
  const scaling = toValidatorQuestion(item).scaling;
  const sets = [spreadAround(40, 8), spreadAround(50, 10), spreadAround(55, 6), spreadAround(45, 12), spreadAround(60, 9)];
  const out = run(item, pctPasses(sets));
  const expected = standardizeCdf(medianCdf(sets.map((s) => cdfFromPercentiles(s, scaling))), scaling);
  assert.deepEqual(out.forecast.cdf, expected);
  assert.deepEqual(validateCdf(out.forecast.cdf, scaling), []);
  assert.equal(out.forecast.cdf.length, 201);
  assert.match(out.comment_lines.forecast, /^Forecast: median 50 points, 10-90% band/);
});

test('numeric: the unit check drops passes far outside the range or far too narrow', () => {
  const sets = [spreadAround(50, 10), spreadAround(52, 10), spreadAround(48, 10), spreadAround(50000, 1000), spreadAround(50, 0.001)];
  const out = run(itemFor('numeric'), pctPasses(sets));
  assert.equal(out.passes.length, 3);
  assert.deepEqual(out.dropped_passes.map((d) => d.file), ['pass-4.json', 'pass-5.json']);
});

test('numeric: passes missing the median or going down are dropped', () => {
  const noMedian = spreadAround(50, 10);
  delete noMedian['50'];
  const down = { ...spreadAround(50, 10), 60: 10 };
  const out = run(itemFor('numeric'), pctPasses([spreadAround(50, 10), spreadAround(50, 10), spreadAround(50, 10), noMedian, down]));
  assert.equal(out.dropped_passes.length, 2);
});

test('numeric on a log scale, discrete with N + 1 points, and date with ISO values all give valid CDFs', () => {
  const log = run(itemFor('numeric_log'), pctPasses([spreadAround(300, 80), spreadAround(400, 100), spreadAround(350, 90)]));
  assert.deepEqual(validateCdf(log.forecast.cdf, toValidatorQuestion(itemFor('numeric_log')).scaling), []);
  assert.equal(log.forecast.cdf[0], 0);

  const discrete = run(itemFor('discrete'), pctPasses([spreadAround(4, 1.5), spreadAround(5, 1.5), spreadAround(4.5, 2)]));
  assert.equal(discrete.forecast.cdf.length, 11);
  assert.deepEqual(validateCdf(discrete.forecast.cdf, toValidatorQuestion(itemFor('discrete')).scaling), []);

  const day = (d) => `2027-0${d}-15T00:00:00Z`;
  const dates = { 1: day(1), 5: day(1), 10: day(2), 20: day(2), 40: day(3), 50: day(3), 60: day(4), 80: day(4), 90: day(5), 95: day(5), 99: day(6) };
  const date = run(itemFor('date'), pctPasses([dates, dates, dates]));
  assert.deepEqual(validateCdf(date.forecast.cdf, toValidatorQuestion(itemFor('date')).scaling), []);
  assert.match(date.comment_lines.forecast, /median 2027-03-1/);
});

test('numeric: a 10-90 band much narrower than the history is flagged', () => {
  const out = run(itemFor('numeric'), pctPasses([spreadAround(50, 1), spreadAround(50, 1), spreadAround(50, 1)]), { context: { series_band_width_10_90: 30 } });
  assert.ok(out.flags.includes('band_narrower_than_history'));
});

// ---- reading pass files -----------------------------------------------------

test('pass files: the last fenced json block of a .md file is read', async (t) => {
  const text = 'Thinking...\n```json\n{"p": 0.9}\n```\nRevised:\n```json\n{"p": 0.3, "reason": "base rate"}\n```\n';
  assert.deepEqual(parsePassText(text, 'pass-1.md'), { p: 0.3, reason: 'base rate' });
  assert.equal(parsePassText('no block', 'pass-1.md'), null);

  const dir = await tempDataRepo(t);
  await writeFile(join(dir, 'pass-2.md'), text);
  await writeJsonFile(join(dir, 'pass-10.json'), { p: 0.4 });
  await writeFile(join(dir, 'notes.md'), 'ignored');
  const passes = await loadPasses(dir);
  assert.deepEqual(passes.map((p) => p.file), ['pass-2.md', 'pass-10.json']);
});

// ---- reviewed numeric cases -------------------------------------------------

const logItem = (min, max, openUpper = true) => itemFor('numeric', 50, {
  range: { range_min: min, range_max: max, zero_point: 0, open_lower_bound: false, open_upper_bound: openUpper, inbound_outcome_count: 200, cdf_points: 201 },
});

test('continuous: the comment states the median of the posted CDF, even with mass on a closed log bound', () => {
  const set = { 1: 1, 2.5: 1, 5: 1, 10: 2, 20: 4, 40: 8, 50: 10, 60: 13, 80: 60, 90: 100, 99: 5000 };
  const out = run(logItem(1, 1e6), pctPasses([set, set, set]));
  const stated = Number(out.comment_lines.forecast.match(/median ([\d.]+)/)[1]);
  assert.ok(stated > 8 && stated < 13, `stated median ${stated}`);
  assert.ok(!out.flags.includes('cdf_median_far_from_pass_median'));
});

test('continuous: unit checks work on the log axis, so wide log questions keep their passes', () => {
  const set = { 1: 1, 2.5: 2, 5: 3, 10: 5, 20: 10, 40: 20, 50: 30, 60: 45, 80: 100, 90: 200, 95: 400, 97.5: 600, 99: 1000 };
  const out = run(logItem(1, 1e6), pctPasses([set, set, set]));
  assert.equal(out.dropped_passes.length, 0);
  const tooNarrow = { ...Object.fromEntries(Object.keys(set).map((k) => [k, 30])) };
  assert.throws(() => run(logItem(1, 1e6), pctPasses([tooNarrow, tooNarrow, tooNarrow])), { code: 'no_valid_passes' });
});

test('continuous: a confident discrete forecast is flagged when the per-bin cap moves mass', () => {
  const item = itemFor('discrete', 51, { range: { range_min: -0.5, range_max: 4.5, zero_point: null, open_lower_bound: false, open_upper_bound: false, inbound_outcome_count: 5, cdf_points: 6 } });
  const sure = Object.fromEntries(['1', '2.5', '5', '10', '20', '40', '50', '60', '80', '90', '95', '97.5', '99'].map((k) => [k, 3]));
  sure['1'] = 2.6;
  sure['99'] = 3.4;
  const out = run(item, pctPasses([sure, sure, sure]));
  assert.ok(out.flags.includes('bin_cap_applied'));
});

test('multiple choice: a market whose prices sum to zero is ignored, not divided by', () => {
  const sets = [{ Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }];
  const zero = market(500000, { price_yes: null, probabilities: { Alpha: 0, Beta: 0, 'Gamma (Δ)': 0 } });
  const out = run(itemFor('multiple_choice'), mcPasses(sets), { market: zero });
  assert.equal(out.checks.blend_weight, 0);
  assert.equal(out.forecast.probabilities.Alpha, 0.5);
});
