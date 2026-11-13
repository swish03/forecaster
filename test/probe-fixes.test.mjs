// Regression tests for the findings of the three probes (rehearsal as the
// cloud agent, tournament-admin red team, security and operations review).
// One test or more per defect; the fake world has no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fileToCheck } from '../poster/tick.mjs';
import { json, makeFetch } from './helpers/fakes.mjs';
import { METHOD_VERSION, NOW, groupPost, minutes, questionFor } from './helpers/fixtures.mjs';
import { CONFIG, DATA, PUBLIC, world } from './helpers/world.mjs';

const fetchWith = (w, overrides) => {
  const base = makeFetch({ github: w.github, metaculus: w.metaculus, routine: w.routine });
  return async (url, init = {}) => (await overrides(url, init)) ?? base(url, init);
};
const payload = (w, i) => JSON.parse(w.routine.requests[i].body.text);
const comment = (p) => `Forecast: ${Number((p * 100).toPrecision(4))}% (bot v1.2, fully automated, no human input)\nQuestion as read: a test question.`;

// ---- red team RT1: a refused sibling of a group is not lost --------------------

test('group: a refused sibling holds the others, gets its replacement, and the group goes in one request', async () => {
  const w = world();
  const close = NOW + minutes(170);
  const a = { ...questionFor('binary', 501, close), label: 'A' };
  const b = { ...questionFor('binary', 502, close), label: 'B' };
  w.openPost(groupPost(5000, [a, b]), [a, b]);
  await w.run();
  w.writeForecast(501);
  w.writeForecast(502, { comment: 'too short' });
  await w.run();
  assert.equal(w.forecastWrites().length, 0, '501 waits for the replacement of 502');
  assert.equal(w.state('posted.json')[501].status, 'held');
  assert.equal(w.state('posted.json')[502].status, 'invalid');
  assert.equal(w.routine.requests.length, 2, 'the replacement for 502 was asked for');
  assert.deepEqual(payload(w, 1).questions.map((q) => [q.question_id, q.revision]), [[502, 2]]);

  w.clock += minutes(15);
  w.writeForecast(502, {}, '502.r2.json');
  await w.run();
  assert.equal(w.forecastWrites().length, 1);
  assert.deepEqual(w.forecastWrites()[0].body.forecasts.map((f) => f.question), [501, 502]);
});

test('group: the hold ends 45 minutes before the deadline, more than two clock periods', async () => {
  assert.equal(CONFIG.posting.group_hold_until_minutes_left, 45);
  const w = world();
  const close = NOW + minutes(150);
  const a = questionFor('binary', 511, close);
  const b = questionFor('binary', 512, close);
  w.openPost(groupPost(5100, [a, b]), [a, b]);
  await w.run();
  w.writeForecast(511);
  w.clock = close - minutes(46);
  await w.run();
  assert.equal(w.forecastWrites().length, 0);
  w.clock = close - minutes(44);
  await w.run();
  assert.deepEqual(w.forecastWrites().map((x) => x.body.forecasts.map((f) => f.question)), [[511]]);
});

// ---- write-once is enforced by the tick (RT2, swap.mjs) ----------------------

test('a file changed after an unclear first send is refused as file_changed and never posted', async () => {
  const w = world();
  w.open('binary', 521);
  await w.run();
  w.writeForecast(521, { forecast: { probability_yes: 0.2 }, comment: comment(0.2) });
  w.metaculus.writeResponder = () => json(503, {});
  await w.run();
  assert.equal(w.state('posted.json')[521].status, 'unknown');
  w.metaculus.writeResponder = null;
  w.writeForecast(521, { forecast: { probability_yes: 0.8 }, comment: comment(0.8) });
  w.clock += minutes(15);
  const { summary } = await w.run();
  assert.deepEqual(summary.statuses.invalid, [521]);
  assert.deepEqual(w.state('posted.json')[521].problems, ['file_changed']);
  assert.deepEqual(w.forecastWrites().map((x) => x.body.forecasts[0].probability_yes), [0.2], 'only the first file was ever sent');
});

test('a held group file that is changed is refused as file_changed', async () => {
  const w = world();
  const close = NOW + minutes(170);
  const a = questionFor('binary', 531, close);
  const b = questionFor('binary', 532, close);
  w.openPost(groupPost(5300, [a, b]), [a, b]);
  await w.run();
  w.writeForecast(531, { forecast: { probability_yes: 0.2 }, comment: comment(0.2) });
  await w.run();
  assert.equal(w.state('posted.json')[531].status, 'held');
  w.writeForecast(531, { forecast: { probability_yes: 0.7 }, comment: comment(0.7) });
  w.writeForecast(532);
  await w.run();
  assert.deepEqual(w.state('posted.json')[531].problems, ['file_changed']);
  assert.equal(w.forecastWrites().length, 0, 'the changed file is never posted; 532 now waits for the replacement of 531');
  assert.equal(w.state('posted.json')[532].status, 'held');
  assert.deepEqual(payload(w, 1).questions.map((q) => [q.question_id, q.revision]), [[531, 2]]);
});

// ---- the comment states the posted forecast ----------------------------------

test('a yes/no comment whose Forecast line does not match the number is refused', async () => {
  const w = world();
  w.open('binary', 541);
  await w.run();
  w.writeForecast(541, { forecast: { probability_yes: 0.3 }, comment: comment(0.45) });
  await w.run();
  assert.deepEqual(w.state('posted.json')[541].problems, ['comment_forecast_mismatch']);
  assert.equal(w.forecastWrites().length, 0);
});

// ---- stale code and re-runs ---------------------------------------------------

test('a re-run, a run of another branch, and a run of an old commit post nothing, send nothing and write nothing', async () => {
  const w = world();
  w.open('binary', 551);
  await w.run();
  w.writeForecast(551);
  const stateBefore = w.github.repos.get(PUBLIC).refs.state;

  const rerun = await w.run({ env: { ...w.env, GITHUB_RUN_ATTEMPT: '2' } });
  assert.equal(rerun.exitCode, 2);
  const branch = await w.run({ env: { ...w.env, GITHUB_REF: 'refs/heads/feature' } });
  assert.equal(branch.exitCode, 2);
  w.github.commitFiles(PUBLIC, 'main', { 'README.md': 'a newer main' });
  const old = await w.run();
  assert.equal(old.exitCode, 1);
  assert.ok(w.lines.some((l) => l.includes('stale code: main has moved on')));

  assert.equal(w.forecastWrites().length, 0);
  assert.equal(w.routine.requests.length, 1, 'only the first, fresh run woke the agent');
  assert.equal(w.github.repos.get(PUBLIC).refs.state, stateBefore, 'no state write');
  assert.equal(w.issues().length, 0);
});

test('a live run inside Actions without GITHUB_SHA is a setup error', async () => {
  const w = world();
  const env = { ...w.env };
  delete env.GITHUB_SHA;
  assert.equal((await w.run({ env })).exitCode, 2);
});

// ---- a file pushed before a question is sent does not block it (preblock.mjs) ----

test('a file pushed before the question exists is never posted and does not block the question', async () => {
  const w = world();
  w.github.commitFiles(DATA, 'main', { 'forecasts/7777.json': '{"question_id": 7777}' });
  const first = await w.run();
  assert.deepEqual(first.summary.statuses.not_sent, [7777]);
  assert.match(w.issues()[0].body, /`unsent_file` \(7777\)/);

  w.clock += minutes(60);
  w.open('binary', 7777, 150);
  await w.run();
  assert.equal(w.routine.requests.length, 1, 'the question is sent after all');
  const sent = payload(w, 0).questions[0];
  assert.equal(sent.revision, 2, 'as a replacement request, so only <id>.r2.json counts');
  assert.deepEqual(sent.previous_file_problems, ['file_before_request']);
  assert.equal(w.state('fired.json')[7777].only_r2, true);

  w.clock += minutes(15);
  w.writeForecast(7777, {}, '7777.r2.json');
  await w.run();
  assert.equal(w.forecastWrites().length, 1);
  assert.equal(w.state('posted.json')[7777].status, 'posted');
  assert.equal(w.state('posted.json')[7777].revision, 2);
});

test('a question sent only as a replacement that gets no .r2 file is recorded as missed', async () => {
  const w = world();
  w.github.commitFiles(DATA, 'main', { 'forecasts/7778.json': '{}' });
  await w.run();
  w.open('binary', 7778, 100);
  await w.run();
  w.clock += minutes(101);
  w.metaculus.posts.get(w.posts.get(7778).post.id).status = 'closed';
  const { summary } = await w.run();
  assert.deepEqual(summary.missed, [7778]);
});

test('fileToCheck: a replacement file counts only after the tick asked for it', () => {
  const r1 = { revision: 1 };
  const r2 = { revision: 2 };
  const both = new Map([[1, r1], [2, r2]]);
  const refused = { status: 'invalid', revision: 1 };
  assert.deepEqual(fileToCheck(refused, both, { count: 1 }), { unrequested: r2 });
  assert.deepEqual(fileToCheck(refused, both, { count: 2, r2_requested_at: 't' }), { file: r2 });
  assert.deepEqual(fileToCheck(undefined, both, { count: 1, only_r2: true }), { file: r2 });
  assert.deepEqual(fileToCheck(undefined, both, { count: 1 }), { file: r1 });
  assert.deepEqual(fileToCheck({ status: 'posted', revision: 1 }, both, { count: 1 }), { file: null });
});

test('an .r2 file the tick never asked for is refused as not_requested', async () => {
  const w = world();
  w.open('binary', 561, 100);
  await w.run();
  w.clock += minutes(60);
  // 40 minutes left: too late for a replacement request (refire_min_minutes_left 45).
  w.writeForecast(561, { comment: 'too short' });
  await w.run();
  assert.equal(w.state('posted.json')[561].status, 'invalid');
  assert.equal(w.routine.requests.length, 1, 'no replacement was asked for');
  w.writeForecast(561, {}, '561.r2.json');
  w.clock += minutes(1);
  await w.run();
  assert.deepEqual(w.state('posted.json')[561], { ...w.state('posted.json')[561], status: 'invalid', revision: 2, problems: ['not_requested'] });
  assert.equal(w.forecastWrites().length, 0);
});

// ---- the file must match what was sent -----------------------------------------

test('a file for another tournament or another method version is refused', async () => {
  const w = world();
  w.open('binary', 571);
  w.open('binary', 572, 160);
  await w.run();
  assert.equal(w.state('fired.json')[571].tournament, 'fall-futureeval-2026');
  assert.equal(w.state('fired.json')[571].method_version, METHOD_VERSION);
  w.writeForecast(571, { tournament: 'minibench' });
  w.writeForecast(572, { method_version: '0.9' });
  await w.run();
  assert.deepEqual(w.state('posted.json')[571].problems, ['tournament_mismatch']);
  assert.deepEqual(w.state('posted.json')[572].problems, ['method_version_mismatch']);
  assert.equal(w.forecastWrites().length, 0);
});

// ---- the kit is pinned per question ----------------------------------------------

test('every wake-up names its kit commit; a second wake-up keeps the kit of the first', async () => {
  const w = world();
  w.open('binary', 581, 200);
  await w.run();
  assert.equal(payload(w, 0).kit_ref, w.mainSha);
  assert.equal(w.state('fired.json')[581].kit_ref, w.mainSha);

  // A method change is merged; the next ticks run the new commit.
  const newer = w.github.commitFiles(PUBLIC, 'main', { 'agent/method.md': 'v1.2' });
  w.env.GITHUB_SHA = newer;
  w.clock += minutes(61);
  w.open('binary', 582, 200);
  await w.run();
  const texts = w.routine.requests.slice(1).map((r) => JSON.parse(r.body.text));
  const kitOf = Object.fromEntries(texts.flatMap((t) => t.questions.map((q) => [q.question_id, t.kit_ref])));
  assert.equal(kitOf[581], w.mainSha, 'the second wake-up of 581 uses its first kit');
  assert.equal(kitOf[582], newer, 'a new question uses the new kit');
});

// ---- the deadline is checked again right before sending ----------------------

test('a question whose deadline passes while the tick works is recorded late, not sent', async () => {
  const w = world();
  w.open('binary', 591, 150);
  await w.run();
  w.writeForecast(591);
  // The question closes 61.5 s after the tick starts: open at the check
  // (margin 60 s), closed once this slow tick reaches the POST.
  const start = NOW + minutes(150) - 61500;
  w.clock = start;
  let calls = 0;
  const { summary } = await w.run({ now: () => start + (calls++) * 400 });
  assert.deepEqual(summary.statuses.late, [591]);
  assert.equal(w.forecastWrites().length, 0);
});

// ---- housekeeping alerts -----------------------------------------------------------

test('a changed CLAUDE.md, bootstrap.mjs or an extra workflow in the data repo opens the alert issue', async () => {
  const w = world();
  w.github.commitFiles(DATA, 'main', { 'CLAUDE.md': 'rules changed by someone' });
  await w.run();
  assert.match(w.issues()[0].body, /`data_repo_changed` \(1 file\(s\)\)/);

  const v = world();
  v.github.commitFiles(DATA, 'main', { '.github/workflows/steal.yml': 'name: x' });
  await v.run();
  assert.match(v.issues()[0].body, /`data_repo_changed`/);
  assert.ok(!v.issues()[0].body.includes('steal'), 'no path of the private repo in the public issue');

  const ok = world();
  await ok.run();
  assert.equal(ok.issues().length, 0, 'the expected files raise nothing');
});

test('a metaculus environment that is not limited to main opens the alert issue', async () => {
  const w = world();
  w.github.repos.get(PUBLIC).environments.metaculus.branches.push({ name: 'dev', type: 'branch' });
  await w.run();
  assert.match(w.issues()[0].body, /`environment_unprotected` \(metaculus\)/);
  assert.equal(w.state('ops.json').environment_check.verdict, 'unprotected');
});

test('the plumbing token expiry date that GitHub sends is reported even with a blank ops/EXPIRY.md', async () => {
  const w = world();
  const base = makeFetch({ github: w.github, metaculus: w.metaculus, routine: w.routine });
  const fetch = async (url, init = {}) => {
    const res = await base(url, init);
    if (!url.includes(`/repos/${DATA}/`)) return res;
    const headers = new Headers(res.headers);
    headers.set('github-authentication-token-expiration', '2026-11-30 10:00:00 UTC');
    return new Response(await res.text(), { status: res.status, headers });
  };
  await w.run({ fetch });
  assert.match(w.issues()[0].body, /`token_expiring` \(DATA_REPO_TOKEN 2026-11-30\)/);
});

test('three days without any open live question opens the alert issue', async () => {
  const w = world();
  await w.run();
  assert.equal(w.issues().length, 0);
  w.clock += minutes(60 * 71);
  await w.run();
  assert.equal(w.issues().length, 0);
  w.clock += minutes(60 * 2);
  await w.run();
  assert.match(w.issues()[0].body, /`no_live_questions`/);
  w.open('binary', 601);
  w.clock += minutes(15);
  await w.run();
  assert.ok(!(w.issues()[0].comments.at(-1) ?? '').includes('no_live_questions'), 'a seen question clears it');
});

test('an unknown optional slug that Metaculus answers with 400 is treated as empty, not as a failure', async () => {
  const w = world();
  const fetch = fetchWith(w, (url) => (url.includes('tournaments=minibench-2026') ? json(400, { detail: 'bad' }) : null));
  const { exitCode, summary } = await w.run({ fetch });
  assert.equal(exitCode, 0);
  assert.deepEqual(summary.errors, []);
});
