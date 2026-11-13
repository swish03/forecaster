// Regression tests for the reviewed failure modes of the tick: duplicate
// posts, lost fire records, lost attempts, groups and conditionals, missed
// MiniBench rounds, silent losses and unsafe log text.

import test from 'node:test';
import assert from 'node:assert/strict';

import { datedRoundSlugs } from '../poster/tick.mjs';
import { json, makeFetch } from './helpers/fakes.mjs';
import { NOW, conditionalPost, groupPost, minutes, questionFor } from './helpers/fixtures.mjs';
import { CONFIG, DATA, world } from './helpers/world.mjs';

const fetchWith = (w, overrides) => {
  const base = makeFetch({ github: w.github, metaculus: w.metaculus, routine: w.routine });
  return async (url, init = {}) => (await overrides(url, init)) ?? base(url, init);
};

test('file names with leading zeros are ignored: one question is posted once', async () => {
  const w = world();
  w.open('binary', 123);
  await w.run();
  w.writeForecast(123, { forecast: { probability_yes: 0.3 } });
  w.writeForecast(123, { forecast: { probability_yes: 0.9 } }, '0123.json');
  w.writeForecast(123, { forecast: { probability_yes: 0.9 } }, '00123.json');
  const { summary } = await w.run();
  assert.deepEqual(summary.statuses.posted, [123]);
  assert.equal(w.forecastWrites().length, 1);
  assert.equal(w.forecastWrites()[0].body.forecasts[0].probability_yes, 0.3);
});

test('a lost state write after a fire does not lose the question or start a second session', async () => {
  const w = world();
  w.open('binary', 51);
  let failNextStateWrite = false;
  const fetch = fetchWith(w, (url, init) => {
    if (url.includes('api.anthropic.com')) failNextStateWrite = true;
    else if (failNextStateWrite && init.method === 'POST' && url.includes('/forecaster/git/trees')) {
      failNextStateWrite = false;
      return json(502, {});
    }
    return null;
  });
  const first = await w.run({ fetch });
  assert.equal(first.exitCode, 1);
  assert.equal(w.routine.requests.length, 1);
  assert.equal(w.state('fired.json')[51].count, 1, 'the fire was recorded before it was sent');

  w.clock += minutes(10);
  w.writeForecast(51);
  const second = await w.run();
  assert.deepEqual(second.summary.statuses.posted, [51]);
  assert.equal(w.routine.requests.length, 1, 'no second session');
});

test('a fire that was refused is rolled back, so the question is sent again next tick', async () => {
  const w = world();
  w.open('binary', 52);
  w.routine.script.push(json(401, {}));
  const first = await w.run();
  assert.equal(first.exitCode, 1);
  assert.equal(w.state('fired.json')[52], undefined);
  w.clock += minutes(10);
  await w.run();
  assert.equal(w.routine.requests.length, 2);
  assert.equal(w.state('fired.json')[52].count, 1);
  assert.equal(w.state('fired.json')[52].pending, undefined);
});

test('two overlapping ticks never both post the same question', async () => {
  const w = world();
  w.open('binary', 61);
  await w.run();
  w.writeForecast(61);
  const results = await Promise.all([w.run(), w.run()]);
  assert.equal(w.forecastWrites().length, 1);
  assert.ok(w.lines.some((l) => l.includes('state changed under this tick')), 'the second tick lost the claim');
  assert.deepEqual(results.map((r) => r.summary.errors.filter((e) => e.startsWith('claim_lost')).length).sort(), [0, 1]);
  assert.equal(w.state('posted.json')[61].status, 'posted');
});

test('a live run outside GitHub Actions is refused unless the owner allows it', async () => {
  const w = world();
  const { exitCode } = await w.run({ env: { ...w.env, GITHUB_ACTIONS: '' } });
  assert.equal(exitCode, 2);
  assert.ok(w.lines.some((l) => l.includes('only inside GitHub Actions')));
  const allowed = await w.run({ env: { ...w.env, GITHUB_ACTIONS: '', TICK_ALLOW_LOCAL: 'yes' } });
  assert.equal(allowed.exitCode, 0);
});

test('429 and a request that never left do not use up attempts', async () => {
  const w = world();
  w.open('binary', 71);
  await w.run();
  w.writeForecast(71);
  w.metaculus.writeResponder = () => json(429, {});
  for (let i = 0; i < 6; i += 1) {
    w.clock += minutes(10);
    await w.run();
  }
  const record = w.state('posted.json')[71];
  assert.equal(record.status, 'retry');
  assert.equal(record.attempts, 0);
  w.metaculus.writeResponder = null;
  w.clock += minutes(10);
  await w.run();
  assert.equal(w.state('posted.json')[71].status, 'posted');
});

test('5xx answers are retried after an API check, up to the attempt limit, then unconfirmed', async () => {
  const w = world();
  w.open('binary', 72, 170);
  await w.run();
  w.writeForecast(72);
  w.metaculus.writeResponder = () => json(503, {});
  for (let i = 0; i < 7; i += 1) {
    w.clock += minutes(10);
    await w.run();
  }
  assert.equal(w.forecastWrites().length, CONFIG.posting.max_post_attempts);
  assert.equal(w.state('posted.json')[72].status, 'unconfirmed');
});

test('a 403 is tried again once; a second 403 is final', async () => {
  const w = world();
  w.open('binary', 73);
  await w.run();
  w.writeForecast(73);
  w.metaculus.writeResponder = () => json(403, { detail: 'gateway' });
  await w.run();
  assert.equal(w.state('posted.json')[73].status, 'forbidden');
  w.clock += minutes(10);
  const rejected = await w.run();
  assert.equal(w.state('posted.json')[73].status, 'rejected');
  assert.equal(rejected.exitCode, 1, 'the run that records the rejection is red');
  w.clock += minutes(10);
  const after = await w.run();
  assert.equal(w.forecastWrites().length, 2);
  assert.equal(after.exitCode, 0, 'a later run is not red again for the same old problem');
  assert.deepEqual(after.summary.attention, ['73:rejected'], 'but it still lists it as an earlier problem');
});

test('a 401 or 404 on the write stops posting as a setup problem without using an attempt', async () => {
  const w = world();
  w.open('binary', 74);
  w.open('binary', 75, 160);
  await w.run();
  w.writeForecast(74);
  w.writeForecast(75);
  w.metaculus.writeResponder = () => json(404, {});
  const { exitCode } = await w.run();
  assert.equal(exitCode, 1);
  assert.equal(w.forecastWrites().length, 1, 'stops after the first refused request');
  assert.equal(w.state('posted.json')[74].status, 'retry');
  assert.equal(w.state('posted.json')[74].attempts, 0);
  assert.ok(w.lines.some((l) => l.includes('posting stopped')));
});

test('ready files are posted soonest deadline first', async () => {
  const w = world();
  w.open('binary', 81, 170);
  w.open('binary', 82, 60);
  await w.run();
  w.writeForecast(81, { created_at: new Date(NOW - minutes(30)).toISOString() });
  w.writeForecast(82, { created_at: new Date(NOW - minutes(1)).toISOString() });
  await w.run();
  assert.deepEqual(w.forecastWrites().map((x) => x.body.forecasts[0].question), [82, 81]);
});

test('a group post waits for every subquestion, then goes in one request', async () => {
  const w = world();
  const close = NOW + minutes(150);
  const a = { ...questionFor('binary', 91, close), label: 'A' };
  const b = { ...questionFor('binary', 92, close), label: 'B' };
  w.openPost(groupPost(9100, [a, b]), [a, b]);
  await w.run();
  const payload = JSON.parse(w.routine.requests[0].body.text);
  assert.deepEqual(payload.questions.map((q) => [q.question_id, q.post_kind]), [[91, 'group'], [92, 'group']]);

  w.writeForecast(91);
  await w.run();
  assert.equal(w.forecastWrites().length, 0, 'held until 92 also has a file');
  assert.ok(w.lines.some((l) => l.includes('holding 91 until 92')));

  w.writeForecast(92);
  const { summary } = await w.run();
  assert.equal(w.forecastWrites().length, 1);
  const body = w.forecastWrites()[0].body;
  assert.deepEqual(body.forecasts.map((f) => f.question), [91, 92]);
  assert.equal(body.comments.length, 2);
  assert.ok(body.comments.every((c) => c.on_post === 9100 && c.is_private));
  assert.deepEqual(summary.statuses.posted.sort(), [91, 92]);
});

test('a group post with a missing subquestion is posted alone when the deadline is near', async () => {
  const w = world();
  const close = NOW + minutes(150);
  const a = questionFor('binary', 93, close);
  const b = questionFor('binary', 94, close);
  w.openPost(groupPost(9300, [a, b]), [a, b]);
  await w.run();
  w.writeForecast(93);
  w.clock = close - minutes(CONFIG.posting.group_hold_until_minutes_left - 1);
  await w.run();
  assert.deepEqual(w.forecastWrites().map((x) => x.body.forecasts.map((f) => f.question)), [[93]]);
});

test('a conditional post is sent and posted with both branches in one request', async () => {
  const w = world();
  const post = conditionalPost(9500, { yes: 95, no: 96 });
  w.openPost(post, [post.conditional.question_yes, post.conditional.question_no]);
  await w.run();
  const sent = JSON.parse(w.routine.requests[0].body.text).questions;
  assert.deepEqual(sent.map((q) => [q.question_id, q.conditional.branch]), [[95, 'yes'], [96, 'no']]);
  assert.equal(sent[0].conditional.condition.title, 'Condition title');
  w.writeForecast(95);
  w.writeForecast(96);
  await w.run();
  assert.equal(w.forecastWrites().length, 1);
  assert.deepEqual(w.forecastWrites()[0].body.forecasts.map((f) => f.question), [95, 96]);
});

test('dated MiniBench rounds are listed too, so an outgoing round is not missed', async () => {
  assert.deepEqual(datedRoundSlugs(CONFIG.profiles.live.dated_rounds, NOW), ['minibench-2026-11-16', 'minibench-2026-11-02']);
  assert.deepEqual(datedRoundSlugs(CONFIG.profiles.live.dated_rounds, Date.parse('2026-11-12T00:00:00Z')), ['minibench-2026-11-02', 'minibench-2026-10-19']);
  const w = world();
  w.open('binary', 97, 150, 'minibench-2026-11-02');
  const { exitCode } = await w.run();
  assert.equal(exitCode, 0, 'an empty or unknown dated round is not an error');
  const payload = JSON.parse(w.routine.requests[0].body.text);
  assert.deepEqual(payload.questions.map((q) => [q.question_id, q.tournament]), [[97, 'minibench-2026-11-02']]);
});

test('a question with incomplete data turns the run red', async () => {
  const w = world();
  w.open('binary', 98);
  w.metaculus.findQuestion(98).type = 'something_new';
  const { exitCode, summary } = await w.run();
  assert.equal(exitCode, 1);
  assert.ok(summary.errors.some((e) => e.startsWith('question_incomplete:question_type_unsupported')));
  assert.equal(w.routine.requests.length, 0);
});

test('a problem turns only its own run red; later runs list it for the alert window, then drop it', async () => {
  const w = world();
  w.open('binary', 99, 10);
  assert.equal((await w.run()).exitCode, 1);
  w.clock += minutes(60);
  const later = await w.run();
  assert.equal(later.exitCode, 0, 'no email from every later run');
  assert.deepEqual(later.summary.attention, ['99:skipped_unforecast']);
  w.clock += minutes(CONFIG.posting.alert_window_hours * 60);
  const after = await w.run();
  assert.equal(after.exitCode, 0);
  assert.deepEqual(after.summary.attention, []);
});

test('a refused first file gets one replacement, forecasts/<id>.r2.json, which is posted', async () => {
  const w = world();
  w.open('binary', 111);
  await w.run();
  w.writeForecast(111, { comment: 'too short' });
  await w.run();
  assert.equal(w.state('posted.json')[111].status, 'invalid');
  assert.equal(w.routine.requests.length, 2);
  w.clock += minutes(15);
  w.writeForecast(111, {}, '111.r2.json');
  const { summary } = await w.run();
  assert.deepEqual(summary.statuses.posted, [111]);
  assert.equal(w.state('posted.json')[111].revision, 2);
  w.clock += minutes(10);
  await w.run();
  assert.equal(w.forecastWrites().length, 1);
  assert.equal(w.routine.requests.length, 2);
});

test('a file that could not be checked before close is late, not "missed"', async () => {
  const w = world();
  w.open('binary', 112, 60);
  await w.run();
  w.writeForecast(112);
  const postId = w.posts.get(112).post.id;
  const fetch = fetchWith(w, (url) => (url.includes(`/api/posts/${postId}/`) ? json(503, {}) : null));
  w.clock += minutes(30);
  await w.run({ fetch });
  w.clock += minutes(40);
  w.metaculus.posts.get(postId).status = 'closed';
  w.metaculus.findQuestion(112).status = 'closed';
  const { summary } = await w.run({ fetch });
  assert.deepEqual(summary.missed, []);
  assert.equal(w.state('posted.json')[112], undefined);
  const later = await w.run();
  assert.deepEqual(later.summary.statuses.late, [112]);
});

test('hostile text in a forecast file cannot reach the public log', async () => {
  const w = world();
  w.open('binary', 113);
  await w.run();
  w.writeForecast(113, { type: 'x\n::error::INJECTED\n::add-mask::', forecast: { probability_yes: 0.123456 } });
  await w.run();
  const all = w.lines.join('\n');
  assert.ok(!all.includes('INJECTED'));
  assert.ok(w.lines.every((l) => !/[\n\r]/.test(l) && !l.startsWith('::')));
  assert.ok(!all.includes('0.123456'));
  assert.equal(w.state('posted.json')[113].problems[0], 'type_mismatch');
});

test('error lines name the service and status only, never the private repo or a body', async () => {
  const w = world();
  w.open('binary', 114);
  await w.run();
  w.writeForecast(114);
  const fetch = fetchWith(w, (url) => (url.includes(`/repos/${DATA}/git/blobs/`) ? json(404, { message: 'secret detail' }) : null));
  await w.run({ fetch });
  const line = w.lines.find((l) => l.includes('could not read forecast file'));
  assert.match(line, /GET data repo \/git\/blobs\/:sha -> HTTP 404/);
  assert.ok(!w.lines.join('\n').includes('forecaster-data') && !w.lines.join('\n').includes('secret detail'));
});

test('the time budget stops new posts so the job ends before its timeout', async () => {
  const config = { ...CONFIG, posting: { ...CONFIG.posting, time_budget_seconds: 0 } };
  const w = world({ config });
  w.open('binary', 115);
  await w.run();
  w.writeForecast(115);
  let tickMs = w.clock;
  await w.run({ now: () => (tickMs += 1) });
  assert.equal(w.forecastWrites().length, 0);
  assert.ok(w.lines.some((l) => l.includes('time budget used')));
});

test('the data repo is listed by its forecasts folder only, so other folders can grow', async () => {
  const w = world();
  w.open('binary', 116);
  await w.run();
  w.writeForecast(116);
  const calls = [];
  const fetch = fetchWith(w, (url) => {
    calls.push(url);
    return null;
  });
  await w.run({ fetch });
  assert.ok(!calls.some((u) => u.includes('recursive=1')));
  assert.equal(w.forecastWrites().length, 1);
});
