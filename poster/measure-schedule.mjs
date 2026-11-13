// How often does the tick really run? Reads the public Actions runs API for
// tick.yml and prints the gaps between runs over the last 48 hours: median,
// 90th percentile and longest, for all runs and per trigger type
// (schedule, workflow_dispatch, ...). GET requests only.
//
//   node poster/measure-schedule.mjs --repo OWNER_GITHUB_USER/forecaster
//
// Exit code 1 when the median gap between runs (any trigger) is over
// 30 minutes, or when there are too few runs to judge. The tick calls
// measureSchedule() once a day and raises an alert when the clock is too slow.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { HttpError, excerpt, isSuccess, sendRequest } from '../lib/http.mjs';
import { assertRepoName } from './github.mjs';

const PER_PAGE = 100;
const MAX_PAGES = 10;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

// Gaps in minutes between consecutive times (ms), with their summary.
export function gapStats(timesMs) {
  const times = [...timesMs].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) gaps.push((times[i] - times[i - 1]) / 60000);
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    runs: times.length,
    gaps: gaps.length,
    median_minutes: round1(median(sorted)),
    p90_minutes: round1(percentile(sorted, 90)),
    max_minutes: round1(sorted.length ? sorted[sorted.length - 1] : null),
  };
}

const NO_WORK = new Set(['cancelled', 'skipped']);

// get(path) must return the parsed JSON of a GitHub API GET.
export async function measureSchedule({ get, repo, workflow = 'tick.yml', nowMs = Date.now(), hours = 48, maxMedianMinutes = 30, minRuns = 3 }) {
  assertRepoName(repo, 'repository');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) throw new Error('workflow must be a file name such as tick.yml');
  const since = new Date(nowMs - hours * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ created: `>=${since}`, per_page: String(PER_PAGE), page: String(page) });
    const data = await get(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
    const list = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    for (const r of list) {
      // A cancelled run (replaced by a newer tick while it waited) or a
      // skipped one did no work, so it does not count as a clock beat.
      if (NO_WORK.has(r?.conclusion)) continue;
      const at = Date.parse(r?.created_at);
      if (Number.isFinite(at) && at >= nowMs - hours * 3600000) runs.push({ at, event: String(r.event ?? 'unknown').replace(/[^a-z_]/g, '') || 'unknown' });
    }
    if (list.length < PER_PAGE) break;
  }
  const byEvent = {};
  for (const event of [...new Set(runs.map((r) => r.event))].sort()) {
    byEvent[event] = gapStats(runs.filter((r) => r.event === event).map((r) => r.at));
  }
  const all = gapStats(runs.map((r) => r.at));
  const enough = all.runs >= minRuns;
  const slow = enough && all.median_minutes > maxMedianMinutes;
  return {
    hours,
    all,
    by_event: byEvent,
    enough_runs: enough,
    slow,
    verdict: !enough ? 'not_enough_runs' : slow ? 'too_slow' : 'ok',
  };
}

export function formatReport(report, maxMedianMinutes = 30) {
  const line = (name, s) => `${name.padEnd(18)} runs ${String(s.runs).padStart(4)}  median ${s.median_minutes ?? '-'} min  p90 ${s.p90_minutes ?? '-'} min  longest ${s.max_minutes ?? '-'} min`;
  const out = [`Gaps between tick runs over the last ${report.hours} hours`, line('all triggers', report.all)];
  for (const [event, s] of Object.entries(report.by_event)) out.push(line(event, s));
  if (report.verdict === 'not_enough_runs') out.push('Verdict: not enough runs to judge the clock. Treat it as too slow.');
  else if (report.verdict === 'too_slow') out.push(`Verdict: TOO SLOW. The median gap is over ${maxMedianMinutes} minutes. Set up the clock in ops/CLOCK.md.`);
  else out.push(`Verdict: ok (median gap at most ${maxMedianMinutes} minutes).`);
  return out.join('\n');
}

const HELP = `measure-schedule: how often the tick really runs.

Usage:
  node poster/measure-schedule.mjs --repo OWNER/forecaster [--hours 48] [--workflow tick.yml]

Reads the public GitHub Actions runs list (GET only). If GITHUB_TOKEN is set it
is sent so the rate limit is higher; it is never printed.
Exit codes: 0 the clock is fine; 1 the median gap is over 30 minutes or there
are too few runs to judge; 2 the command was wrong or the API failed.`;

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? '' },
      hours: { type: 'string', default: '48' },
      workflow: { type: 'string', default: 'tick.yml' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const token = process.env.GITHUB_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'forecaster-measure' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = async (path) => {
    const r = await sendRequest({ fetch: globalThis.fetch, method: 'GET', url: `${config.github_api_url}${path}`, path, headers, timeoutMs: config.timeout_ms });
    if (!isSuccess(r.status)) throw new HttpError({ method: 'GET', path: path.split('?')[0], status: r.status, bodyExcerpt: excerpt(r.text) });
    return r.json;
  };
  const hours = Number(values.hours);
  if (!values.repo || !(hours > 0)) {
    console.error('give --repo OWNER/forecaster and a positive --hours');
    return 2;
  }
  const maxMedian = config.clock.max_median_gap_minutes;
  const report = await measureSchedule({ get, repo: values.repo, workflow: values.workflow, hours, maxMedianMinutes: maxMedian, minRuns: config.clock.min_runs });
  console.log(formatReport(report, maxMedian));
  return report.verdict === 'ok' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`measure-schedule failed: ${error instanceof HttpError ? `HTTP ${error.status}` : error?.message ?? error}`);
    process.exitCode = 2;
  });
}
