import test from 'node:test';
import assert from 'node:assert/strict';

import { blendLogOdds, clamp, logit, median, normalizeWithFloor, sigmoid } from '../lib/prob.mjs';

const close = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

test('clamp keeps values inside the range', () => {
  assert.equal(clamp(0.995, 0.02, 0.98), 0.98);
  assert.equal(clamp(0.001, 0.02, 0.98), 0.02);
  assert.equal(clamp(0.4, 0.02, 0.98), 0.4);
  assert.throws(() => clamp(0.5, 0.9, 0.1));
});

test('log-odds blend: weight 0 keeps own value, 0.5 of opposite odds gives 0.5', () => {
  assert.equal(blendLogOdds(0.3, 0.9, 0), 0.3);
  assert.ok(close(blendLogOdds(0.2, 0.8, 0.5), 0.5));
  assert.ok(close(blendLogOdds(0.3, 0.6, 1), 0.6));
  const blended = blendLogOdds(0.3, 0.6, 0.3);
  assert.ok(close(blended, sigmoid(0.7 * logit(0.3) + 0.3 * logit(0.6))));
  assert.throws(() => blendLogOdds(0.3, 0.6, 1.2));
  assert.throws(() => logit(1));
});

test('median of odd and even lists', () => {
  assert.equal(median([0.3, 0.1, 0.2]), 0.2);
  assert.equal(median([0.1, 0.2, 0.3, 0.4]), 0.25);
  assert.throws(() => median([]));
});

test('multiple choice: floor every option and sum to exactly 1', () => {
  const out = normalizeWithFloor({ A: 0.9, B: 0.1, C: 0.0, D: 0.001 }, 0.01);
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  assert.ok(close(sum, 1, 1e-12));
  assert.equal(out.C, 0.01);
  assert.equal(out.D, 0.01);
  assert.ok(out.A > out.B);
  assert.deepEqual(Object.keys(out), ['A', 'B', 'C', 'D']);
});

test('multiple choice: unnormalised input and all-zero input', () => {
  const out = normalizeWithFloor({ A: 2, B: 2 }, 0.01);
  assert.deepEqual(out, { A: 0.5, B: 0.5 });
  const zeros = normalizeWithFloor({ A: 0, B: 0, C: 0 }, 0.01);
  assert.ok(Object.values(zeros).every((v) => close(v, 1 / 3)));
  assert.throws(() => normalizeWithFloor({ A: -1, B: 1 }));
  assert.throws(() => normalizeWithFloor({ A: 1, B: 1 }, 0.6));
});

test('clamp refuses a value that is not a finite number', () => {
  assert.throws(() => clamp(Number.NaN, 0.02, 0.98), /finite/);
  assert.throws(() => clamp(undefined, 0.02, 0.98), /finite/);
});
