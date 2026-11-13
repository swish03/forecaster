#!/usr/bin/env node
// Percentiles plus the question's range fields in, a valid Metaculus CDF out.
// All the CDF rules live in lib/cdf.mjs (shared with the poster); this is the CLI.

import { buildCdf, validateCdf } from '../../lib/cdf.mjs';
import { DataError, readJson, required, runCli, writeJson } from './core/cli.mjs';
import { scalingOf } from './core/question.mjs';
import { quantileOf, toNumber } from './core/quantile.mjs';

const HELP = `make-cdf: turn percentiles into a valid CDF for one question.

Usage:
  node tools/make-cdf.mjs --question <questions/ID.json> --percentiles <file> [--out <file>]

--percentiles  { "percentiles": { "1": v, "5": v, ..., "50": v, ..., "99": v } }
               or a list of such objects (one per pass: their CDFs are combined
               by pointwise median). Date questions may use ISO dates as values.

Prints { points, cdf, median, p10, p90 }.
Exit 0 = done, 1 = the inputs cannot give a valid CDF, 2 = wrong command.`;

export function makeCdf(sets, scaling) {
  if (!Array.isArray(sets) || !sets.length) throw new DataError('no_percentiles');
  const numeric = sets.map((set, i) => {
    if (set === null || typeof set !== 'object' || Array.isArray(set)) throw new DataError('percentiles_invalid', `set ${i + 1} is not an object`);
    const entries = Object.entries(set).map(([k, v]) => [k, toNumber(v)]);
    const bad = entries.find(([k, v]) => !Number.isFinite(v) || !(Number(k) > 0 && Number(k) < 100));
    if (bad) throw new DataError('percentiles_invalid', `set ${i + 1}: percentile "${bad[0]}" must be between 0 and 100 with a number value`);
    if (new Set(entries.map(([k]) => Number(k))).size !== entries.length) {
      throw new DataError('percentiles_invalid', `set ${i + 1}: two keys name the same percentile`);
    }
    const ordered = [...entries].sort((a, b) => Number(a[0]) - Number(b[0]));
    if (ordered.some(([, v], j) => j > 0 && v < ordered[j - 1][1])) {
      throw new DataError('percentiles_invalid', `set ${i + 1}: values go down as the percentile goes up`);
    }
    return Object.fromEntries(entries);
  });
  let cdf;
  try {
    cdf = buildCdf(numeric, scaling);
  } catch (error) {
    throw new DataError('cdf_impossible', error.message);
  }
  const problems = validateCdf(cdf, scaling);
  if (problems.length) throw new DataError('cdf_invalid', problems.map((p) => p.code).join(', '));
  return { points: cdf.length, cdf, median: quantileOf(cdf, 0.5, scaling), p10: quantileOf(cdf, 0.1, scaling), p90: quantileOf(cdf, 0.9, scaling) };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: { question: { type: 'string' }, percentiles: { type: 'string' }, out: { type: 'string' } },
  async main(values) {
    required(values, 'question', 'percentiles');
    const scaling = scalingOf(await readJson(values.question, 'question file'));
    const input = await readJson(values.percentiles, 'percentiles file');
    const sets = (Array.isArray(input) ? input : [input]).map((x) => x?.percentiles ?? x);
    const result = makeCdf(sets, scaling);
    if (values.out) await writeJson(values.out, result);
    return result;
  },
});
