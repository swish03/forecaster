// The outside clock (Apps Script) and the workflow files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function runClock(props, { code = 204, body = '{}' } = {}) {
  const fetches = [];
  const logs = [];
  const triggers = [];
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    UrlFetchApp: { fetch: (url, opts) => { fetches.push({ url, opts }); return { getResponseCode: () => code, getContentText: () => body }; } },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: (fn) => ({
        timeBased: () => ({
          everyMinutes: (n) => ({ create: () => triggers.push({ fn, minutes: n }) }),
          everyHours: (n) => ({ create: () => triggers.push({ fn, hours: n }) }),
        }),
      }),
    },
    console: { log: (m) => logs.push(String(m)) },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('ops/clock/apps_script_clock.gs'), sandbox);
  return { sandbox, fetches, logs, triggers };
}

test('the Apps Script clock dispatches tick.yml on main with profile live and logs only the status', () => {
  const value = 'plumbing-test-value';
  const { sandbox, fetches, logs } = runClock({ TICK_DISPATCH_TOKEN: value, FORECASTER_REPO: 'OWNER_GITHUB_USER/forecaster' });
  sandbox.startTick();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, 'https://api.github.com/repos/OWNER_GITHUB_USER/forecaster/actions/workflows/tick.yml/dispatches');
  assert.equal(fetches[0].opts.method, 'post');
  assert.equal(fetches[0].opts.headers.Authorization, `Bearer ${value}`);
  assert.deepEqual(JSON.parse(fetches[0].opts.payload), { ref: 'main', inputs: { profile: 'live' } });
  assert.deepEqual(logs, ['tick dispatch: HTTP 204']);
  assert.ok(!logs.join('').includes(value));
});

test('the Apps Script clock never holds a token in its source and stops when setup is missing', () => {
  const src = read('ops/clock/apps_script_clock.gs');
  assert.ok(!/(ghp_|github_pat_|sk-ant-)/.test(src));
  const { sandbox, fetches, logs } = runClock({});
  assert.throws(() => sandbox.startTick(), /setup missing/, 'a throw makes Google email the owner');
  assert.equal(fetches.length, 0);
  assert.match(logs[0], /setup missing/);
  const bad = runClock({ TICK_DISPATCH_TOKEN: 'x', FORECASTER_REPO: 'evil.com/x/../y' });
  assert.throws(() => bad.sandbox.startTick());
  assert.equal(bad.fetches.length, 0);
});

test('installClock makes the 15-minute dispatch trigger and the hourly check trigger', () => {
  const { sandbox, triggers } = runClock({});
  sandbox.installClock();
  assert.deepEqual(triggers, [{ fn: 'startTick', minutes: 15 }, { fn: 'checkTicks', hours: 1 }]);
});

test('a refused dispatch throws, so Google emails the owner (401, 403, 422 ...)', () => {
  for (const code of [401, 403, 404, 422, 500]) {
    const { sandbox, logs } = runClock({ TICK_DISPATCH_TOKEN: 'v', FORECASTER_REPO: 'o/forecaster' }, { code });
    assert.throws(() => sandbox.startTick(), new RegExp(`HTTP ${code}`));
    assert.deepEqual(logs, [`tick dispatch: HTTP ${code}`]);
  }
});

test('checkTicks throws when no tick finished well for more than 2 hours, and is quiet otherwise', () => {
  const props = { TICK_DISPATCH_TOKEN: 'v', FORECASTER_REPO: 'o/forecaster' };
  const recent = JSON.stringify({ workflow_runs: [{ created_at: new Date(Date.now() - 30 * 60000).toISOString(), updated_at: new Date(Date.now() - 25 * 60000).toISOString() }] });
  const ok = runClock(props, { code: 200, body: recent });
  ok.sandbox.checkTicks();
  assert.match(ok.fetches[0].url, /\/actions\/workflows\/tick\.yml\/runs\?status=success&per_page=1$/);
  const old = JSON.stringify({ workflow_runs: [{ created_at: new Date(Date.now() - 3 * 3600000).toISOString() }] });
  assert.throws(() => runClock(props, { code: 200, body: old }).sandbox.checkTicks(), /no good tick/);
  assert.throws(() => runClock(props, { code: 200, body: '{"workflow_runs": []}' }).sandbox.checkTicks(), /no good tick/);
  assert.throws(() => runClock(props, { code: 401 }).sandbox.checkTicks(), /HTTP 401/);
});

test('tick.yml: the schedule is a 20-minute backup, and the token gets only the permissions it needs', () => {
  const yml = read('.github/workflows/tick.yml');
  assert.match(yml, /cron: "4,24,44 \* \* \* \*"/);
  assert.match(yml, /ONLY an opportunistic backup/);
  const perms = yml.match(/^permissions:\n((?:  .+\n)+)/m)[1].trim().split('\n').map((l) => l.trim());
  assert.deepEqual(perms, ['contents: write', 'issues: write', 'actions: write']);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /environment: metaculus/);
});

test('every action in every workflow is pinned to a full commit SHA', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const uses = readdirSync(dir).flatMap((f) => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]));
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});

test('ci.yml checks that the agent kit manifest is up to date', () => {
  assert.match(read('.github/workflows/ci.yml'), /make-manifest\.mjs --check/);
});
