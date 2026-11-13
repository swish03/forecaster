import test from 'node:test';
import assert from 'node:assert/strict';

import { TOKENS, json, makeFetch } from './helpers/fakes.mjs';
import { NOW, minutes } from './helpers/fixtures.mjs';
import { CONFIG, PUBLIC, world } from './helpers/world.mjs';

function assertNoSecretsLogged(w) {
  const all = w.lines.join('\n');
  for (const value of Object.values(TOKENS)) assert.ok(!all.includes(value), 'a secret appeared in the log');
  assert.ok(!all.includes('trig_test'), 'the fire URL appeared in the log');
  assert.ok(!all.includes('forecaster-data'), 'the private repo name appeared in the log');
}

test('nothing open: no fire, only the daily housekeeping is written, then nothing, exit 0', async () => {
  const w = world();
  const { exitCode, summary } = await w.run();
  assert.equal(exitCode, 0);
  assert.equal(w.routine.requests.length, 0);
  assert.deepEqual(summary.fired, []);
  // The first tick records its daily clock and environment checks, the weekly
  // keep-alive and when it started watching for open questions, nothing else.
  assert.deepEqual(w.state('fired.json'), {});
  assert.deepEqual(w.state('posted.json'), {});
  assert.deepEqual(Object.keys(w.state('ops.json')).sort(), ['clock_check', 'environment_check', 'keepalive_at', 'live_seen_at']);
  const head = w.github.repos.get(PUBLIC).refs.state;
  w.clock += minutes(20);
  assert.equal((await w.run()).exitCode, 0);
  assert.equal(w.github.repos.get(PUBLIC).refs.state, head, 'an idle tick writes no state');
  assertNoSecretsLogged(w);
});

test('three open questions, none fired: one fire with all three, ledger updated', async () => {
  const w = world();
  w.open('binary', 101, 170);
  w.open('multiple_choice', 102, 120, 'minibench');
  w.open('numeric', 103, 150);
  const { exitCode } = await w.run();
  assert.equal(exitCode, 0);
  assert.equal(w.routine.requests.length, 1);
  const payload = JSON.parse(w.routine.requests[0].body.text);
  assert.deepEqual(payload.questions.map((q) => q.question_id), [102, 103, 101], 'soonest close first');
  const mc = payload.questions[0];
  assert.equal(mc.tournament, 'minibench');
  assert.deepEqual(mc.options, ['Alpha', 'Beta', 'Gamma (Δ)']);
  assert.equal(mc.resolution_criteria, 'Resolves per the named source.');
  assert.equal(mc.attempt, 1);
  const numeric = payload.questions[1];
  assert.equal(numeric.range.cdf_points, 201);
  assert.equal(numeric.range.open_upper_bound, true);
  const fired = w.state('fired.json');
  assert.deepEqual(Object.keys(fired).sort(), ['101', '102', '103']);
  assert.equal(fired[101].count, 1);
  assert.equal(fired[101].closes_at, new Date(NOW + minutes(170)).toISOString());
  assert.ok(!JSON.stringify(fired).includes('Test question'), 'the public ledger holds no question text');

  w.clock += minutes(10);
  await w.run();
  assert.equal(w.routine.requests.length, 1, 'not fired again while the agent works');
  assertNoSecretsLogged(w);
});

test('a valid forecast file is posted once, with its comment, and recorded', async () => {
  const w = world();
  w.open('binary', 201);
  await w.run();
  w.clock += minutes(20);
  const file = w.writeForecast(201);
  const { exitCode, summary } = await w.run();
  assert.equal(exitCode, 0);
  assert.deepEqual(summary.statuses.posted, [201]);
  const writes = w.forecastWrites();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.forecasts, [{ question: 201, source: 'api', probability_yes: 0.3 }]);
  assert.equal(writes[0].body.comments[0].text, file.comment);
  assert.equal(writes[0].body.comments[0].on_post, w.posts.get(201).post.id);
  const posted = w.state('posted.json')[201];
  assert.equal(posted.status, 'posted');
  assert.equal(posted.http, 201);
  assert.match(posted.hash, /^[0-9a-f]{64}$/);

  w.clock += minutes(10);
  await w.run();
  assert.equal(w.forecastWrites().length, 1, 'never posted twice');
  assert.equal(w.routine.requests.length, 1, 'not fired again');
  assertNoSecretsLogged(w);
});

test('every question type posts the right Metaculus field', async () => {
  const w = world();
  const kinds = { 301: 'multiple_choice', 302: 'discrete', 303: 'date', 304: 'numeric_log' };
  for (const [id, kind] of Object.entries(kinds)) w.open(kind, Number(id));
  await w.run();
  for (const id of Object.keys(kinds)) w.writeForecast(Number(id));
  const { exitCode } = await w.run();
  assert.equal(exitCode, 0);
  const byQuestion = Object.fromEntries(w.forecastWrites().map((x) => [x.body.forecasts[0].question, x.body.forecasts[0]]));
  assert.ok(byQuestion[301].probability_yes_per_category);
  assert.equal(byQuestion[302].continuous_cdf.length, 11);
  assert.equal(byQuestion[303].continuous_cdf.length, 201);
  assert.equal(byQuestion[304].continuous_cdf[0], 0);
});

test('an invalid forecast file is refused, recorded with its reason, and the run goes red', async () => {
  const w = world();
  w.open('binary', 401);
  await w.run();
  w.writeForecast(401, { forecast: { probability_yes: 1 }, comment: '' });
  const { exitCode, summary } = await w.run();
  assert.equal(exitCode, 1);
  assert.deepEqual(summary.statuses.invalid, [401]);
  assert.equal(w.forecastWrites().length, 0);
  const record = w.state('posted.json')[401];
  assert.equal(record.status, 'invalid');
  assert.equal(record.revision, 1);
  // The state branch is public: a code that tells something about the
  // number (here: above 99%) is shown only as forecast_value_rule.
  assert.deepEqual(record.problems.sort(), ['comment_too_short', 'forecast_value_rule']);
  assert.ok(!w.lines.join('\n').includes('binary_out_of_range'), 'no value code in the public log');
  assert.ok(!w.lines.join('\n').includes('must be in'), 'public logs show problem codes only, never details');
  // The same tick asked the agent once more, for a replacement file.
  assert.equal(w.routine.requests.length, 2);
  const again = JSON.parse(w.routine.requests[1].body.text).questions[0];
  assert.equal(again.revision, 2);
  assert.deepEqual(again.previous_file_problems.sort(), ['comment_too_short', 'forecast_value_rule']);

  w.clock += minutes(10);
  const later = await w.run();
  assert.equal(later.exitCode, 0, 'only the run that found the refusal is red');
  assert.deepEqual(later.summary.attention, ['401:invalid']);
  assert.equal(w.forecastWrites().length, 0, 'an invalid file stays refused');
  assert.equal(w.routine.requests.length, 2, 'and its question is not fired a third time');
});

test('a file for a question the tick never sent is refused', async () => {
  const w = world();
  w.open('binary', 501);
  w.writeForecast(501);
  const { exitCode, summary } = await w.run();
  assert.equal(exitCode, 1);
  assert.deepEqual(summary.statuses.not_sent, [501]);
  assert.equal(w.forecastWrites().length, 0);
  assert.equal(w.state('posted.json')[501].status, 'not_sent');
});

test('duplicates: a question the API says is already forecast is never posted again', async () => {
  const w = world();
  w.open('binary', 601);
  await w.run();
  w.metaculus.markForecast(601);
  w.writeForecast(601);
  const { summary } = await w.run();
  assert.deepEqual(summary.statuses.already_forecast, [601]);
  assert.equal(w.forecastWrites().length, 0);
});

test('a crash after the in-flight mark is resolved from the API, without a second POST', async () => {
  const w = world();
  w.open('binary', 701);
  await w.run();
  w.writeForecast(701);
  // The forecast was saved by Metaculus, but the reply was a 502.
  w.metaculus.writeResponder = (path, body) => {
    for (const f of body.forecasts) w.metaculus.markForecast(f.question);
    return json(502, {});
  };
  const first = await w.run();
  assert.equal(first.exitCode, 1);
  assert.equal(w.state('posted.json')[701].status, 'unknown');
  w.metaculus.writeResponder = null;
  w.clock += minutes(10);
  const second = await w.run();
  assert.equal(second.exitCode, 0);
  assert.equal(w.forecastWrites().length, 1, 'no blind retry');
  assert.equal(w.state('posted.json')[701].status, 'posted');
  assert.equal(w.state('posted.json')[701].confirmed_by, 'api');
});

test('an unknown result where nothing was saved is retried once after checking the API', async () => {
  const w = world();
  w.open('binary', 702);
  await w.run();
  w.writeForecast(702);
  w.metaculus.writeResponder = () => json(503, {});
  await w.run();
  w.metaculus.writeResponder = null;
  await w.run();
  assert.equal(w.forecastWrites().length, 1, 'right after an unclear answer, it waits (the API record may lag)');
  w.clock += minutes(CONFIG.posting.unknown_retry_after_minutes);
  await w.run();
  assert.equal(w.forecastWrites().length, 2);
  assert.equal(w.state('posted.json')[702].status, 'posted');
  assert.equal(w.state('posted.json')[702].attempts, 2);
});

test('a question about to close is not sent to the agent, and that is reported as a loss', async () => {
  const w = world();
  w.open('binary', 801, 10);
  const { summary, exitCode } = await w.run();
  assert.equal(w.routine.requests.length, 0);
  assert.deepEqual(summary.skipped, [{ question_id: 801, reason: 'closing_too_soon' }]);
  assert.equal(exitCode, 1, 'a question that will close unforecast turns the run red');
  assert.equal(w.state('posted.json')[801].status, 'skipped_unforecast');
  assert.ok(w.lines.some((l) => l.includes('801: WILL CLOSE UNFORECAST')));
});

test('second fire only after 60 minutes without a file and with 45 minutes left', async () => {
  const w = world();
  w.open('binary', 901, 170);
  w.open('binary', 902, 100);
  await w.run();
  assert.equal(w.routine.requests.length, 1);

  w.clock += minutes(30);
  await w.run();
  assert.equal(w.routine.requests.length, 1, 'too early for a second fire');

  w.clock += minutes(35);
  await w.run();
  assert.equal(w.routine.requests.length, 2);
  const payload = JSON.parse(w.routine.requests[1].body.text);
  assert.deepEqual(payload.questions.map((q) => q.question_id), [901], '902 has only 35 minutes left');
  assert.equal(payload.questions[0].attempt, 2);
  assert.equal(w.state('fired.json')[901].count, 2);

  w.clock += minutes(70);
  await w.run();
  assert.equal(w.routine.requests.length, 2, 'never a third fire');
});

test('a sent question that closes with no file is recorded as missed', async () => {
  const w = world();
  w.open('binary', 1001, 60);
  await w.run();
  w.clock += minutes(61);
  w.metaculus.posts.get(w.posts.get(1001).post.id).status = 'closed';
  const { exitCode, summary } = await w.run();
  assert.equal(exitCode, 1);
  assert.deepEqual(summary.missed, [1001]);
  assert.equal(w.state('posted.json')[1001].status, 'missed');
});

test('a file that arrives after the question closed is late, not posted', async () => {
  const w = world();
  w.open('binary', 1101, 60);
  await w.run();
  w.clock += minutes(59.5);
  w.writeForecast(1101);
  const { summary } = await w.run();
  assert.deepEqual(summary.statuses.late, [1101], 'inside the 60-second safety margin');
  assert.equal(w.forecastWrites().length, 0);
});

test('dry run: reports what it would do and writes nothing anywhere', async () => {
  const w = world();
  w.open('binary', 1201);
  w.open('binary', 1202);
  await w.run();
  const stateHead = w.github.repos.get(PUBLIC).refs.state;
  w.writeForecast(1201);
  w.clock += minutes(70);
  const env = { ...w.env, ROUTINE_FIRE_URL: '', ROUTINE_FIRE_TOKEN: '' };
  const { exitCode, summary } = await w.run({ dryRun: true, env });
  assert.equal(exitCode, 0);
  assert.deepEqual(summary.wouldPost, [1201]);
  assert.deepEqual(summary.wouldFire, [1202]);
  assert.equal(w.forecastWrites().length, 0);
  assert.equal(w.routine.requests.length, 1, 'only the earlier real fire');
  assert.equal(w.github.repos.get(PUBLIC).refs.state, stateHead, 'state untouched');
  assert.ok(w.lines.some((l) => l.includes('dry run, would post')));
});

test('missing secrets stop the tick with exit code 2 and name only the variables', async () => {
  const w = world();
  const env = { ...w.env, METACULUS_TOKEN: '' };
  const { exitCode } = await w.run({ env });
  assert.equal(exitCode, 2);
  assert.ok(w.lines.some((l) => l.includes('METACULUS_TOKEN')));
  assertNoSecretsLogged(w);
  const badProfile = await w.run({ profileName: 'nope' });
  assert.equal(badProfile.exitCode, 2);
});

test('a Metaculus outage stops the run red without firing or posting', async () => {
  const w = world();
  w.open('binary', 1301);
  const fetch = makeFetch({ github: w.github, metaculus: { handle: () => json(503, {}) }, routine: w.routine });
  const { exitCode } = await w.run({ fetch });
  assert.equal(exitCode, 1);
  assert.equal(w.routine.requests.length, 0);
});

test('the test profile lists only the bot testing area', async () => {
  const w = world();
  w.open('binary', 1401, 150, '32977');
  w.open('binary', 1402, 150, '33121');
  await w.run({ profileName: 'test' });
  const payload = JSON.parse(w.routine.requests[0].body.text);
  assert.deepEqual(payload.questions.map((q) => [q.question_id, q.tournament]), [[1401, 'bot-testing-area']]);
});
