// Shared test data: payload items in the exact shape poster/tick.mjs sends,
// pass outputs, and throw-away data-repo folders inside agent/test/.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NOW = Date.parse('2026-11-16T10:00:00Z');
export const minutes = (n) => n * 60000;
export const iso = (ms) => new Date(ms).toISOString();
export const TOOLS = fileURLToPath(new URL('../tools/', import.meta.url));

function item(id, type, extra = {}) {
  return {
    question_id: id,
    post_id: id + 100000,
    tournament: 'fall-futureeval-2026',
    type,
    title: `Test question ${id}`,
    label: null,
    group_title: null,
    description: 'Background text.',
    resolution_criteria: 'Resolves per the named source.',
    fine_print: 'Fine print.',
    options: null,
    unit: null,
    range: null,
    open_time: iso(NOW - minutes(30)),
    scheduled_close_time: iso(NOW + minutes(150)),
    attempt: 1,
    ...extra,
  };
}

const range = (min, max, { zero = null, openLower, openUpper, outcomes = 200 }) => ({
  range_min: min, range_max: max, zero_point: zero, open_lower_bound: openLower, open_upper_bound: openUpper,
  inbound_outcome_count: outcomes, cdf_points: outcomes + 1,
});

export function itemFor(type, id = 1, extra = {}) {
  switch (type) {
    case 'binary':
      return item(id, 'binary', extra);
    case 'multiple_choice':
      return item(id, 'multiple_choice', { options: ['Alpha', 'Beta', 'Gamma (Δ)'], ...extra });
    case 'numeric':
      return item(id, 'numeric', { unit: 'points', range: range(0, 100, { openLower: true, openUpper: true }), ...extra });
    case 'numeric_log':
      return item(id, 'numeric', { range: range(1, 10000, { zero: 0, openLower: false, openUpper: true }), ...extra });
    case 'discrete':
      return item(id, 'discrete', { range: range(-0.5, 9.5, { openLower: false, openUpper: false, outcomes: 10 }), ...extra });
    case 'date':
      return item(id, 'date', {
        range: range(Date.parse('2026-12-01T00:00:00Z') / 1000, Date.parse('2027-06-01T00:00:00Z') / 1000, { openLower: false, openUpper: true }),
        ...extra,
      });
    default:
      throw new Error(`no test item for ${type}`);
  }
}

export const binaryPasses = (values) => values.map((p, i) => ({ file: `pass-${i + 1}.json`, data: { pass: i + 1, p, reason: `reason ${i + 1}` } }));
export const mcPasses = (sets) => sets.map((probs, i) => ({ file: `pass-${i + 1}.json`, data: { pass: i + 1, probs, reason: `reason ${i + 1}` } }));
export const pctPasses = (sets) => sets.map((percentiles, i) => ({ file: `pass-${i + 1}.json`, data: { pass: i + 1, percentiles, reason: `reason ${i + 1}` } }));

// Thirteen percentiles of a symmetric distribution around `center`.
export function spreadAround(center, scale) {
  const z = { 1: -2.33, 2.5: -1.96, 5: -1.64, 10: -1.28, 20: -0.84, 40: -0.25, 50: 0, 60: 0.25, 80: 0.84, 90: 1.28, 95: 1.64, 97.5: 1.96, 99: 2.33 };
  return Object.fromEntries(Object.entries(z).map(([p, k]) => [p, center + k * scale]));
}

export async function tempDataRepo(t) {
  const dir = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-'));
  await Promise.all(['forecasts', 'questions', 'logs', 'runs'].map((d) => mkdir(join(dir, d), { recursive: true })));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const writeJsonFile = (path, value) => writeFile(path, JSON.stringify(value, null, 2));

// Runs one tool as a separate process and returns its exit code and output.
export function runTool(name, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(TOOLS, name), ...args], { timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

export function envelope(questions, sentAt = iso(NOW - minutes(2))) {
  return { kind: 'forecast_request', schema: 1, sent_at: sentAt, part: 1, parts: 1, questions };
}
