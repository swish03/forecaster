// The batch hold and the daily wake-up budget (config.firing), with the real
// config values: hold up to 30 minutes when every new question has more than
// 120 minutes left; after 12 wake-ups in a UTC day, a first wake-up waits
// until a question would otherwise have under 120 minutes left, and then
// every open one goes; after 14 (just under the plan's daily run cap)
// nothing more is sent that day. The test profile has its own small counter.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NOW, minutes } from './helpers/fixtures.mjs';
import { PUBLIC, REAL_CONFIG, world } from './helpers/world.mjs';

const real = () => world({ config: REAL_CONFIG });
const sentIds = (w, i) => JSON.parse(w.routine.requests[i].body.text).questions.map((q) => q.question_id);

function seedOps(w, ops) {
  w.github.commitFiles(PUBLIC, 'state', { 'fired.json': '{}\n', 'posted.json': '{}\n', 'ops.json': `${JSON.stringify(ops)}\n` });
}

test('the config holds the decided firing values', () => {
  const f = REAL_CONFIG.firing;
  assert.equal(f.batch_hold_minutes, 30);
  assert.equal(f.batch_hold_if_minutes_left_over, 120);
  assert.equal(f.daily_fire_budget, 12);
  assert.equal(f.daily_fire_hard_cap, 14);
  assert.equal(f.over_budget_fire_if_minutes_left_under, 120);
  assert.ok(f.over_budget_fire_if_minutes_left_under - f.first_fire_min_minutes_left >= 60, 'a late wake-up still leaves the agent an hour');
  assert.equal(f.max_fires_per_question, 2, 'the refire rules are kept');
  assert.equal(f.refire_after_minutes, 60);
  assert.equal(f.refire_min_minutes_left, 45);
});

test('new questions with plenty of time are held up to 30 minutes, then go out in one wake-up', async () => {
  const w = real();
  w.open('binary', 101, 150);
  const first = await w.run();
  assert.equal(first.exitCode, 0, 'holding is not a problem');
  assert.equal(w.routine.requests.length, 0);
  assert.deepEqual(first.summary.held, [101]);
  assert.equal(w.state('ops.json').hold_since, new Date(NOW).toISOString());

  w.clock += minutes(10);
  w.open('binary', 102, 170);
  await w.run();
  assert.equal(w.routine.requests.length, 0, 'still inside the 30 minutes');

  w.clock += minutes(20);
  await w.run();
  assert.equal(w.routine.requests.length, 1);
  assert.deepEqual(sentIds(w, 0), [101, 102], 'both questions in one wake-up');
  const ops = w.state('ops.json');
  assert.equal(ops.hold_since, undefined, 'the hold ends with the wake-up');
  assert.deepEqual(ops.fires, { day: '2026-11-16', count: 1 });
});

test('a question with 120 minutes or less is sent at once, together with the held ones', async () => {
  const w = real();
  w.open('binary', 201, 150);
  await w.run();
  assert.equal(w.routine.requests.length, 0);
  w.clock += minutes(5);
  w.open('binary', 202, 100);
  await w.run();
  assert.equal(w.routine.requests.length, 1);
  assert.deepEqual(sentIds(w, 0), [202, 201], 'soonest deadline first, all open questions');
});

test('a second wake-up for a question is never held', async () => {
  const w = real();
  w.open('binary', 301, 200);
  await w.run();
  w.clock += minutes(30);
  await w.run();
  assert.equal(w.routine.requests.length, 1);
  w.clock += minutes(61);
  await w.run();
  assert.equal(w.routine.requests.length, 2, 'refired after 60 minutes with no file, 109 minutes left');
  assert.equal(JSON.parse(w.routine.requests[1].body.text).questions[0].attempt, 2);
});

test('after the daily budget, the agent is woken only when a question gets close, and then for all of them', async () => {
  const w = real();
  seedOps(w, { fires: { day: '2026-11-16', count: 12 } });
  w.open('binary', 401, 180);
  const first = await w.run();
  assert.equal(w.routine.requests.length, 0);
  assert.deepEqual(first.summary.held, [401]);
  assert.ok(w.lines.some((l) => l.includes('daily budget used (12 of 12)')));

  w.clock = NOW + minutes(180 - 121);
  w.open('binary', 402, 300);
  await w.run();
  assert.equal(w.routine.requests.length, 0, '121 minutes left: still waiting');

  w.clock = NOW + minutes(180 - 119);
  await w.run();
  assert.equal(w.routine.requests.length, 1);
  assert.deepEqual(sentIds(w, 0), [401, 402], 'every open question goes in that one wake-up');
  assert.deepEqual(w.state('ops.json').fires, { day: '2026-11-16', count: 13 });
});

test('after the daily budget, a second wake-up is never held', async () => {
  const w = real();
  w.open('binary', 451, 300);
  await w.run();
  w.clock += minutes(30);
  await w.run();
  assert.equal(w.routine.requests.length, 1);
  // Pretend the day's budget got used up meanwhile.
  const ops = { ...w.state('ops.json'), fires: { day: '2026-11-16', count: 12 } };
  w.github.commitFiles(PUBLIC, 'state', { 'ops.json': `${JSON.stringify(ops)}\n` });
  w.clock += minutes(61);
  await w.run();
  assert.equal(w.routine.requests.length, 2, 'the second wake-up goes although the budget is used');
  assert.equal(JSON.parse(w.routine.requests[1].body.text).questions[0].attempt, 2);
});

test('at the hard cap nothing is sent, and the owner is told', async () => {
  const w = real();
  seedOps(w, { fires: { day: '2026-11-16', count: 14 } });
  w.open('binary', 461, 70);
  const { summary } = await w.run();
  assert.equal(w.routine.requests.length, 0);
  assert.deepEqual(summary.held, [461]);
  assert.match(w.issues()[0].body, /`wake_hard_cap`/);
});

test('the test profile has its own small budget: one question per tick, two wake-ups a day, never the live counter', async () => {
  const w = real();
  for (const id of [471, 472, 473]) w.open('binary', id, 150, '32977');
  await w.run({ profileName: 'test' });
  assert.equal(w.routine.requests.length, 1);
  assert.deepEqual(sentIds(w, 0), [471], 'one question per tick');
  w.clock += minutes(15);
  await w.run({ profileName: 'test' });
  w.clock += minutes(15);
  await w.run({ profileName: 'test' });
  assert.equal(w.routine.requests.length, 2, 'two wake-ups a day at most');
  const ops = w.state('ops.json');
  assert.equal(ops.fires, undefined, 'the live budget is untouched');
  assert.deepEqual(ops.fires_test, { day: '2026-11-16', count: 2 });
  assert.equal(w.issues().length, 0, 'the test cap is not a problem for the owner');
});

test('the budget counts per UTC day and starts again the next day', async () => {
  const w = real();
  seedOps(w, { fires: { day: '2026-11-15', count: 14 } });
  w.open('binary', 501, 100);
  await w.run();
  assert.equal(w.routine.requests.length, 1, 'yesterday\'s count does not hold today');
  assert.deepEqual(w.state('ops.json').fires, { day: '2026-11-16', count: 1 });
});

test('a refused wake-up does not use the budget', async () => {
  const w = real();
  w.open('binary', 601, 100);
  w.routine.script.push(new Response('{}', { status: 401 }));
  await w.run();
  assert.equal(w.state('ops.json').fires, undefined);
});
