// The one alert issue ("Forecaster needs attention"), the weekly keep-alive
// of the schedule and the daily clock check, in the fake world.

import test from 'node:test';
import assert from 'node:assert/strict';

import { expiringTokens, issueBody } from '../poster/ops.mjs';
import { json, makeFetch } from './helpers/fakes.mjs';
import { NOW, iso, minutes } from './helpers/fixtures.mjs';
import { DATA, PUBLIC, REAL_CONFIG, world } from './helpers/world.mjs';

const TITLE = 'Forecaster needs attention';
const hours = (n) => minutes(60 * n);

const fetchWith = (w, overrides) => {
  const base = makeFetch({ github: w.github, metaculus: w.metaculus, routine: w.routine });
  return async (url, init = {}) => (await overrides(url, init)) ?? base(url, init);
};

function assertPublicSafe(text) {
  assert.ok(!text.includes('Test question'), 'no question text');
  assert.ok(!text.includes('0.3'), 'no forecast numbers');
  assert.ok(!text.includes('forecaster-data'), 'no private repo name');
  assert.ok(!/test-[a-z-]+-value/.test(text), 'no keys');
}

test('the issue title is the one in the config', () => {
  assert.equal(REAL_CONFIG.alerts.issue_title, TITLE);
  assert.equal(REAL_CONFIG.alerts.expiry_warn_days, 21);
  assert.equal(REAL_CONFIG.alerts.healthy_hours_to_close, 24);
});

test('a Metaculus 401 opens one issue with the code only, and it closes after 24 healthy hours', async () => {
  const w = world();
  const broken = makeFetch({ github: w.github, metaculus: { handle: () => json(401, { detail: 'Invalid token.' }) }, routine: w.routine });
  const { exitCode } = await w.run({ fetch: broken });
  assert.equal(exitCode, 1);
  assert.equal(w.issues().length, 1);
  const issue = w.issues()[0];
  assert.equal(issue.title, TITLE);
  assert.match(issue.body, /`metaculus_setup` \(HTTP 401\)/);
  assert.ok(!issue.body.includes('Invalid token'), 'no response body');
  assertPublicSafe(issue.body);

  w.clock += minutes(20);
  await w.run();
  assert.equal(w.issues()[0].state, 'open', 'not yet 24 healthy hours');
  assert.equal(w.issues()[0].comments.length, 0);

  w.clock += hours(24);
  await w.run();
  assert.equal(w.issues()[0].state, 'closed');
  assert.match(w.issues()[0].comments.at(-1), /No problems for 24 hours/);
  assert.equal(w.state('ops.json').alert, undefined);
});

test('a refused wake-up (401) and an unreadable data repo are reported', async () => {
  const w = world();
  w.open('binary', 11);
  w.routine.script.push(json(401, { type: 'error' }));
  const fetch = fetchWith(w, (url) => (url.includes(`/repos/${DATA}/git/ref/`) ? json(401, { message: 'Bad credentials' }) : null));
  await w.run({ fetch });
  const body = w.issues()[0].body;
  assert.match(body, /`wake_setup` \(HTTP 401\)/);
  assert.match(body, /`data_repo_unreadable` \(HTTP 401\)/);
  assertPublicSafe(body);
});

test('a 400 from a paused task is a setup problem too; a 429 is reported as a rate limit, not as setup', async () => {
  const w = world();
  w.open('binary', 12);
  w.routine.script.push(json(400, {}));
  await w.run();
  assert.match(w.issues()[0].body, /wake_setup.*HTTP 400/);

  const v = world();
  v.open('binary', 13);
  v.routine.script.push(json(429, {}, { 'retry-after': '3600' }));
  await v.run();
  assert.equal(v.issues().length, 1);
  assert.match(v.issues()[0].body, /`wake_rate_limited` \(HTTP 429\)/);
  assert.doesNotMatch(v.issues()[0].body, /wake_setup/);
});

test('two missed questions in 24 hours open the issue with their ids; the same problems add no comment', async () => {
  const w = world();
  w.open('binary', 21, 60);
  await w.run();
  assert.equal(w.issues().length, 0);
  w.open('binary', 22, 50);
  w.clock += minutes(1);
  await w.run();
  w.clock += minutes(61);
  for (const id of [21, 22]) {
    w.metaculus.posts.get(w.posts.get(id).post.id).status = 'closed';
  }
  const { exitCode } = await w.run();
  assert.equal(exitCode, 1);
  assert.equal(w.issues().length, 1);
  assert.match(w.issues()[0].body, /`missed_questions` \(21, 22\)/);
  assertPublicSafe(w.issues()[0].body);

  w.clock += minutes(20);
  await w.run();
  assert.equal(w.issues()[0].comments.length, 0, 'nothing new, no comment');

  w.open('binary', 23, 10);
  w.clock += minutes(1);
  await w.run();
  assert.equal(w.issues()[0].comments.length, 1, 'a third lost question updates the issue');
  assert.match(w.issues()[0].comments[0], /21, 22, 23/);
});

test('one missed question alone does not open the issue', async () => {
  const w = world();
  w.open('binary', 31, 10);
  await w.run();
  assert.equal(w.issues().length, 0);
});

test('the daily fire budget being reached is reported', async () => {
  const w = world();
  w.github.commitFiles(PUBLIC, 'state', { 'fired.json': '{}', 'posted.json': '{}', 'ops.json': JSON.stringify({ fires: { day: '2026-11-16', count: 12 } }) });
  await w.run();
  assert.match(w.issues()[0].body, /`fire_budget_reached` \(2026-11-16: 12 of 12\)/);
});

test('a token in ops/EXPIRY.md that expires within 21 days is reported by name and date', async () => {
  const text = [
    '| Token | Where it lives | What it can do | Expires (YYYY-MM-DD) | How to renew |',
    '|---|---|---|---|---|',
    '| METACULUS_TOKEN | GitHub environment | post | | Metaculus settings |',
    '| Plumbing token | three places | read data, start ticks | 2026-12-01 | GitHub settings |',
    '| ROUTINE_FIRE_TOKEN | GitHub environment | wake the agent | 2027-06-01 | task page |',
  ].join('\n');
  assert.deepEqual(expiringTokens(text, NOW, 21), [{ token: 'Plumbing token', expires: '2026-12-01', days_left: 14 }]);
  assert.deepEqual(expiringTokens(text, NOW, 10), []);
  assert.deepEqual(expiringTokens(text, Date.parse('2027-06-02T00:00:00Z'), 21).map((t) => t.token), ['Plumbing token', 'ROUTINE_FIRE_TOKEN'], 'past dates count too');

  const w = world({ expiryText: text });
  await w.run();
  assert.match(w.issues()[0].body, /`token_expiring` \(Plumbing token 2026-12-01\)/);
});

test('the shipped ops/EXPIRY.md has blank dates and raises nothing', async () => {
  const w = world();
  const { readFile } = await import('node:fs/promises');
  w.expiryText = await readFile(new URL('../ops/EXPIRY.md', import.meta.url), 'utf8');
  assert.match(w.expiryText, /Expires/);
  await w.run();
  assert.equal(w.issues().length, 0);
});

test('a slow clock (runs every 5 hours) is measured once a day and reported', async () => {
  const w = world();
  for (let h = 45; h >= 0; h -= 5) w.github.addRun(PUBLIC, { created_at: iso(NOW - hours(h)) });
  w.github.addRun(PUBLIC, { event: 'workflow_dispatch', created_at: iso(NOW - hours(3)) });
  await w.run();
  const check = w.state('ops.json').clock_check;
  assert.equal(check.verdict, 'too_slow');
  assert.match(w.issues()[0].body, /`clock_slow` \(median gap \d+(\.\d)? min\)/);
  const runCalls = () => w.github.calls.filter((c) => c.path.includes('/actions/workflows/tick.yml/runs')).length;
  assert.equal(runCalls(), 1);
  w.clock += hours(2);
  await w.run();
  assert.equal(runCalls(), 1, 'measured once a day only');
  w.clock += hours(23);
  await w.run();
  assert.equal(runCalls(), 2);
});

test('a healthy clock raises nothing', async () => {
  const w = world();
  for (let m = 48 * 60 - 20; m >= 0; m -= 15) w.github.addRun(PUBLIC, { event: m % 60 ? 'workflow_dispatch' : 'schedule', created_at: iso(NOW - minutes(m)) });
  await w.run();
  assert.equal(w.state('ops.json').clock_check.verdict, 'ok');
  assert.equal(w.issues().length, 0);
});

test('a dry run never opens an issue', async () => {
  const w = world();
  const broken = makeFetch({ github: w.github, metaculus: { handle: () => json(404, {}) }, routine: w.routine });
  const env = { ...w.env, ROUTINE_FIRE_URL: '', ROUTINE_FIRE_TOKEN: '' };
  await w.run({ fetch: broken, dryRun: true, env });
  assert.equal(w.issues().length, 0);
  assert.ok(w.lines.some((l) => l.includes('dry run, would open or update')));
});

test('an issue with the same title opened by someone else is never used', async () => {
  const w = world();
  w.github.repos.get(PUBLIC).issues.push({ number: 1, title: TITLE, body: 'spam', state: 'open', user: { login: 'stranger' }, comments: [] });
  const broken = makeFetch({ github: w.github, metaculus: { handle: () => json(401, {}) }, routine: w.routine });
  await w.run({ fetch: broken });
  assert.equal(w.issues().length, 2);
  assert.equal(w.issues()[0].comments.length, 0);
  assert.equal(w.issues()[1].user.login, 'github-actions[bot]');
});

test('an issue the owner closed by hand stays closed until the problems change', async () => {
  const w = world();
  const broken = makeFetch({ github: w.github, metaculus: { handle: () => json(401, {}) }, routine: w.routine });
  await w.run({ fetch: broken });
  w.issues()[0].state = 'closed';
  w.clock += minutes(20);
  await w.run({ fetch: broken });
  assert.equal(w.issues().length, 1, 'no new issue for the same problem');
  const notFound = makeFetch({ github: w.github, metaculus: { handle: () => json(404, {}) }, routine: w.routine });
  w.clock += minutes(20);
  await w.run({ fetch: notFound });
  assert.equal(w.issues().length, 2, 'a different problem opens a new issue');
  assert.match(w.issues()[1].body, /HTTP 404/);
});

test('issue text: codes, ids and a hint per code, nothing else', () => {
  const body = issueBody({ problems: [{ code: 'clock_slow', detail: 'median gap 300 min' }], iso: '2026-11-16T10:00:00Z', runUrl: null, healthyHours: 24 });
  assert.match(body, /ops\/CLOCK\.md/);
  assert.match(body, /closed by the tick itself after 24 hours/);
});

test('the weekly keep-alive re-enables the workflow once a week, only in live runs inside Actions', async () => {
  const w = world();
  const calls = () => w.github.repos.get(PUBLIC).enableCalls;
  await w.run();
  assert.equal(calls(), 1);
  w.clock += hours(24 * 6);
  await w.run();
  assert.equal(calls(), 1);
  w.clock += hours(24 * 1 + 1);
  await w.run();
  assert.equal(calls(), 2);

  const d = world();
  await d.run({ dryRun: true, env: { ...d.env, ROUTINE_FIRE_URL: '', ROUTINE_FIRE_TOKEN: '' } });
  assert.equal(d.github.repos.get(PUBLIC).enableCalls, 0, 'not in a dry run');
  const local = world();
  await local.run({ env: { ...local.env, GITHUB_ACTIONS: '', TICK_ALLOW_LOCAL: 'yes' } });
  assert.equal(local.github.repos.get(PUBLIC).enableCalls, 0, 'not outside Actions');
});

test('a failing keep-alive is logged and turns the run red, and the tick still does its work', async () => {
  const w = world();
  w.open('binary', 41);
  const fetch = fetchWith(w, (url, init) => (init.method === 'PUT' && url.endsWith('/enable') ? json(403, {}) : null));
  const { exitCode, summary } = await w.run({ fetch });
  assert.equal(exitCode, 1);
  assert.ok(summary.errors.includes('keepalive_failed'));
  assert.equal(w.routine.requests.length, 1);
});

test('an optional tournament slug that Metaculus does not know yet is probed without failing; a required one alerts', async () => {
  const { CONFIG } = await import('./helpers/world.mjs');
  const make = (optional) => ({
    ...CONFIG,
    profiles: { ...CONFIG.profiles, live: { ...CONFIG.profiles.live, tournaments: [...CONFIG.profiles.live.tournaments, { slug: 'spring-futureeval-2027', ...(optional ? { optional: true } : {}) }] } },
  });
  for (const optional of [true, false]) {
    const w = world({ config: make(optional) });
    const fetch = fetchWith(w, (url) => (url.includes('tournaments=spring-futureeval-2027') ? json(404, { detail: 'Not found.' }) : null));
    const { exitCode } = await w.run({ fetch });
    if (optional) {
      assert.equal(exitCode, 0);
      assert.equal(w.issues().length, 0);
    } else {
      assert.equal(exitCode, 1);
      assert.match(w.issues()[0].body, /`metaculus_setup` \(HTTP 404\)/);
    }
  }
});
