import test from 'node:test';
import assert from 'node:assert/strict';

import { questionProblems, validateForecastFile } from '../lib/schema.mjs';
import { questionsOfPost } from '../poster/metaculus.mjs';
import { NOW, forecastFile, postWith, questionFor } from './helpers/fixtures.mjs';

const TYPES = ['binary', 'multiple_choice', 'numeric', 'numeric_log', 'discrete', 'date'];

function setup(kind) {
  const raw = questionFor(kind, 500 + TYPES.indexOf(kind));
  const post = postWith(raw);
  const [question] = questionsOfPost(post).questions;
  return { question, file: forecastFile(raw, post.id) };
}

const check = (file, question) => validateForecastFile(file, question, { nowMs: NOW }).map((p) => p.code);

for (const kind of TYPES) {
  test(`${kind}: a correct file passes`, () => {
    const { question, file } = setup(kind);
    assert.deepEqual(questionProblems(question), []);
    assert.deepEqual(check(file, question), []);
  });

  test(`${kind}: wrong type, wrong ids and a missing comment are refused`, () => {
    const { question, file } = setup(kind);
    const otherType = kind === 'binary' ? 'multiple_choice' : 'binary';
    assert.ok(check({ ...file, type: otherType }, question).includes('type_mismatch'));
    assert.ok(check({ ...file, question_id: 1 }, question).includes('question_id_mismatch'));
    assert.ok(check({ ...file, post_id: 1 }, question).includes('post_id_mismatch'));
    assert.ok(check({ ...file, comment: '' }, question).includes('comment_too_short'));
    assert.ok(check({ ...file, comment: 'x'.repeat(3001) }, question).includes('comment_too_long'));
  });
}

test('binary: probability outside [0.01, 0.99] and extra keys are refused', () => {
  const { question, file } = setup('binary');
  assert.deepEqual(check({ ...file, forecast: { probability_yes: 0.995 } }, question), ['binary_out_of_range']);
  assert.deepEqual(check({ ...file, forecast: { probability_yes: 0.005 } }, question), ['binary_out_of_range']);
  assert.deepEqual(check({ ...file, forecast: { probability_yes: '0.3' } }, question), ['binary_out_of_range']);
  assert.deepEqual(check({ ...file, forecast: { probability_yes: 0.3, extra: 1 } }, question), ['forecast_shape']);
});

test('multiple choice: options must match character for character and sum to 1', () => {
  const { question, file } = setup('multiple_choice');
  const missing = { probabilities: { Alpha: 0.5, Beta: 0.5 } };
  assert.deepEqual(check({ ...file, forecast: missing }, question), ['mc_options_mismatch']);
  const accentless = { probabilities: { Alpha: 0.5, Beta: 0.3, 'Gamma (D)': 0.2 } };
  assert.deepEqual(check({ ...file, forecast: accentless }, question), ['mc_options_mismatch']);
  const badSum = { probabilities: { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.3 } };
  assert.deepEqual(check({ ...file, forecast: badSum }, question), ['mc_sum']);
  const zero = { probabilities: { Alpha: 0.7, Beta: 0.3, 'Gamma (Δ)': 0 } };
  assert.deepEqual(check({ ...file, forecast: zero }, question), ['mc_value_out_of_range']);
});

test('continuous: wrong CDF length and a broken bound are refused', () => {
  const { question, file } = setup('discrete');
  assert.equal(file.forecast.cdf.length, 11);
  assert.deepEqual(check({ ...file, forecast: { cdf: file.forecast.cdf.slice(0, 10) } }, question), ['cdf_length']);
  const broken = [...file.forecast.cdf];
  broken[10] = 0.99;
  assert.ok(check({ ...file, forecast: { cdf: broken } }, question).includes('cdf_upper_bound'));
  const numeric = setup('numeric');
  assert.deepEqual(check({ ...numeric.file, forecast: { cdf: file.forecast.cdf } }, numeric.question), ['cdf_length']);
  assert.deepEqual(check({ ...numeric.file, forecast: { percentiles: {} } }, numeric.question), ['forecast_shape']);
});

test('contract fields: missing, unknown, wrong types', () => {
  const { question, file } = setup('binary');
  const { signals, ...noSignals } = file;
  assert.ok(signals);
  assert.ok(check(noSignals, question).includes('missing_fields'));
  assert.ok(check({ ...file, surprise: true }, question).includes('unknown_fields'));
  assert.ok(check({ ...file, schema: 2 }, question).includes('schema_version'));
  assert.ok(check({ ...file, created_at: 'yesterday' }, question).includes('created_at_invalid'));
  assert.ok(check({ ...file, created_at: new Date(NOW + 3600000).toISOString() }, question).includes('created_at_in_future'));
  assert.ok(check({ ...file, passes: [] }, question).includes('passes_invalid'));
  assert.ok(check({ ...file, checks: { validated: false, clamped: false, blend_weight: 0 } }, question).includes('checks_invalid'));
  assert.ok(check({ ...file, checks: { validated: true, clamped: false, blend_weight: 0.9 } }, question).includes('blend_weight_invalid'));
  assert.ok(check({ ...file, checks: { validated: true, clamped: false, blend_weight: 0.3 } }, question).includes('blend_without_signal'));
  assert.ok(check({ ...file, signals: { market: 'x', community: null, base_rate: null } }, question).includes('signals_invalid'));
  assert.deepEqual(validateForecastFile(null, question).map((p) => p.code), ['file_not_object']);
});

test('incomplete questions are reported before the file is looked at', () => {
  const { question, file } = setup('discrete');
  const broken = { ...question, scaling: { ...question.scaling, inbound_outcome_count: null } };
  assert.deepEqual(check(file, broken), ['question_outcome_count_missing']);
  const mc = setup('multiple_choice');
  assert.deepEqual(check(mc.file, { ...mc.question, options: ['Only one'] }), ['question_options_invalid']);
  assert.deepEqual(questionProblems({ ...question, type: 'conditional' }).map((p) => p.code), ['question_type_unsupported']);
});

test('problem details never echo file contents or forecast values', () => {
  const { question, file } = setup('binary');
  const typeProblem = validateForecastFile({ ...file, type: 'x\n::error::' }, question).find((p) => p.code === 'type_mismatch');
  assert.ok(!typeProblem.detail.includes('::error::'));
  const mc = setup('multiple_choice');
  const bad = { ...mc.file, forecast: { probabilities: Object.fromEntries(mc.question.options.map((o) => [o, 0.3141])) } };
  const sum = validateForecastFile(bad, mc.question).find((p) => p.code === 'mc_sum');
  assert.ok(sum && !sum.detail.includes('0.94'), `detail was "${sum?.detail}"`);
});

test('a log-scale question with its zero point inside the range is incomplete', () => {
  const { question } = setup('numeric');
  const broken = { ...question, scaling: { ...question.scaling, zero_point: (question.scaling.range_min + question.scaling.range_max) / 2 } };
  assert.deepEqual(questionProblems(broken).map((p) => p.code), ['question_zero_point_invalid']);
});
