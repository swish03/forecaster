import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { aggregate } from '../tools/aggregate.mjs';
import { writeForecast } from '../tools/write-forecast.mjs';
import { validateForecastFile } from '../../lib/schema.mjs';
import { questionsOfPost } from '../../poster/metaculus.mjs';
import { postWith, questionFor } from '../../test/helpers/fixtures.mjs';
import { NOW, binaryPasses, itemFor, mcPasses, minutes, pctPasses, runTool, spreadAround, tempDataRepo, writeJsonFile } from './helpers.mjs';

const METHOD = JSON.parse(readFileSync(new URL('../method.json', import.meta.url), 'utf8'));

function commentFor(agg) {
  return [
    agg.comment_lines.forecast,
    'Question as read: a test question. Counts: events after the open date. Time left: 2 days.',
    'Status quo: nothing happens.',
    agg.comment_lines.markets,
    agg.comment_lines.passes,
    'Main risk to this forecast: a surprise announcement.',
  ].join('\n');
}

const cases = {
  binary: () => binaryPasses([0.2, 0.3, 0.25, 0.35, 0.3]),
  multiple_choice: () => mcPasses([{ Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.4, Beta: 0.4, 'Gamma (Δ)': 0.2 }, { Alpha: 0.6, Beta: 0.2, 'Gamma (Δ)': 0.2 }]),
  numeric: () => pctPasses([spreadAround(50, 10), spreadAround(55, 9), spreadAround(45, 11)]),
  discrete: () => pctPasses([spreadAround(4, 1.5), spreadAround(5, 1.5), spreadAround(4.5, 2)]),
};

for (const [type, passes] of Object.entries(cases)) {
  test(`write-forecast: a ${type} file is written and passes the poster's own checks`, async (t) => {
    const dir = await tempDataRepo(t);
    const item = itemFor(type, 7);
    const agg = aggregate({ item, passes: passes(), signals: {}, method: METHOD });
    const out = await writeForecast({ item, aggregate: agg, comment: commentFor(agg), dataDir: dir, method: METHOD, nowMs: NOW });
    const file = JSON.parse(await readFile(out.written, 'utf8'));
    assert.equal(file.question_id, 7);
    assert.equal(file.created_at, new Date(NOW).toISOString());

    // The same question as the poster would see it from the Metaculus API.
    const question = questionsOfPost(postWith(questionFor(type, 7), 100007)).questions[0];
    assert.deepEqual(validateForecastFile(file, question, { nowMs: NOW + minutes(10) }), []);
  });
}

test('write-forecast: an existing forecast file is never rewritten', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('binary', 8);
  const agg = aggregate({ item, passes: cases.binary(), signals: {}, method: METHOD });
  const path = join(dir, 'forecasts', '8.json');
  await writeFile(path, 'first version');
  await assert.rejects(writeForecast({ item, aggregate: agg, comment: commentFor(agg), dataDir: dir, method: METHOD, nowMs: NOW }), { code: 'file_exists' });
  assert.equal(await readFile(path, 'utf8'), 'first version');
});

test('write-forecast: invalid files are refused and nothing is written', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('binary', 9);
  const agg = aggregate({ item, passes: cases.binary(), signals: {}, method: METHOD });
  const attempt = (overrides, comment = commentFor(agg), nowMs = NOW, it = item) =>
    writeForecast({ item: it, aggregate: { ...agg, ...overrides }, comment, dataDir: dir, method: METHOD, nowMs });

  await assert.rejects(attempt({ forecast: { probability_yes: 1.5 } }), (e) => e.code === 'forecast_invalid' && /binary_out_of_range/.test(e.message));
  await assert.rejects(attempt({ forecast: { probabilities: { Yes: 1 } } }), (e) => e.code === 'forecast_invalid' && /forecast_shape/.test(e.message));
  await assert.rejects(attempt({ checks: { validated: true, clamped: false, blend_weight: 0.3 } }), (e) => /blend_without_signal/.test(e.message));
  await assert.rejects(attempt({ passes: [] }), (e) => /passes_invalid/.test(e.message));
  await assert.rejects(attempt({ question_id: 10 }), { code: 'aggregate_for_other_question' });
  await assert.rejects(attempt({ method_version: '0.9' }), { code: 'method_version_mismatch' });
  await assert.rejects(attempt({}, 'A comment that does not start with the forecast line at all, but is long.'), { code: 'comment_format' });
  await assert.rejects(attempt({}, `${commentFor(agg)}\n${'x'.repeat(3000)}`), (e) => /comment_too_long/.test(e.message));
  await assert.rejects(attempt({}, commentFor(agg), NOW + minutes(150)), { code: 'question_closed' });
  await assert.rejects(attempt({}, commentFor(agg), NOW, { ...item, tournament: '' }), (e) => /tournament_invalid/.test(e.message));

  const mc = itemFor('multiple_choice', 9);
  await assert.rejects(attempt({ type: 'multiple_choice', forecast: { probabilities: { Alpha: 0.5, Beta: 0.5 } } }, commentFor(agg), NOW, mc),
    (e) => /mc_options_mismatch/.test(e.message));
  await assert.rejects(readFile(join(dir, 'forecasts', '9.json')), { code: 'ENOENT' });
});

test('write-forecast CLI: writes once, then refuses with exit code 1', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('binary', 11, { scheduled_close_time: new Date(Date.now() + minutes(120)).toISOString() });
  const agg = aggregate({ item, passes: cases.binary(), signals: {}, method: METHOD });
  const q = join(dir, 'questions', '11.json');
  const a = join(dir, 'runs', 'aggregate.json');
  const c = join(dir, 'runs', 'comment.md');
  await writeJsonFile(q, item);
  await writeJsonFile(a, agg);
  await writeFile(c, commentFor(agg));
  const args = ['--question', q, '--aggregate', a, '--comment', c, '--data', dir];
  const first = await runTool('write-forecast.mjs', args);
  assert.equal(first.code, 0, first.stderr);
  const second = await runTool('write-forecast.mjs', args);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /file_exists/);
});

test('write-forecast: a comment written for an earlier aggregate is refused (the comment must state the real forecast)', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('binary', 31);
  const old = aggregate({ item, passes: binaryPasses([0.2, 0.25, 0.2, 0.3, 0.2]), signals: {}, method: METHOD });
  const fresh = aggregate({ item, passes: binaryPasses([0.6, 0.65, 0.7, 0.6, 0.62]), signals: {}, method: METHOD });
  await assert.rejects(writeForecast({ item, aggregate: fresh, comment: commentFor(old), dataDir: dir, method: METHOD, nowMs: NOW }), { code: 'comment_format' });
  const noMarkets = commentFor(fresh).replace(fresh.comment_lines.markets, 'Markets: none.');
  await assert.rejects(writeForecast({ item, aggregate: fresh, comment: noMarkets, dataDir: dir, method: METHOD, nowMs: NOW }), { code: 'comment_format' });
  const ok = await writeForecast({ item, aggregate: fresh, comment: commentFor(fresh), dataDir: dir, method: METHOD, nowMs: NOW });
  assert.ok(ok.written.endsWith('31.json'));
});

test('aggregate: group and conditional comments name their part; the fallback says the passes were not independent', () => {
  const group = { ...itemFor('binary', 32), post_kind: 'group', label: 'Brazil' };
  const g = aggregate({ item: group, passes: binaryPasses([0.2, 0.3, 0.25, 0.35, 0.3]), signals: {}, method: METHOD });
  assert.match(g.comment_lines.forecast, /^Forecast: 30% for "Brazil" \(bot v/);
  const cond = { ...itemFor('binary', 33), post_kind: 'conditional', conditional: { branch: 'no' } };
  const c = aggregate({ item: cond, passes: binaryPasses([0.2, 0.3, 0.25, 0.35, 0.3]), signals: {}, method: METHOD, passesNotIndependent: true });
  assert.match(c.comment_lines.forecast, /^Forecast: 30% if the condition resolves no \(bot v/);
  assert.match(c.comment_lines.passes, /\(passes written in sequence by one agent, not independent\)\.$/);
  assert.ok(c.flags.includes('passes_not_independent'));
  const single = aggregate({ item: itemFor('binary', 34), passes: binaryPasses([0.2, 0.3, 0.25, 0.35, 0.3]), signals: {}, method: METHOD });
  assert.match(single.comment_lines.forecast, /^Forecast: 30% \(bot v/);
  assert.doesNotMatch(single.comment_lines.passes, /not independent/);
});
