import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { quantile, seriesStats } from '../tools/series.mjs';
import { runTool, tempDataRepo, writeJsonFile } from './helpers.mjs';

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('quantile interpolates between order statistics', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10, 20], 0.1), 11);
});

test('a steady +1 per step series: exact changes, zero volatility, a zero-width band', () => {
  const out = seriesStats(range(30, (i) => i + 1), { horizonSteps: 5 });
  assert.equal(out.last_value, 30);
  assert.equal(out.min, 1);
  assert.equal(out.max, 30);
  assert.deepEqual(out.changes[1], { abs: 1, pct: 3.4482759 });
  assert.equal(out.changes[5].abs, 5);
  assert.equal(out.changes[20].abs, 20);
  assert.equal(out.volatility.step_change_sd, 0);
  assert.equal(out.horizon.method, 'empirical');
  assert.equal(out.horizon.windows, 25);
  assert.equal(out.horizon.quantiles['50'], 35);
  assert.equal(out.horizon.quantiles['1'], 35);
  assert.equal(out.horizon.band_width_10_90, 0);
  assert.equal(out.horizon.typical_abs_move_median, 5);
});

test('an alternating series: past one-step moves of +2 and -2 give a two-sided horizon', () => {
  const out = seriesStats(range(21, (i) => (i % 2 ? 12 : 10)), { horizonSteps: 1 });
  assert.equal(out.last_value, 10);
  assert.equal(out.horizon.quantiles['50'], 10);
  assert.equal(out.horizon.quantiles['1'], 8);
  assert.equal(out.horizon.quantiles['99'], 12);
  assert.equal(out.horizon.typical_abs_move_median, 2);
  assert.equal(out.volatility.step_change_sd, Number(Math.sqrt(4 * 20 / 19).toPrecision(8)));
});

test('relative mode uses past ratios (a doubling series doubles again)', () => {
  const out = seriesStats(range(12, (i) => 2 ** i), { horizonSteps: 1, mode: 'relative' });
  assert.equal(out.horizon.quantiles['50'], 4096);
  assert.equal(out.volatility.step_log_return_sd, 0);
  assert.throws(() => seriesStats([1, -1, 2, 3, 4], { horizonSteps: 1, mode: 'relative' }), { code: 'relative_needs_positive_values' });
});

test('dated history: sorted by date, 365-day range, horizon in days', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const history = range(400, (i) => ({ date: new Date(start + i * 86400000).toISOString().slice(0, 10), value: 100 + (i % 7) }));
  history.reverse();
  const out = seriesStats({ values: history }, { horizonDays: 7 });
  assert.equal(out.step_days, 1);
  assert.equal(out.horizon.steps, 7);
  assert.equal(out.first_date, '2026-01-01');
  assert.equal(out.last_date, '2027-02-04');
  assert.equal(out.min_365d, 100);
  assert.equal(out.max_365d, 106);
  // a weekly cycle: every 7-step move is zero
  assert.equal(out.horizon.band_width_10_90, 0);
});

test('a short history falls back to scaled one-step moves', () => {
  const out = seriesStats([10, 11, 10, 11, 10, 11], { horizonSteps: 4 });
  assert.equal(out.horizon.method, 'sqrt_scaled_one_step');
  // one-step moves +1/-1 have drift 0.2: drift x 4 + (1 - 0.2) x sqrt(4) = 2.4
  assert.equal(out.horizon.quantiles['99'], 13.4);
  assert.deepEqual(out.horizon.flags, ['few_windows_tails_unreliable']);
});

test('a short trending history keeps its trend over the horizon', () => {
  const out = seriesStats(Array.from({ length: 12 }, (_, i) => 100 + 10 * i), { horizonSteps: 10 });
  assert.equal(out.horizon.method, 'sqrt_scaled_one_step');
  assert.equal(out.horizon.quantiles['50'], 310, '+10 a step for 10 steps from 210');
});

test('long histories with enough windows do not flag the tails', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5);
  assert.deepEqual(seriesStats(values, { horizonSteps: 5 }).horizon.flags, []);
});

test('unusable histories are refused', () => {
  assert.throws(() => seriesStats([1, 2, 3], { horizonSteps: 1 }), { code: 'history_too_short' });
  assert.throws(() => seriesStats([1, 2, 'x', 4], { horizonSteps: 1 }), { code: 'history_value_invalid' });
  assert.throws(() => seriesStats([{ date: 'never', value: 1 }, { date: '2026-01-01', value: 1 }, { date: '2026-01-02', value: 1 }, { date: '2026-01-03', value: 1 }], { horizonSteps: 1 }), { code: 'history_date_invalid' });
  assert.throws(() => seriesStats([1, 2, 3, 4], { horizonDays: 3 }), { code: 'horizon_days_needs_dates' });
  assert.throws(() => seriesStats([1, 2, 3, 4], { horizonSteps: 0 }), { code: 'horizon_invalid' });
  assert.throws(() => seriesStats([1, 2, 3, 4], { horizonSteps: 1, mode: 'other' }), { code: 'mode_invalid' });
});

test('series CLI: good run, missing horizon, bad file', async (t) => {
  const dir = await tempDataRepo(t);
  const file = join(dir, 'h.json');
  await writeJsonFile(file, range(30, (i) => i));
  const ok = await runTool('series.mjs', ['--input', file, '--horizon-steps', '3']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).horizon.quantiles['50'], 32);
  assert.equal((await runTool('series.mjs', ['--input', file])).code, 1);
  assert.equal((await runTool('series.mjs', ['--input', join(dir, 'missing.json'), '--horizon-steps', '3'])).code, 1);
  assert.equal((await runTool('series.mjs', ['--horizon-steps', '3'])).code, 2);
});

test('a Monday-to-Friday series: a horizon in calendar days becomes trading steps, not days', () => {
  // 260 weekdays (about one year) of a price, rising 0.1 per trading day.
  const history = [];
  for (let d = Date.parse('2025-11-03T00:00:00Z'), n = 0; history.length < 260; d += 86400000) {
    const day = new Date(d).getUTCDay();
    if (day === 0 || day === 6) continue;
    history.push({ date: new Date(d).toISOString().slice(0, 10), value: 80 + 0.1 * n });
    n += 1;
  }
  const out = seriesStats(history, { horizonDays: 42 });
  // 52 weeks from a Monday to a Friday: 361 days over 259 gaps = 1.39 days per step;
  // 42 calendar days hold 30 weekdays. The median gap (1 day) would give 42 steps.
  assert.ok(Math.abs(out.step_days - 361 / 259) < 1e-6);
  assert.equal(out.horizon.steps, 30);
  assert.ok(Math.abs(out.horizon.quantiles['50'] - (history.at(-1).value + 0.1 * 30)) < 1e-6);
});
