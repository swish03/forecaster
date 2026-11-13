import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCdf, buildCdfWithInfo, cdfFromPercentiles, cdfRules, locationOf, medianCdf, standardizeCdf, validateCdf, valueAt, zeroPointProblem } from '../lib/cdf.mjs';

const linear = (openLower, openUpper, n = 200) => ({
  range_min: 0, range_max: 100, zero_point: null, open_lower_bound: openLower, open_upper_bound: openUpper, inbound_outcome_count: n,
});
const logScale = { range_min: 1, range_max: 10000, zero_point: 0, open_lower_bound: false, open_upper_bound: true, inbound_outcome_count: 200 };
const PCT = { 1: 5, 10: 20, 25: 35, 50: 50, 75: 65, 90: 80, 99: 95 };
const codes = (problems) => problems.map((p) => p.code);

function uniformCdf(scaling) {
  const r = cdfRules(scaling);
  return Array.from({ length: r.points }, (_, i) => i / r.intervals);
}

test('rules: 201 points by default, N + 1 for discrete, step limits scale with N', () => {
  assert.equal(cdfRules({ open_lower_bound: true, open_upper_bound: true }).points, 201);
  const d = cdfRules(linear(false, false, 10));
  assert.equal(d.points, 11);
  assert.equal(d.minStep, 0.001);
  assert.equal(d.maxStep, 0.59);
  assert.equal(cdfRules(linear(true, true)).maxStep, 0.2);
  assert.throws(() => cdfRules({ inbound_outcome_count: 1 }));
});

for (const [openLower, openUpper] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`builder output is valid with lower ${openLower ? 'open' : 'closed'}, upper ${openUpper ? 'open' : 'closed'}`, () => {
    const s = linear(openLower, openUpper);
    const cdf = buildCdf([PCT], s);
    assert.deepEqual(validateCdf(cdf, s), []);
    assert.equal(cdf.length, 201);
    if (!openLower) assert.equal(cdf[0], 0);
    else assert.ok(cdf[0] >= 0.001);
    if (!openUpper) assert.equal(cdf[200], 1);
    else assert.ok(cdf[200] <= 0.999);
    // the median sits near 50 on a 0-100 linear range
    assert.ok(Math.abs(cdf[100] - 0.5) < 0.02, `cdf at 50 was ${cdf[100]}`);
  });
}

test('validator rejects each broken rule', () => {
  const closed = linear(false, false);
  const good = standardizeCdf(uniformCdf(closed), closed);
  assert.deepEqual(validateCdf(good, closed), []);

  assert.deepEqual(codes(validateCdf(good.slice(1), closed)), ['cdf_length']);
  assert.deepEqual(codes(validateCdf('nope', closed)), ['cdf_not_array']);
  assert.deepEqual(codes(validateCdf(good.map((v, i) => (i === 5 ? Number.NaN : v)), closed)), ['cdf_value_range']);

  const lifted = good.map((v, i) => (i === 0 ? 0.001 : v));
  assert.ok(codes(validateCdf(lifted, closed)).includes('cdf_lower_bound'));
  const dropped = good.map((v, i) => (i === 200 ? 0.9995 : v));
  assert.ok(codes(validateCdf(dropped, closed)).includes('cdf_upper_bound'));

  const flat = [...good];
  flat[10] = flat[9];
  assert.ok(codes(validateCdf(flat, closed)).includes('cdf_step_too_small'));

  const open = linear(true, true);
  const openGood = standardizeCdf(uniformCdf(open), open);
  assert.deepEqual(validateCdf(openGood, open), []);
  assert.ok(codes(validateCdf(openGood.map((v, i) => (i === 0 ? 0 : v)), open)).includes('cdf_lower_bound'));
  assert.ok(codes(validateCdf(openGood.map((v, i) => (i === 200 ? 1 : v)), open)).includes('cdf_upper_bound'));
});

test('validator rejects a jump larger than the maximum step', () => {
  const s = linear(false, false);
  const cdf = uniformCdf(s).map((x) => (x < 0.5 ? x * 0.2 : 0.3 + x * 0.7));
  cdf[200] = 1;
  assert.ok(codes(validateCdf(cdf, s)).includes('cdf_step_too_large'));
});

test('a very concentrated forecast is capped per bin and stays valid', () => {
  const s = linear(true, true);
  const cdf = buildCdf([{ 1: 49.9, 50: 50, 99: 50.1 }], s);
  assert.deepEqual(validateCdf(cdf, s), []);
  const maxStep = Math.max(...cdf.slice(1).map((v, i) => v - cdf[i]));
  assert.ok(maxStep <= 0.95 * 0.2 + 1e-9, `max step ${maxStep}`);
});

test('discrete question with 10 outcomes gets 11 points and its own minimum step', () => {
  const s = { range_min: -0.5, range_max: 9.5, zero_point: null, open_lower_bound: false, open_upper_bound: false, inbound_outcome_count: 10 };
  const cdf = buildCdf([{ 10: 1, 50: 3, 90: 6 }], s);
  assert.equal(cdf.length, 11);
  assert.deepEqual(validateCdf(cdf, s), []);
  const almost = [...cdf];
  almost[5] = almost[4] + 0.0005;
  assert.ok(codes(validateCdf(almost, s)).includes('cdf_step_too_small'));
});

test('log scaling: locations and values invert, and the median lands at the right value', () => {
  for (const v of [1, 10, 100, 1000, 10000]) {
    assert.ok(Math.abs(valueAt(locationOf(v, logScale), logScale) - v) < 1e-6 * v);
  }
  assert.equal(locationOf(1, logScale), 0);
  assert.ok(Math.abs(locationOf(10000, logScale) - 1) < 1e-12);
  assert.ok(Number.isNaN(locationOf(-5, logScale)), 'values at or below the zero point have no location');

  const cdf = buildCdf([{ 5: 10, 50: 100, 95: 1000 }], logScale);
  assert.deepEqual(validateCdf(cdf, logScale), []);
  const i = cdf.findIndex((v) => v >= 0.5);
  const valueAtMedian = valueAt(i / 200, logScale);
  assert.ok(valueAtMedian > 80 && valueAtMedian < 125, `median value ${valueAtMedian}`);
});

test('date questions accept ISO strings for percentile values', () => {
  const s = {
    range_min: Date.parse('2026-12-01T00:00:00Z') / 1000, range_max: Date.parse('2027-06-01T00:00:00Z') / 1000,
    zero_point: null, open_lower_bound: false, open_upper_bound: true, inbound_outcome_count: 200,
  };
  const cdf = buildCdf([{ 10: '2027-01-01T00:00:00Z', 50: '2027-02-15T00:00:00Z', 90: '2027-05-01T00:00:00Z' }], s);
  assert.deepEqual(validateCdf(cdf, s), []);
});

test('closed bounds: values outside are pulled inside, open bounds allow them', () => {
  const closed = linear(false, false);
  const raw = cdfFromPercentiles({ 10: -50, 50: 50, 90: 500 }, closed);
  assert.equal(raw[0], 0);
  assert.equal(raw[200], 1);
  const open = linear(true, true);
  const rawOpen = cdfFromPercentiles({ 10: -50, 50: 50, 90: 500 }, open);
  assert.ok(rawOpen[0] > 0.1, 'mass below the open lower bound is kept');
  assert.ok(rawOpen[200] < 0.9, 'mass above the open upper bound is kept');
});

test('pointwise median of CDFs, not of percentiles', () => {
  const a = [0, 0.2, 0.4, 1];
  const b = [0, 0.6, 0.8, 1];
  const c = [0, 0.3, 0.9, 1];
  assert.deepEqual(medianCdf([a, b, c]), [0, 0.3, 0.8, 1]);
  assert.deepEqual(medianCdf([a, b]), [0, 0.4, 0.6000000000000001, 1]);
  assert.throws(() => medianCdf([a, [0, 1]]));
  assert.throws(() => medianCdf([]));
});

test('builder combines several passes and rejects unusable input', () => {
  const s = linear(true, true);
  const cdf = buildCdf([PCT, { 10: 30, 50: 60, 90: 90 }, { 10: 10, 50: 40, 90: 70 }], s);
  assert.deepEqual(validateCdf(cdf, s), []);
  assert.throws(() => buildCdf([{ 50: 10 }], s), /at least 2/);
  assert.throws(() => buildCdf([{ 10: 'soon', 90: 'later' }], s), /at least 2/);
});

// Real-world value where a CDF reaches level p (for checks below).
function quantile(cdf, p, scaling) {
  const n = cdf.length - 1;
  const i = cdf.findIndex((v) => v >= p);
  return valueAt((i - 1 + (p - cdf[i - 1]) / (cdf[i] - cdf[i - 1])) / n, scaling);
}

test('log scale, closed lower bound: a percentile at the bound does not drag the forecast up the axis', () => {
  const s = { range_min: 1, range_max: 1e6, zero_point: 0, open_lower_bound: false, open_upper_bound: true, inbound_outcome_count: 200 };
  const set = { 1: 1, 5: 1, 10: 2, 20: 4, 40: 8, 50: 10, 60: 13, 80: 60, 90: 100, 99: 5000 };
  const cdf = buildCdf([set, set, set], s);
  assert.deepEqual(validateCdf(cdf, s), []);
  const med = quantile(cdf, 0.5, s);
  assert.ok(med > 8 && med < 13, `median ${med} should stay near 10`);
  assert.ok(cdf[1] >= 0.05, 'mass on the closed bound lands in the first bin');
});

test('linear scale, closed lower bound: a value at the bound does not push up values already inside', () => {
  const s = { range_min: 0, range_max: 1000, zero_point: null, open_lower_bound: false, open_upper_bound: true, inbound_outcome_count: 200 };
  const atBound = buildCdf([{ 1: 0, 5: 2, 10: 5, 20: 8, 40: 15, 50: 20, 60: 25, 80: 40, 90: 60, 99: 150 }], s);
  const inside = buildCdf([{ 1: 0.1, 5: 2, 10: 5, 20: 8, 40: 15, 50: 20, 60: 25, 80: 40, 90: 60, 99: 150 }], s);
  assert.ok(Math.abs(quantile(atBound, 0.1, s) - quantile(inside, 0.1, s)) < 0.5);
  assert.ok(Math.abs(quantile(atBound, 0.25, s) - quantile(inside, 0.25, s)) < 0.5);
});

test('the same at a closed upper bound', () => {
  const s = linear(false, false);
  const cdf = buildCdf([{ 10: 80, 50: 95, 90: 100, 99: 100 }], s);
  assert.deepEqual(validateCdf(cdf, s), []);
  assert.ok(Math.abs(quantile(cdf, 0.5, s) - 95) < 1, 'the median stays at 95');
  assert.ok(1 - cdf[199] >= 0.09, 'mass on the upper bound lands in the last bin');
});

test('the per-bin cap shares excess evenly on both sides and says when it moved mass', () => {
  const s = { range_min: -0.5, range_max: 4.5, zero_point: null, open_lower_bound: false, open_upper_bound: false, inbound_outcome_count: 5 };
  const { cdf, binCapApplied } = buildCdfWithInfo([{ 5: 3, 10: 3, 50: 3, 90: 3, 95: 3 }], s);
  const pmf = cdf.slice(1).map((v, i) => v - cdf[i]);
  assert.equal(binCapApplied, true);
  assert.ok(Math.abs(pmf[2] - pmf[4]) < 0.03, `neighbours ${pmf[2]} and ${pmf[4]} should be about equal`);
  assert.equal(buildCdfWithInfo([PCT], linear(true, true)).binCapApplied, false);
});

test('every step is strictly at least 0.01/N after rounding, with no tolerance needed', () => {
  for (const s of [linear(true, true), linear(false, false), linear(false, true, 7), linear(true, false, 3)]) {
    const cdf = buildCdf([{ 1: 49.9, 50: 50, 99: 50.1 }], s);
    const { minStep } = cdfRules(s);
    const smallest = Math.min(...cdf.slice(1).map((v, i) => v - cdf[i]));
    assert.ok(smallest >= minStep, `smallest step ${smallest} is below ${minStep}`);
  }
  const s = linear(true, true);
  const ok = buildCdf([PCT], s);
  const short = [...ok];
  short[100] = short[99] + cdfRules(s).minStep - 1e-12;
  for (let i = 101; i < short.length; i += 1) short[i] = Math.max(short[i], short[i - 1] + 0.0001);
  assert.ok(codes(validateCdf(short, s)).includes('cdf_step_too_small'), 'the minimum step is checked strictly');
});

test('a zero point inside the range is refused; a ratio of almost 1 falls back to linear', () => {
  const inside = { ...logScale, zero_point: 5 };
  assert.match(zeroPointProblem(inside), /inside the range/);
  assert.throws(() => buildCdf([PCT], { ...linear(true, true), zero_point: 50 }), /inside the range/);
  const far = { range_min: 1, range_max: 100, zero_point: -1e17, open_lower_bound: true, open_upper_bound: true, inbound_outcome_count: 200 };
  const cdf = buildCdf([{ 10: 10, 50: 20, 90: 50 }], far);
  assert.ok(Math.abs(quantile(cdf, 0.5, far) - 20) < 1, 'behaves like a linear scale');
});
