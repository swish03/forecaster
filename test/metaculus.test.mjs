import test from 'node:test';
import assert from 'node:assert/strict';

import { createMetaculusClient, isOpenAt, questionsOfPost, toMetaculusForecast } from '../poster/metaculus.mjs';
import { FakeMetaculus, TOKENS, json, makeFetch, refusedError, timeoutError } from './helpers/fakes.mjs';
import { NOW, conditionalPost, groupPost, minutes, postWith, questionFor } from './helpers/fixtures.mjs';

const BASE = 'https://www.metaculus.com/api';

function client(fetch, extra = {}) {
  return createMetaculusClient({ baseUrl: BASE, token: TOKENS.metaculus, fetch, spacingMs: 0, sleep: async () => {}, now: () => NOW, ...extra });
}

test('sends the Token header and reads the bot user id', async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, init };
    return json(200, { id: 7 });
  };
  const me = await client(fetch).getMe();
  assert.equal(me.id, 7);
  assert.equal(seen.url, `${BASE}/users/me`);
  assert.equal(seen.init.headers.Authorization, `Token ${TOKENS.metaculus}`);
  assert.equal(seen.init.headers['Accept-Language'], 'en');
  assert.ok(seen.init.signal, 'every request has a timeout signal');
});

test('refuses to start without a token or with a plain-http base URL', () => {
  assert.throws(() => createMetaculusClient({ baseUrl: BASE, token: '' }), /METACULUS_TOKEN/);
  assert.throws(() => createMetaculusClient({ baseUrl: 'http://www.metaculus.com/api', token: 'x' }), /https/);
});

test('lists open posts with the not-yet-forecast filter, across pages', async () => {
  const fake = new FakeMetaculus();
  for (let i = 0; i < 150; i += 1) fake.addPost(postWith(questionFor('binary', 1000 + i)), ['33121']);
  fake.markForecast(1000);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    return makeFetch({ metaculus: fake })(url, init);
  };
  const posts = await client(fetch).listOpenPosts({ tournament: 33121, notForecasterId: 4242 });
  assert.equal(posts.length, 149);
  assert.equal(calls.length, 2);
  const first = new URL(calls[0]);
  assert.equal(first.searchParams.get('tournaments'), '33121');
  assert.equal(first.searchParams.get('statuses'), 'open');
  assert.equal(first.searchParams.get('not_forecaster_id'), '4242');
  assert.equal(first.searchParams.get('include_descriptions'), 'true');
  assert.equal(first.searchParams.get('forecast_type'), null, 'no type filter, it drops groups');
  assert.equal(new URL(calls[1]).searchParams.get('offset'), '100');
});

test('reads are retried on 5xx and 429, but not on 403', async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? json(n === 1 ? 502 : 429, {}, { 'retry-after': '1' }) : json(200, { id: 1 }));
  assert.equal((await client(flaky).getMe()).id, 1);
  assert.equal(n, 3);

  let m = 0;
  const denied = async () => {
    m += 1;
    return new Response('Permission Error', { status: 403 });
  };
  await assert.rejects(client(denied).getMe(), (e) => e.status === 403 && /Permission Error/.test(e.bodyExcerpt));
  assert.equal(m, 1);
});

const submit = (c, items = [{ questionId: 5, type: 'binary', forecast: { probability_yes: 0.3 } }], comments = ['why']) =>
  c.submitForecasts({ postId: 105, items, comments });

test('atomic post sends forecast and private comment together, once', async () => {
  const fake = new FakeMetaculus();
  const c = client(makeFetch({ metaculus: fake }));
  const result = await submit(c);
  assert.equal(result.outcome, 'posted');
  assert.equal(fake.writes.length, 1);
  const { path, body } = fake.writes[0];
  assert.equal(path, '/api/questions/bulk-forecast-comment/');
  assert.deepEqual(body.forecasts, [{ question: 5, source: 'api', probability_yes: 0.3 }]);
  assert.deepEqual(body.comments, [{ on_post: 105, text: 'why', is_private: true, included_forecast: true }]);
});

test('a group or conditional post goes in one request with every item and comment', async () => {
  const fake = new FakeMetaculus();
  const c = client(makeFetch({ metaculus: fake }));
  await submit(c, [
    { questionId: 11, type: 'binary', forecast: { probability_yes: 0.2 } },
    { questionId: 12, type: 'binary', forecast: { probability_yes: 0.6 } },
  ], ['first', 'second']);
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(fake.writes[0].body.forecasts.map((f) => f.question), [11, 12]);
  assert.deepEqual(fake.writes[0].body.comments.map((x) => x.text), ['first', 'second']);
});

test('writes are never retried blindly: 500 and timeouts are sent once and reported unknown', async () => {
  for (const failure of [() => json(500, {}), () => timeoutError()]) {
    let n = 0;
    const fetch = async () => {
      n += 1;
      const r = failure();
      if (r instanceof Error) throw r;
      return r;
    };
    const result = await submit(client(fetch));
    assert.equal(result.outcome, 'unknown');
    assert.equal(n, 1);
  }
});

test('write outcomes: 400/405 rejected, 403 forbidden, 429 retry, 401/404 setup error', async () => {
  const expected = { 400: 'rejected', 405: 'rejected', 403: 'forbidden', 429: 'retry', 401: 'setup_error', 404: 'setup_error', 502: 'unknown' };
  for (const [status, outcome] of Object.entries(expected)) {
    let n = 0;
    const result = await submit(client(async () => {
      n += 1;
      return json(Number(status), { detail: 'no' });
    }));
    assert.equal(result.outcome, outcome, `HTTP ${status}`);
    assert.equal(result.http, Number(status));
    assert.equal(n, 1, 'a write is sent once');
  }
  const refused = await submit(client(async () => { throw refusedError(); }));
  assert.equal(refused.outcome, 'retry', 'a request that never left saved nothing');
});

test('multiple choice: the largest option is 1 minus the others, in the question order', () => {
  const options = ['A', 'B', 'C'];
  const { probability_yes_per_category: v } = toMetaculusForecast('multiple_choice', { probabilities: { C: 0.3000004, A: 0.1, B: 0.6 } }, options);
  assert.deepEqual(Object.keys(v), options);
  assert.equal(v.B, 1 - (0.1 + 0.3000004));
  assert.equal(v.A, 0.1);
  assert.equal(v.C, 0.3000004);
});

test('multiple choice: a last option at the floor is never pushed below it by the rounding rest', () => {
  // Sums to 1 + 5e-7, inside the validator's tolerance. Putting the rest on
  // the last option would give it 0.0009995, below the 0.001 floor.
  const options = ['A', 'B', 'C'];
  const { probability_yes_per_category: v } = toMetaculusForecast('multiple_choice', { probabilities: { A: 0.6990005, B: 0.3, C: 0.001 } }, options);
  assert.equal(v.C, 0.001);
  assert.ok(Object.values(v).every((x) => x >= 0.001));
  assert.ok(Math.abs(v.A + v.B + v.C - 1) < 1e-12);
});

test('posts unpack into questions; groups inherit text; conditionals give both branches', () => {
  const single = questionsOfPost(postWith(questionFor('numeric', 3), 103));
  assert.equal(single.questions[0].question_id, 3);
  assert.equal(single.questions[0].post_id, 103);
  assert.equal(single.questions[0].post_kind, 'single');
  assert.equal(single.questions[0].scaling.open_lower_bound, true);
  assert.equal(single.questions[0].scaling.inbound_outcome_count, 200);

  const a = { ...questionFor('binary', 11), description: null, resolution_criteria: null, fine_print: null, label: 'A' };
  const group = questionsOfPost(groupPost(300, [a, questionFor('binary', 12)]));
  assert.deepEqual(group.questions.map((q) => q.question_id), [11, 12]);
  assert.equal(group.questions[0].description, 'Group background');
  assert.equal(group.questions[0].group_title, 'Group title');
  assert.equal(group.questions[0].label, 'A');
  assert.equal(group.questions[0].post_kind, 'group');

  const cond = questionsOfPost(conditionalPost(400));
  assert.deepEqual(cond.questions.map((q) => [q.question_id, q.conditional.branch]), [[3, 'yes'], [4, 'no']]);
  assert.ok(cond.questions.every((q) => q.post_kind === 'conditional' && q.post_id === 400));
  assert.equal(cond.questions[0].conditional.condition.title, 'Condition title');
  assert.equal(cond.questions[0].resolution_criteria, 'Child criteria', 'branch inherits the child question text');
  assert.deepEqual(questionsOfPost({ id: 401, conditional: { question_yes: { id: 3 } } }).skipped, [{ post_id: 401, reason: 'conditional_incomplete' }]);
});

test('an optional tournament that does not exist lists as empty; a required one fails', async () => {
  const fetch = async () => json(404, { detail: 'Not found.' });
  assert.deepEqual(await client(fetch).listOpenPosts({ tournament: 'minibench-2026-11-02', optional: true }), []);
  await assert.rejects(client(fetch).listOpenPosts({ tournament: 'minibench' }), (e) => e.status === 404);
});

test('open check honours status, the earliest deadline and the margin', () => {
  const [q] = questionsOfPost(postWith(questionFor('binary', 1, NOW + minutes(10)))).questions;
  assert.equal(isOpenAt(q, NOW), true);
  assert.equal(isOpenAt(q, NOW, minutes(11)), false);
  assert.equal(isOpenAt({ ...q, status: 'closed' }, NOW), false);

  const early = { ...questionFor('binary', 2, NOW + minutes(60)), spot_scoring_time: new Date(NOW + minutes(5)).toISOString() };
  const [e] = questionsOfPost(postWith(early)).questions;
  assert.equal(e.deadline, new Date(NOW + minutes(5)).toISOString(), 'spot scoring before close is the real deadline');
  assert.equal(isOpenAt(e, NOW, minutes(6)), false);

  const none = { ...questionFor('binary', 3), scheduled_close_time: null };
  const [n] = questionsOfPost({ ...postWith(none), scheduled_close_time: null }).questions;
  assert.equal(n.deadline, null);
  assert.equal(isOpenAt(n, NOW), false, 'no deadline is never treated as open');
});

test('forecast mapping per type', () => {
  assert.deepEqual(toMetaculusForecast('binary', { probability_yes: 0.2 }), { probability_yes: 0.2 });
  assert.deepEqual(toMetaculusForecast('date', { cdf: [0, 1] }), { continuous_cdf: [0, 1] });
  assert.throws(() => toMetaculusForecast('conditional', {}));
});
