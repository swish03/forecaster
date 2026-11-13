#!/usr/bin/env node
// Basic statistics for a numeric history (a price, a rate, a count), so a
// numeric forecast starts from the latest value and the size of past moves.
// Horizon quantiles come from the past moves of the same length
// (every overlapping window, no randomness), or from scaled one-step moves
// when the history is too short.

import { DataError, readJson, required, runCli, writeJson } from './core/cli.mjs';

const HELP = `series: statistics of a numeric history for a forecast horizon.

Usage:
  node tools/series.mjs --input <history.json> (--horizon-steps <k> | --horizon-days <d>) \\
       [--mode additive|relative] [--out <file>]

--input   [1.2, 1.3, ...]  or  [{ "date": "2026-01-02", "value": 1.2 }, ...]
          or { "values": <either list> }   (dated values are sorted by date)
--horizon-steps  how many observations ahead the question resolves
--horizon-days   the same in calendar days (needs dates): count the days from the
                 date of the LAST observation in the history to the date whose
                 value decides the question (not today, not the resolution
                 check date). Converted to steps with the average spacing.
--mode    additive (default: past differences) or relative (past ratios; prices, all values > 0)

Prints last value, min/max, changes, volatility and horizon quantiles
(1 ... 99, the percentiles the method asks for) plus typical move sizes.
horizon.flags has "few_windows_tails_unreliable" when the tails come from
fewer than 20 past moves: widen them in the passes.
Exit 0 = done, 1 = the history is not usable, 2 = wrong command.`;

const PERCENTILES = ['1', '2.5', '5', '10', '20', '40', '50', '60', '80', '90', '95', '97.5', '99'];
const MIN_WINDOWS = 8;
// With fewer windows than this, the 1-5% and 95-99% quantiles are just the
// extreme past moves; the agent should widen them.
const RELIABLE_TAIL_WINDOWS = 20;
const DAY_MS = 86400000;

// Linear interpolation between order statistics (the common "type 7" quantile).
export function quantile(sortedValues, p) {
  if (!sortedValues.length) throw new Error('quantile of an empty list');
  const pos = (sortedValues.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

const sortAsc = (values) => [...values].sort((a, b) => a - b);
const round = (v) => (Number.isFinite(v) ? Number(v.toPrecision(8)) : null);

function sd(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

export function normalizeHistory(input) {
  const list = Array.isArray(input) ? input : input?.values;
  if (!Array.isArray(list) || list.length < 4) throw new DataError('history_too_short', 'need at least 4 observations');
  const dated = list.every((x) => x !== null && typeof x === 'object');
  const points = list.map((x, i) => {
    const value = dated ? x.value : x;
    const time = dated ? Date.parse(x.date) : null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new DataError('history_value_invalid', `observation ${i + 1}`);
    if (dated && !Number.isFinite(time)) throw new DataError('history_date_invalid', `observation ${i + 1}`);
    return { value, time };
  });
  if (dated) points.sort((a, b) => a.time - b.time);
  return { points, dated };
}

// Average calendar days per observation: (last date - first date) / (count - 1).
// Not the median gap: a business-day series (prices, FRED daily data) has a
// median gap of 1 day but about 1.45 calendar days per observation, so the
// median would make a horizon in days 45% too many steps long.
function stepDays(points) {
  return (points[points.length - 1].time - points[0].time) / DAY_MS / (points.length - 1);
}

function horizonStats(values, steps, mode) {
  const last = values[values.length - 1];
  const relative = mode === 'relative';
  const move = (from, to) => (relative ? Math.log(to / from) : to - from);
  const project = (m) => (relative ? last * Math.exp(m) : last + m);

  let moves = [];
  for (let i = 0; i + steps < values.length; i += 1) moves.push(move(values[i], values[i + steps]));
  let method = 'empirical';
  if (moves.length < MIN_WINDOWS) {
    const oneStep = values.slice(1).map((v, i) => move(values[i], v));
    if (oneStep.length < 3) throw new DataError('history_too_short', 'not enough past moves for this horizon');
    // The drift grows with the horizon (k steps), the noise with its square root.
    const drift = oneStep.reduce((a, b) => a + b, 0) / oneStep.length;
    moves = oneStep.map((m) => drift * steps + (m - drift) * Math.sqrt(steps));
    method = 'sqrt_scaled_one_step';
  }
  const flags = moves.length < RELIABLE_TAIL_WINDOWS ? ['few_windows_tails_unreliable'] : [];
  const sorted = sortAsc(moves);
  const absolute = sortAsc(moves.map((m) => Math.abs(project(m) - last)));
  const quantiles = Object.fromEntries(PERCENTILES.map((p) => [p, round(project(quantile(sorted, Number(p) / 100)))]));
  return {
    steps,
    method,
    windows: moves.length,
    typical_abs_move_median: round(quantile(absolute, 0.5)),
    typical_abs_move_p90: round(quantile(absolute, 0.9)),
    quantiles,
    band_width_10_90: round(quantiles['90'] - quantiles['10']),
    flags,
  };
}

export function seriesStats(input, { horizonSteps, horizonDays, mode = 'additive' }) {
  if (!['additive', 'relative'].includes(mode)) throw new DataError('mode_invalid', 'use additive or relative');
  const { points, dated } = normalizeHistory(input);
  const values = points.map((p) => p.value);
  if (mode === 'relative' && values.some((v) => v <= 0)) throw new DataError('relative_needs_positive_values');

  let steps = horizonSteps;
  let spacing = null;
  if (horizonDays !== undefined) {
    if (!dated) throw new DataError('horizon_days_needs_dates');
    spacing = stepDays(points);
    if (!(spacing > 0)) throw new DataError('history_dates_not_spaced');
    steps = Math.max(1, Math.round(horizonDays / spacing));
  }
  if (!Number.isInteger(steps) || steps < 1) throw new DataError('horizon_invalid', 'horizon must be at least one step');

  const n = values.length;
  const last = values[n - 1];
  const changes = {};
  for (const k of [...new Set([1, 5, 20, steps])].filter((k) => k < n).sort((a, b) => a - b)) {
    const before = values[n - 1 - k];
    changes[k] = { abs: round(last - before), pct: before !== 0 ? round(((last - before) / Math.abs(before)) * 100) : null };
  }
  const stepMoves = values.slice(1).map((v, i) => v - values[i]);
  const logReturns = values.every((v) => v > 0) ? values.slice(1).map((v, i) => Math.log(v / values[i])) : null;

  const result = {
    count: n,
    last_value: last,
    min: Math.min(...values),
    max: Math.max(...values),
    changes,
    volatility: { step_change_sd: round(sd(stepMoves)), step_log_return_sd: logReturns ? round(sd(logReturns)) : null },
    horizon: horizonStats(values, steps, mode),
  };
  if (dated) {
    const lastTime = points[n - 1].time;
    const year = points.filter((p) => p.time >= lastTime - 365 * DAY_MS).map((p) => p.value);
    Object.assign(result, {
      first_date: new Date(points[0].time).toISOString().slice(0, 10),
      last_date: new Date(lastTime).toISOString().slice(0, 10),
      step_days: round(spacing ?? stepDays(points)),
      min_365d: Math.min(...year),
      max_365d: Math.max(...year),
    });
  }
  return result;
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: {
    input: { type: 'string' }, 'horizon-steps': { type: 'string' }, 'horizon-days': { type: 'string' },
    mode: { type: 'string', default: 'additive' }, out: { type: 'string' },
  },
  async main(values) {
    required(values, 'input');
    const hasSteps = values['horizon-steps'] !== undefined;
    const hasDays = values['horizon-days'] !== undefined;
    if (hasSteps === hasDays) throw new DataError('horizon_invalid', 'give exactly one of --horizon-steps or --horizon-days');
    const result = seriesStats(await readJson(values.input, 'history file'), {
      horizonSteps: hasSteps ? Number(values['horizon-steps']) : undefined,
      horizonDays: hasDays ? Number(values['horizon-days']) : undefined,
      mode: values.mode,
    });
    if (values.out) await writeJson(values.out, result);
    return result;
  },
});
