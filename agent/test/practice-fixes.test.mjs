// Fixes from the practice round of 13 Nov 2026 (method 1.3): missing passes,
// the series guard for numeric bands, per-option market tables, the plan's
// two modes, check-run for one question, and the card check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregate, loadPasses, optionMarketProblem } from '../tools/aggregate.mjs';
import { checkPassFile } from '../tools/check-pass.mjs';
import { buildOptionMarket } from '../tools/option-market.mjs';
import { checkCard } from '../tools/check-card.mjs';
import { intake, chooseMode } from '../tools/intake.mjs';
import { checkRun } from '../tools/check-run.mjs';
import { writeForecast } from '../tools/write-forecast.mjs';
import { validateCdf } from '../../lib/cdf.mjs';
import { quantileOf } from '../tools/core/quantile.mjs';
import { toValidatorQuestion } from '../tools/core/question.mjs';
import { OPTION_TABLE_MARKER, optionTableHash } from '../tools/core/option-table.mjs';
import {
  NOW, binaryPasses, envelope, iso, itemFor, mcPasses, minutes, pctPasses, runTool, spreadAround, tempDataRepo, writeJsonFile,
} from './helpers.mjs';

const METHOD = JSON.parse(readFileSync(new URL('../method.json', import.meta.url), 'utf8'));
const run = (item, passes, signals = {}, extra = {}) => aggregate({ item, passes, signals, method: METHOD, ...extra });

// ---- 1. missing passes ------------------------------------------------------

test('method.json says how many passes each path needs', () => {
  assert.equal(METHOD.passes, 5);
  assert.equal(METHOD.fast_path_passes, 3);
  assert.equal(METHOD.min_valid_passes, 3);
});

test('aggregate: fewer passes than the method requires is flagged in flags, checks and the Passes line', () => {
  const passes = binaryPasses([0.5, 0.55, 0.54, 0.55]).slice(1); // pass-2 .. pass-4: P1 and P5 missing
  const out = run(itemFor('binary'), passes);
  assert.equal(out.forecast.probability_yes, 0.55);
  assert.ok(out.flags.includes('fewer_passes_than_required'));
  assert.ok(out.checks.flags.includes('fewer_passes_than_required'));
  assert.equal(out.checks.passes_required, 5);
  assert.equal(out.checks.passes_valid, 3);
  assert.match(out.comment_lines.passes, /only 3 of 5 required passes valid \(missing or invalid: P1, P5\)\.$/);
});

test('aggregate: a dropped pass counts as missing; the fast path needs only 3', () => {
  const passes = binaryPasses([0.2, 0.3, 0.25, 0.4]);
  passes.push({ file: 'pass-5.md', data: { p: 7 } });
  const out = run(itemFor('binary'), passes);
  assert.ok(out.flags.includes('fewer_passes_than_required'));
  assert.match(out.comment_lines.passes, /4 of 5 required passes valid \(missing or invalid: P5\)/);

  const fast = run(itemFor('binary'), binaryPasses([0.2, 0.3, 0.25]), {}, { fastPath: true });
  assert.equal(fast.checks.passes_required, 3);
  assert.ok(!fast.flags.includes('fewer_passes_than_required'));
  assert.doesNotMatch(fast.comment_lines.passes, /required passes/);
});

test('aggregate: under min_valid_passes is refused; --allow-few still flags the shortfall', () => {
  assert.throws(() => run(itemFor('binary'), binaryPasses([0.2, 0.3])), { code: 'too_few_passes' });
  const few = run(itemFor('binary'), binaryPasses([0.2, 0.3]), {}, { allowFew: true });
  assert.ok(few.checks.flags.includes('fewer_passes_than_required'));
});

test('aggregate CLI: exit 1 with fewer than min_valid_passes pass files', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('binary', 61);
  await writeJsonFile(join(dir, 'questions', '61.json'), item);
  await mkdir(join(dir, 'runs', '61', 'passes'), { recursive: true });
  for (const k of [1, 2]) await writeFile(join(dir, 'runs', '61', 'passes', `pass-${k}.md`), `reasoning\n\`\`\`json\n{"pass": ${k}, "p": 0.3}\n\`\`\`\n`);
  const res = await runTool('aggregate.mjs', ['--question', join(dir, 'questions', '61.json'), '--passes', join(dir, 'runs', '61', 'passes')]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /too_few_passes/);
});

test('the shortfall flag reaches the forecast file checks', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('binary', 62);
  await writeJsonFile(join(dir, 'questions', '62.json'), item);
  const agg = run(item, binaryPasses([0.2, 0.3, 0.25, 0.3]));
  const comment = `${agg.comment_lines.forecast}\nQuestion as read: test.\n${agg.comment_lines.markets}\n${agg.comment_lines.passes}`;
  await writeForecast({ item, aggregate: agg, comment, dataDir: dir, method: METHOD, nowMs: NOW });
  const file = JSON.parse(await readFile(join(dir, 'forecasts', '62.json'), 'utf8'));
  assert.ok(file.checks.flags.includes('fewer_passes_than_required'));
  assert.equal(file.checks.passes_valid, 4);
  assert.match(file.comment, /only 4 of 5 required passes valid/);
});

test('check-pass: a saved pass is checked with the same rules as aggregate', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('multiple_choice', 63);
  const good = join(dir, 'pass-1.md');
  await writeFile(good, 'why\n```json\n{"pass": 1, "probs": {"Alpha": 0.5, "Beta": 0.3, "Gamma (Δ)": 0.2}}\n```\n');
  const badName = join(dir, 'pass-2.md');
  await writeFile(badName, '```json\n{"pass": 2, "probs": {"Alpha": 0.5, "Beta": 0.3, "Gamma (D)": 0.2}}\n```\n');
  const noBlock = join(dir, 'pass-3.md');
  await writeFile(noBlock, 'I could not write the file.');
  assert.deepEqual(await checkPassFile({ item, path: good, method: METHOD }), { ok: true, file: 'pass-1.md' });
  assert.match((await checkPassFile({ item, path: badName, method: METHOD })).problem, /option names/);
  assert.match((await checkPassFile({ item, path: noBlock, method: METHOD })).problem, /no fenced json/);
  assert.match((await checkPassFile({ item, path: join(dir, 'pass-4.md'), method: METHOD })).problem, /file missing/);

  await writeJsonFile(join(dir, 'q.json'), item);
  const ok = await runTool('check-pass.mjs', ['--question', join(dir, 'q.json'), '--pass', good]);
  assert.equal(ok.code, 0, ok.stderr);
  const missing = await runTool('check-pass.mjs', ['--question', join(dir, 'q.json'), '--pass', join(dir, 'pass-5.md')]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).ok, false);
});

// ---- 4. the series guard for numeric bands ----------------------------------

const band = (cdf, item) => {
  const s = toValidatorQuestion(item).scaling;
  return { p10: quantileOf(cdf, 0.1, s), p50: quantileOf(cdf, 0.5, s), p90: quantileOf(cdf, 0.9, s) };
};

test('numeric: a band under the set share of the series band is widened around its median and flagged', () => {
  const item = itemFor('numeric');
  const sets = [spreadAround(50, 4), spreadAround(51, 4), spreadAround(49, 4)];
  const plain = run(item, pctPasses(sets));
  const before = band(plain.forecast.cdf, item);
  const out = run(item, pctPasses(sets), { context: { series_band_width_10_90: 20 } });
  const after = band(out.forecast.cdf, item);
  assert.ok(before.p90 - before.p10 < METHOD.continuous.series_band_min_share * 20);
  assert.ok(Math.abs(after.p90 - after.p10 - METHOD.continuous.series_band_min_share * 20) < 0.05, `width ${after.p90 - after.p10}`);
  assert.ok(Math.abs(after.p50 - before.p50) < 0.2, 'the median stays');
  assert.deepEqual(validateCdf(out.forecast.cdf, toValidatorQuestion(item).scaling), []);
  assert.ok(out.flags.includes('band_widened_to_series'));
  assert.ok(out.checks.flags.includes('band_widened_to_series'));
  assert.equal(out.checks.band_widened, true);
  assert.match(out.comment_lines.passes, /10-90% band widened from .* \(series guard: at least 0\.85 x the series band 20 points\)/);
  assert.deepEqual(out.passes.map((p) => p.percentiles), sets, 'the pass values themselves are kept as they were');
});

test('numeric: a band already wide enough is left alone; no band in signals means no guard', () => {
  const item = itemFor('numeric');
  const sets = [spreadAround(50, 10), spreadAround(52, 10), spreadAround(48, 10)];
  const plain = run(item, pctPasses(sets));
  const wide = run(item, pctPasses(sets), { context: { series_band_width_10_90: 10 } });
  assert.deepEqual(wide.forecast.cdf, plain.forecast.cdf);
  assert.ok(!wide.flags.includes('band_widened_to_series'));
  assert.equal(wide.checks.band_widened, false);
  assert.equal(plain.checks.band_widened, undefined);
});

test('numeric on a log scale: the guard widens in ratios and the CDF stays valid', () => {
  const item = itemFor('numeric_log');
  const sets = [spreadAround(1000, 40), spreadAround(1010, 40), spreadAround(990, 40)];
  // A band of 300 needs a factor of about 2.5 (within series_band_max_factor, 3).
  const out = run(item, pctPasses(sets), { context: { series_band_width_10_90: 300 } });
  const after = band(out.forecast.cdf, item);
  assert.ok(after.p90 - after.p10 >= 0.85 * 300 - 1, `width ${after.p90 - after.p10}`);
  assert.ok(out.flags.includes('band_widened_to_series'));
  assert.ok(after.p90 - after.p50 > after.p50 - after.p10, 'wider above the median, as ratios are');
  assert.deepEqual(validateCdf(out.forecast.cdf, toValidatorQuestion(item).scaling), []);
});

test('discrete with closed bounds: when the bounds stop the widening it is flagged as capped', () => {
  const item = itemFor('discrete');
  const sets = [spreadAround(4.5, 0.6), spreadAround(4.5, 0.6), spreadAround(4.5, 0.6)];
  const out = run(item, pctPasses(sets), { context: { series_band_width_10_90: 50 } });
  assert.ok(out.flags.includes('band_widen_capped_by_bounds'));
  assert.deepEqual(validateCdf(out.forecast.cdf, toValidatorQuestion(item).scaling), []);
});

// The practice round's real Brent passes (question 900003): band 37.7 USD
// against 51.9 from the series history. Read from the practice folder when it
// is next to this repository; outputs go to FORECASTER_FIXCHECK_DIR if set.
const PRACTICE = fileURLToPath(new URL('../../../practice/round_2026-11-13/forecaster-data/', import.meta.url));
const hasPractice = existsSync(join(PRACTICE, 'runs', '900003', 'passes'));

test('practice round: the Brent forecast is widened to 0.85 x the series band', { skip: !hasPractice && 'practice round files not present' }, async () => {
  const item = JSON.parse(await readFile(join(PRACTICE, 'questions', '900003.json'), 'utf8'));
  const signals = JSON.parse(await readFile(join(PRACTICE, 'runs', '900003', 'signals.json'), 'utf8'));
  const passes = await loadPasses(join(PRACTICE, 'runs', '900003', 'passes'));
  const out = run(item, passes, signals);
  const target = METHOD.continuous.series_band_min_share * signals.context.series_band_width_10_90;
  assert.ok(out.checks.band_width_10_90_before_guard < 38, String(out.checks.band_width_10_90_before_guard));
  assert.ok(Math.abs(out.checks.band_width_10_90 - target) < 0.1, `${out.checks.band_width_10_90} vs ${target}`);
  const b = band(out.forecast.cdf, item);
  assert.ok(Math.abs(b.p50 - 92.5) < 0.5, `median ${b.p50}`);
  assert.deepEqual(validateCdf(out.forecast.cdf, toValidatorQuestion(item).scaling), []);
  assert.ok(out.checks.flags.includes('band_widened_to_series'));
  assert.ok(out.checks.flags.includes('fewer_passes_than_required'), 'pass-5 was missing in the practice round');
  assert.match(out.comment_lines.passes, /only 4 of 5 required passes valid \(missing or invalid: P5\)/);

  const bitcoin = run(
    JSON.parse(await readFile(join(PRACTICE, 'questions', '900004.json'), 'utf8')),
    await loadPasses(join(PRACTICE, 'runs', '900004', 'passes')),
    JSON.parse(await readFile(join(PRACTICE, 'runs', '900004', 'signals.json'), 'utf8')),
  );
  assert.ok(bitcoin.checks.band_width_10_90 >= 0.85 * 27940.028 - 5);

  const sp = run(
    JSON.parse(await readFile(join(PRACTICE, 'questions', '900002.json'), 'utf8')),
    await loadPasses(join(PRACTICE, 'runs', '900002', 'passes')),
    JSON.parse(await readFile(join(PRACTICE, 'runs', '900002', 'signals.json'), 'utf8')),
  );
  assert.equal(sp.forecast.probability_yes, 0.55);
  assert.match(sp.comment_lines.passes, /only 3 of 5 required passes valid \(missing or invalid: P1, P5\)/);

  const outDir = process.env.FORECASTER_FIXCHECK_DIR;
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeJsonFile(join(outDir, '900003.aggregate.json'), out);
    await writeJsonFile(join(outDir, '900004.aggregate.json'), bitcoin);
    await writeJsonFile(join(outDir, '900002.aggregate.json'), sp);
  }
});

// ---- 5. multiple choice and markets -----------------------------------------

const mcItem = () => itemFor('multiple_choice', 70);
const sets = [{ Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }];
const kalshi = (id, sub, price, volume = 40000, spread = 0.02) => ({
  venue: 'kalshi', id, title: `Fed decision: ${sub}`, url: 'https://kalshi.com/markets/x', price_yes: price, outcomes: null,
  volume_usd: volume, liquidity_usd: null, spread, close_time: '2026-12-09T19:00:00.000Z', real_money: true, match_score: 0.5,
});
const marketsFile = (results) => ({ query: 'fed december', checked_at: '2026-11-16T09:50:00.000Z', results, errors: [], real_money_unreachable: false });

test('option-market: a set of yes/no markets on one event becomes a per-option table, prices copied by code', () => {
  const markets = marketsFile([kalshi('K-A', 'alpha', 0.62, 100000), kalshi('K-B', 'beta', 0.3, 60000), kalshi('K-G', 'gamma', 0.1, 80000)]);
  const map = { match: 'same', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-B' }, 'Gamma (Δ)': { venue: 'kalshi', id: 'K-G' } } };
  const out = buildOptionMarket({ item: mcItem(), markets, map, method: METHOD });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.market.probabilities, { Alpha: 0.62, Beta: 0.3, 'Gamma (Δ)': 0.1 });
  assert.equal(out.market.volume_usd, 60000, 'a set of markets uses its smallest volume (method 1.3), not the sum');
  assert.equal(out.market.spread, 0.02);
  assert.equal(out.market.match, 'same');

  const agg = run(mcItem(), mcPasses(sets), { market: out.market });
  assert.equal(agg.checks.blend_weight, 0.3);
  assert.ok(agg.flags.includes('option_market_blended'));
  const marketShare = 0.62 / 1.02;
  assert.ok(Math.abs(agg.forecast.probabilities.Alpha - (0.7 * 0.5 + 0.3 * marketShare)) < 1e-6);
  const sum = Object.values(agg.forecast.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.match(agg.comment_lines.passes, /blended with the market table at w=0\.3/);
});

test('option-market: one multi-outcome market counts its volume once', () => {
  const poly = { venue: 'polymarket', id: 'P1', title: 'Which one?', url: 'https://polymarket.com/event/x', price_yes: null,
    outcomes: { A: 0.55, B: 0.35, G: 0.1 }, volume_usd: 300000, spread: 0.01, real_money: true, close_time: null };
  const map = { match: 'same', options: { Alpha: { venue: 'polymarket', id: 'P1', outcome: 'A' }, Beta: { venue: 'polymarket', id: 'P1', outcome: 'B' }, 'Gamma (Δ)': { venue: 'polymarket', id: 'P1', outcome: 'G' } } };
  const out = buildOptionMarket({ item: mcItem(), markets: marketsFile([poly]), map, method: METHOD });
  assert.equal(out.status, 'ok');
  assert.equal(out.market.volume_usd, 300000);
  assert.equal(run(mcItem(), mcPasses(sets), { market: out.market }).checks.blend_weight, 0.5);
});

test('option-market: a partial mapping or a bad sum is not blended, and the flags say why', () => {
  const markets = marketsFile([kalshi('K-A', 'alpha', 0.62), kalshi('K-B', 'beta', 0.3), kalshi('K-G', 'gamma', 0.4)]);
  const partial = buildOptionMarket({ item: mcItem(), markets, map: { match: 'same', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-B' }, 'Gamma (Δ)': null } }, method: METHOD });
  assert.equal(partial.status, 'not_blended');
  assert.ok(partial.problems.some((p) => /not mapped/.test(p)));
  const a = run(mcItem(), mcPasses(sets), { market: partial.market });
  assert.equal(a.checks.blend_weight, 0);
  assert.ok(a.flags.includes('option_market_partial'), 'the tool\'s own reason reaches the flags by name');
  assert.match(a.comment_lines.markets, /none used, weight w=0 \(not blended: option market partial\)/);
  assert.equal(a.forecast.probabilities.Alpha, 0.5);

  const badSum = buildOptionMarket({ item: mcItem(), markets, map: { match: 'same', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-B' }, 'Gamma (Δ)': { venue: 'kalshi', id: 'K-G' } } }, method: METHOD });
  assert.equal(badSum.status, 'not_blended');
  assert.ok(badSum.problems.some((p) => /add up to 1\.32/.test(p)));

  // Hand-made tables are checked by aggregate itself too.
  const options = ['Alpha', 'Beta', 'Gamma (Δ)'];
  const base = { venue: 'kalshi', match: 'same', real_money: true, volume_usd: 100000, spread: 0.02 };
  assert.equal(optionMarketProblem({ ...base, probabilities: { Alpha: 0.6, Beta: 0.4 } }, options, METHOD), 'option_market_partial');
  assert.equal(optionMarketProblem({ ...base, probabilities: { Alpha: 0.6, Beta: 0.4, 'Gamma (Δ)': 0.3 } }, options, METHOD), 'option_market_bad_sum');
  const fine = { Alpha: 0.6, Beta: 0.38, 'Gamma (Δ)': 0.06 };
  assert.equal(optionMarketProblem({ ...base, probabilities: fine, produced_by: OPTION_TABLE_MARKER, table_hash: optionTableHash(fine) }, options, METHOD), null, 'within the tolerance');
  assert.equal(optionMarketProblem({ ...base, probabilities: fine }, options, METHOD), 'option_market_not_from_tool', 'typed by hand');
  const bad = run(mcItem(), mcPasses(sets), { market: { ...base, probabilities: { Alpha: 0.6, Beta: 0.4, 'Gamma (Δ)': 0.3 } } });
  assert.equal(bad.checks.blend_weight, 0);
  assert.ok(bad.checks.flags.includes('option_market_bad_sum'));
});

test('option-market: an option name not in the question, or a related market, never gets weight', () => {
  const markets = marketsFile([kalshi('K-A', 'alpha', 0.6), kalshi('K-B', 'beta', 0.3), kalshi('K-G', 'gamma', 0.1)]);
  const wrongName = buildOptionMarket({ item: mcItem(), markets, map: { match: 'same', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-B' }, 'Gamma (D)': { venue: 'kalshi', id: 'K-G' } } }, method: METHOD });
  assert.equal(wrongName.status, 'not_blended');
  const related = buildOptionMarket({ item: mcItem(), markets, map: { match: 'related', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-B' }, 'Gamma (Δ)': { venue: 'kalshi', id: 'K-G' } } }, method: METHOD });
  assert.equal(related.status, 'ok');
  assert.equal(run(mcItem(), mcPasses(sets), { market: related.market }).checks.blend_weight, 0);
});

// ---- 3. the plan: two modes, saved to a file --------------------------------

const closingIn = (m) => ({ scheduled_close_time: iso(NOW + minutes(m)) });

test('intake: six questions with 179 minutes left and sub-agents run in parallel, none on the fast path', async (t) => {
  const dir = await tempDataRepo(t);
  const items = Array.from({ length: 6 }, (_, i) => itemFor('binary', 80 + i, closingIn(179)));
  const out = await intake({ payloadText: JSON.stringify(envelope(items)), dataDir: dir, nowMs: NOW, subagents: true });
  assert.equal(out.mode, 'parallel');
  assert.deepEqual(out.plan.map((p) => p.fast_path), [false, false, false, false, false, false]);
  assert.deepEqual(out.plan.map((p) => p.budget_minutes), [25, 25, 25, 25, 25, 25]);
  assert.deepEqual(out.plan.map((p) => p.waits_minutes), [0, 11, 22, 33, 44, 55]);

  const saved = JSON.parse(await readFile(out.plan_file, 'utf8'));
  assert.ok(out.plan_file.startsWith(join(dir, 'runs', 'plans')));
  assert.equal(saved.mode, 'parallel');
  assert.deepEqual(saved.plan, out.plan);
});

test('intake: the same six questions without sub-agents run in closing order; the late ones go fast, with a reason', async (t) => {
  const dir = await tempDataRepo(t);
  const items = Array.from({ length: 6 }, (_, i) => itemFor('binary', 90 + i, closingIn(179)));
  const out = await intake({ payloadText: JSON.stringify(envelope(items)), dataDir: dir, nowMs: NOW, subagents: false });
  assert.equal(out.mode, 'sequential');
  assert.equal(out.mode_reason, 'no sub-agent tool');
  assert.deepEqual(out.plan.map((p) => p.fast_path), [false, false, false, false, false, true]);
  assert.match(out.plan[5].fast_path_reason, /29 minutes to work after 125 minutes of earlier questions \(sequential\)/);
});

test('intake: practice questions are never mixed with tournament questions', async (t) => {
  const dir = await tempDataRepo(t);
  const practice = itemFor('binary', 900001, { tournament: 'practice' });
  const mixed = envelope([practice, itemFor('binary', 77)]);
  await assert.rejects(intake({ payloadText: JSON.stringify(mixed), dataDir: dir, nowMs: NOW }), { code: 'payload_practice_mixed' });
  const only = await intake({ payloadText: JSON.stringify(envelope([practice])), dataDir: dir, nowMs: NOW });
  assert.equal(only.practice, true);
  assert.equal(only.kit_checked, false, 'a practice kit from a local folder has no KIT_REF');
  const real = await intake({ payloadText: JSON.stringify(envelope([itemFor('binary', 78)])), dataDir: dir, nowMs: NOW });
  assert.equal(real.practice, false);
});

test('intake: two questions stay sequential even with sub-agents', () => {
  assert.equal(chooseMode(2, true, METHOD).mode, 'sequential');
  assert.equal(chooseMode(3, true, METHOD).mode, 'parallel');
  assert.equal(chooseMode(9, false, METHOD).mode, 'sequential');
});

test('intake CLI: --subagents must be yes or no', async (t) => {
  const dir = await tempDataRepo(t);
  const file = join(dir, 'payload.json');
  await writeJsonFile(file, envelope([itemFor('binary', 99)]));
  const bad = await runTool('intake.mjs', ['--payload', file, '--data', dir, '--subagents', 'maybe']);
  assert.equal(bad.code, 2);
  const ok = await runTool('intake.mjs', ['--payload', file, '--data', dir, '--subagents', 'yes', '--now', iso(NOW)]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).mode, 'sequential');
});

// ---- check-run for one question ---------------------------------------------

test('check-run --question checks only that question', async (t) => {
  const dir = await tempDataRepo(t);
  const items = [itemFor('binary', 101), itemFor('binary', 102)];
  await writeJsonFile(join(dir, 'questions', '101.json'), items[0]);
  const agg = run(items[0], binaryPasses([0.2, 0.3, 0.25, 0.2, 0.3]));
  const comment = `${agg.comment_lines.forecast}\nQuestion as read: test.\n${agg.comment_lines.markets}\n${agg.comment_lines.passes}`;
  await writeForecast({ item: items[0], aggregate: agg, comment, dataDir: dir, method: METHOD, nowMs: NOW });

  const one = await checkRun({ envelope: envelope(items), dataDir: dir, nowMs: NOW, questionId: 101 });
  assert.equal(one.ok, true);
  assert.equal(one.scope, 'question');
  assert.equal(one.questions.length, 1);
  assert.equal((await checkRun({ envelope: envelope(items), dataDir: dir, nowMs: NOW })).ok, false);
  await assert.rejects(checkRun({ envelope: envelope(items), dataDir: dir, nowMs: NOW, questionId: 5 }), { code: 'question_not_in_payload' });

  const payload = join(dir, 'runs', 'payload.json');
  await writeJsonFile(payload, envelope(items));
  const cli = await runTool('check-run.mjs', ['--payload', payload, '--data', dir, '--now', iso(NOW), '--question', '101']);
  assert.equal(cli.code, 0, cli.stderr);
  const other = await runTool('check-run.mjs', ['--payload', payload, '--data', dir, '--now', iso(NOW), '--question', '102']);
  assert.equal(other.code, 1);
  const wrong = await runTool('check-run.mjs', ['--payload', payload, '--data', dir, '--question', 'abc']);
  assert.equal(wrong.code, 2);
});

// ---- 7. the criteria card ---------------------------------------------------

const card = (filler) => [
  '# Criteria card: question 1', '',
  `Resolvable event: ${filler}`, 'Resolution source: FRED.', 'Resolves on: 2026-12-11.', 'Which events count: the close on that day.',
  'Time left: 28 days.', 'Unit and scale: n/a', 'Status quo outcome: Yes.', 'What a "No" (or an out-of-range value) looks like: a lower close.',
  'Traps: holidays.', 'Assume the event has not already happened unless the criteria say a past event counts.',
].join('\n');

test('check-card: own words over the limit or a missing field fail; labels and the fixed line do not count', async (t) => {
  const short = checkCard(card('the S&P 500 closes above 7,600.'), METHOD);
  assert.equal(short.ok, true);
  assert.ok(short.words < 40, String(short.words));
  const long = checkCard(card('word '.repeat(260)), METHOD);
  assert.equal(long.ok, false);
  assert.ok(long.words > METHOD.criteria_card_max_words);
  const missing = checkCard(card('x').replace('Traps: holidays.', ''), METHOD);
  assert.deepEqual(missing.missing_fields, ['Traps:']);

  const dir = await tempDataRepo(t);
  await writeFile(join(dir, 'card.md'), card('word '.repeat(260)));
  assert.equal((await runTool('check-card.mjs', ['--card', join(dir, 'card.md')])).code, 1);
  await writeFile(join(dir, 'card.md'), card('fine.'));
  assert.equal((await runTool('check-card.mjs', ['--card', join(dir, 'card.md')])).code, 0);
});

// ---- 6. model tiers ---------------------------------------------------------

test('method.json names a model tier for each role: research cheaper, passes and main session the task tier', () => {
  assert.equal(METHOD.model_tiers.research, 'cheaper');
  assert.equal(METHOD.model_tiers.passes, 'task');
  assert.equal(METHOD.model_tiers.main_session, 'task');
});
