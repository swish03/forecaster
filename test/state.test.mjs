import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitHubClient } from '../poster/github.mjs';
import { createStateStore } from '../poster/state.mjs';
import { FakeGitHub, TOKENS, makeFetch } from './helpers/fakes.mjs';

const REPO = 'OWNER_GITHUB_USER/forecaster';

function setup() {
  const github = new FakeGitHub();
  github.addRepo(REPO, { readToken: null, writeToken: TOKENS.workflow });
  const client = createGitHubClient({ token: TOKENS.workflow, label: 'GITHUB_TOKEN', fetch: makeFetch({ github }), sleep: async () => {} });
  return { github, store: () => createStateStore({ github: client, repo: REPO }) };
}

test('a missing state branch reads as empty and is created on first write', async () => {
  const { github, store } = setup();
  const s = store();
  const first = await s.load();
  assert.deepEqual(first, { fired: {}, posted: {}, ops: {}, head: null });
  await s.update((st) => {
    st.fired[11] = { first_fired_at: 't', last_fired_at: 't', count: 1, closes_at: null };
    return st;
  }, 'test');
  assert.deepEqual(JSON.parse(github.readFile(REPO, 'state', 'fired.json')), { 11: { first_fired_at: 't', last_fired_at: 't', count: 1, closes_at: null } });
  assert.deepEqual(JSON.parse(github.readFile(REPO, 'state', 'posted.json')), {});
  assert.deepEqual(JSON.parse(github.readFile(REPO, 'state', 'ops.json')), {});
  const repo = github.repos.get(REPO);
  assert.deepEqual(repo.commits[repo.refs.state].parents, [], 'the state branch is an orphan, without main\'s files');
});

test('an unchanged update makes no commit', async () => {
  const { github, store } = setup();
  const s = store();
  await s.load();
  await s.update((st) => st, 'noop');
  assert.equal(github.repos.get(REPO).refs.state, undefined);
});

test('optimistic concurrency: a write that lost the race is re-applied on the new head', async () => {
  const { github, store } = setup();
  github.commitFiles(REPO, 'state', { 'fired.json': '{}\n', 'posted.json': '{}\n' });
  const s = store();
  await s.load();
  let raced = false;
  github.beforeRefMove = () => {
    if (raced) return;
    raced = true;
    github.commitFiles(REPO, 'state', { 'posted.json': JSON.stringify({ 99: { status: 'posted', at: 'other' } }) });
  };
  let runs = 0;
  await s.update((st) => {
    runs += 1;
    st.posted[5] = { status: 'in_flight', at: 'mine' };
    return st;
  }, 'test');
  assert.equal(runs, 2, 'the change was applied again after the conflict');
  const posted = JSON.parse(github.readFile(REPO, 'state', 'posted.json'));
  assert.deepEqual(Object.keys(posted).sort(), ['5', '99'], 'neither write is lost');
});

test('two stores racing to create the branch both land', async () => {
  const { github, store } = setup();
  const a = store();
  const b = store();
  await a.load();
  await b.load();
  await a.update((st) => ({ ...st, fired: { 1: { count: 1 } } }), 'a');
  await b.update((st) => ({ ...st, fired: { ...st.fired, 2: { count: 1 } } }), 'b');
  assert.deepEqual(Object.keys(JSON.parse(github.readFile(REPO, 'state', 'fired.json'))).sort(), ['1', '2']);
});

test('gives up after repeated conflicts instead of overwriting', async () => {
  const { github, store } = setup();
  github.commitFiles(REPO, 'state', { 'fired.json': '{}', 'posted.json': '{}' });
  const s = store();
  await s.load();
  let n = 0;
  github.beforeRefMove = () => github.commitFiles(REPO, 'state', { 'posted.json': JSON.stringify({ [++n]: { status: 'x' } }) });
  await assert.rejects(s.update((st) => ({ ...st, fired: { 7: { count: 1 } } }), 'test'), /gave up/);
});

test('a corrupt state file stops the tick rather than being overwritten', async () => {
  const { github, store } = setup();
  github.commitFiles(REPO, 'state', { 'fired.json': 'not json', 'posted.json': '{}' });
  await assert.rejects(store().load(), /fired.json is not valid JSON/);
  github.commitFiles(REPO, 'state', { 'fired.json': '{"abc": 1}' });
  await assert.rejects(store().load(), /unexpected shape/);
  github.commitFiles(REPO, 'state', { 'fired.json': '{}', 'ops.json': '[1, 2]' });
  await assert.rejects(store().load(), /ops.json has an unexpected shape/);
});

test('ops.json holds free-form housekeeping and older state branches without it still load', async () => {
  const { github, store } = setup();
  github.commitFiles(REPO, 'state', { 'fired.json': '{}', 'posted.json': '{}' });
  const s = store();
  assert.deepEqual((await s.load()).ops, {});
  await s.update((st) => {
    st.ops.fires = { day: '2026-11-16', count: 2 };
    return st;
  }, 'test');
  assert.deepEqual(JSON.parse(github.readFile(REPO, 'state', 'ops.json')), { fires: { day: '2026-11-16', count: 2 } });
  assert.deepEqual((await store().load()).ops.fires, { day: '2026-11-16', count: 2 });
});
