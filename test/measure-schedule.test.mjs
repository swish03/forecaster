import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { formatReport, gapStats, measureSchedule } from '../poster/measure-schedule.mjs';

const NOW = Date.parse('2026-11-16T10:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

// A fake GitHub runs API: newest first, paged, filtered by created>=.
function fakeGet(runs) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    const url = new URL(`https://x${path}`);
    const since = Date.parse(url.searchParams.get('created').replace(/^>=/, ''));
    const perPage = Number(url.searchParams.get('per_page'));
    const page = Number(url.searchParams.get('page'));
    const list = runs.filter((r) => Date.parse(r.created_at) >= since).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return { total_count: list.length, workflow_runs: list.slice((page - 1) * perPage, page * perPage) };
  };
  return { get, calls };
}

test('gap statistics: median, 90th percentile and longest', () => {
  const s = gapStats([0, 10, 20, 30, 100].map((m) => m * 60000));
  assert.deepEqual(s, { runs: 5, gaps: 4, median_minutes: 10, p90_minutes: 70, max_minutes: 70 });
  assert.deepEqual(gapStats([]), { runs: 0, gaps: 0, median_minutes: null, p90_minutes: null, max_minutes: null });
});

test('a healthy 15-minute clock: ok, with numbers per trigger type', async () => {
  const runs = [];
  for (let m = 0; m < 48 * 60; m += 15) runs.push({ event: m % 60 === 0 ? 'schedule' : 'workflow_dispatch', created_at: at(m) });
  runs.push({ event: 'push', created_at: at(50 * 60) });
  const { get, calls } = fakeGet(runs);
  const r = await measureSchedule({ get, repo: 'OWNER_GITHUB_USER/forecaster', nowMs: NOW });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.all.median_minutes, 15);
  assert.equal(r.by_event.schedule.median_minutes, 60);
  assert.equal(r.by_event.workflow_dispatch.runs, 144);
  assert.equal(r.by_event.push, undefined, 'runs older than 48 hours are left out');
  assert.equal(calls.length, 2, 'paged, 100 runs per page');
  assert.ok(calls.every((c) => c.startsWith('/repos/OWNER_GITHUB_USER/forecaster/actions/workflows/tick.yml/runs?')));
  assert.match(formatReport(r), /Verdict: ok/);
});

test('a throttled schedule (every 5 hours) is too slow', async () => {
  const runs = [];
  for (let m = 0; m < 48 * 60; m += 300) runs.push({ event: 'schedule', created_at: at(m) });
  const r = await measureSchedule({ get: fakeGet(runs).get, repo: 'o/forecaster', nowMs: NOW });
  assert.equal(r.verdict, 'too_slow');
  assert.equal(r.slow, true);
  assert.equal(r.all.max_minutes, 300);
  assert.match(formatReport(r), /TOO SLOW/);
});

test('cancelled and skipped runs did no work and do not count as clock beats', async () => {
  const runs = [];
  // Every 15 minutes a run is created, but three of every four were cancelled.
  for (let m = 0; m < 48 * 60; m += 15) runs.push({ event: 'workflow_dispatch', created_at: at(m), conclusion: m % 60 === 0 ? 'success' : 'cancelled' });
  runs.push({ event: 'schedule', created_at: at(7), conclusion: 'skipped' });
  const r = await measureSchedule({ get: fakeGet(runs).get, repo: 'o/forecaster', nowMs: NOW });
  assert.equal(r.all.median_minutes, 60);
  assert.equal(r.by_event.schedule, undefined);
  assert.equal(r.verdict, 'too_slow');
});

test('too few runs cannot be judged', async () => {
  const r = await measureSchedule({ get: fakeGet([{ event: 'schedule', created_at: at(5) }]).get, repo: 'o/forecaster', nowMs: NOW });
  assert.equal(r.verdict, 'not_enough_runs');
  assert.equal(r.slow, false);
});

test('bad repository or workflow names are refused before any request', async () => {
  const { get, calls } = fakeGet([]);
  await assert.rejects(measureSchedule({ get, repo: '../x', nowMs: NOW }));
  await assert.rejects(measureSchedule({ get, repo: 'o/r', workflow: '../../x', nowMs: NOW }));
  assert.equal(calls.length, 0);
});

test('--help prints the usage and exits 0 without any network call', () => {
  const script = fileURLToPath(new URL('../poster/measure-schedule.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /Exit codes/);
});

test('the tick has a --help too', () => {
  const script = fileURLToPath(new URL('../poster/tick.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--dry-run/);
  assert.match(r.stdout, /Exit codes: 0 all fine; 1 something needs attention; 2 setup problem/);
});
