import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeCdf } from '../tools/make-cdf.mjs';
import { validateCdf } from '../../lib/cdf.mjs';
import { toValidatorQuestion } from '../tools/core/question.mjs';
import { itemFor, runTool, spreadAround, tempDataRepo, writeJsonFile } from './helpers.mjs';

const linear = (openLower, openUpper, n = 200) => ({
  range_min: 0, range_max: 100, zero_point: null, open_lower_bound: openLower, open_upper_bound: openUpper, inbound_outcome_count: n,
});

for (const [openLower, openUpper] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`make-cdf: valid with lower ${openLower ? 'open' : 'closed'} and upper ${openUpper ? 'open' : 'closed'}`, () => {
    const s = linear(openLower, openUpper);
    const out = makeCdf([spreadAround(50, 12)], s);
    assert.equal(out.points, 201);
    assert.deepEqual(validateCdf(out.cdf, s), []);
    assert.ok(Math.abs(out.median - 50) < 1.5, `median ${out.median}`);
    assert.ok(out.p10 < out.median && out.median < out.p90);
  });
}

test('make-cdf: percentiles beyond a closed bound are pulled inside; beyond an open bound they keep mass outside', () => {
  const closed = makeCdf([spreadAround(95, 10)], linear(false, false));
  assert.equal(closed.cdf[200], 1);
  const open = makeCdf([spreadAround(95, 10)], linear(false, true));
  assert.ok(open.cdf[200] < 0.85, `most mass above 100 should stay outside, got ${open.cdf[200]}`);
  assert.equal(open.p90, null);
});

test('make-cdf: log scaling, discrete grids and date ranges', () => {
  const log = { range_min: 1, range_max: 10000, zero_point: 0, open_lower_bound: false, open_upper_bound: true, inbound_outcome_count: 200 };
  const outLog = makeCdf([spreadAround(500, 150)], log);
  assert.deepEqual(validateCdf(outLog.cdf, log), []);
  assert.ok(Math.abs(outLog.median - 500) / 500 < 0.05, `median ${outLog.median}`);

  for (const n of [10, 16, 50]) {
    const s = { range_min: -0.5, range_max: n - 0.5, zero_point: null, open_lower_bound: false, open_upper_bound: false, inbound_outcome_count: n };
    const out = makeCdf([spreadAround(n / 2, n / 6)], s);
    assert.equal(out.cdf.length, n + 1);
    assert.deepEqual(validateCdf(out.cdf, s), []);
  }

  const dateScaling = toValidatorQuestion(itemFor('date')).scaling;
  const out = makeCdf([{ 10: '2027-01-10', 50: '2027-02-15', 90: '2027-04-01' }], dateScaling);
  assert.deepEqual(validateCdf(out.cdf, dateScaling), []);
  assert.equal(new Date(out.median * 1000).toISOString().slice(0, 7), '2027-02');
});

test('make-cdf: several sets are combined by pointwise median', () => {
  const s = linear(true, true);
  const out = makeCdf([spreadAround(30, 5), spreadAround(50, 5), spreadAround(70, 5)], s);
  assert.ok(Math.abs(out.median - 50) < 1, `median ${out.median}`);
});

test('make-cdf: impossible inputs are refused with a reason', () => {
  const s = linear(true, true);
  assert.throws(() => makeCdf([], s), { code: 'no_percentiles' });
  assert.throws(() => makeCdf([{ 50: 10 }], s), { code: 'cdf_impossible' });
  assert.throws(() => makeCdf([{ 10: 'soon', 50: 10, 90: 20 }], s), { code: 'percentiles_invalid' });
  assert.throws(() => makeCdf([{ 0: 1, 50: 10, 90: 20 }], s), { code: 'percentiles_invalid' });
  assert.throws(() => makeCdf([{ 10: 5, 50: 10, 100: 20 }], s), { code: 'percentiles_invalid' });
  assert.throws(() => makeCdf(['not an object'], s), { code: 'percentiles_invalid' });
  assert.throws(() => makeCdf([{ 10: 5, 50: 10, 90: 20 }], { ...s, inbound_outcome_count: 1 }), { code: 'cdf_impossible' });
});

test('make-cdf: a point-mass guess is spread out to meet the per-bin cap', () => {
  const s = linear(true, true);
  const out = makeCdf([{ 10: 50, 50: 50, 90: 50 }], s);
  assert.deepEqual(validateCdf(out.cdf, s), []);
  const biggestBin = Math.max(...out.cdf.slice(1).map((v, i) => v - out.cdf[i]));
  assert.ok(biggestBin <= 0.95 * 0.2 + 1e-9, `biggest bin ${biggestBin}`);
});

test('make-cdf CLI: --help, wrong command, bad data and a good run', async (t) => {
  const dir = await tempDataRepo(t);
  const question = join(dir, 'q.json');
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  await writeJsonFile(question, itemFor('numeric'));
  await writeJsonFile(good, { percentiles: spreadAround(50, 10) });
  await writeJsonFile(bad, { percentiles: { 50: 5 } });

  assert.equal((await runTool('make-cdf.mjs', ['--help'])).code, 0);
  assert.equal((await runTool('make-cdf.mjs', ['--question', question])).code, 2);
  assert.equal((await runTool('make-cdf.mjs', ['--nonsense'])).code, 2);
  const refused = await runTool('make-cdf.mjs', ['--question', question, '--percentiles', bad]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cdf_impossible/);
  const ok = await runTool('make-cdf.mjs', ['--question', question, '--percentiles', good]);
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).cdf.length, 201);
});

test('make-cdf: values that go down, or two keys for one percentile, are refused', () => {
  const s = toValidatorQuestion(itemFor('numeric')).scaling;
  assert.throws(() => makeCdf([{ 10: 50, 50: 40, 90: 60 }], s), { code: 'percentiles_invalid', message: /go down/ });
  assert.throws(() => makeCdf([{ 50: 20, '50.0': 80, 10: 10, 90: 90 }], s), { code: 'percentiles_invalid', message: /same percentile/ });
});
