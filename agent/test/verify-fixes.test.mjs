// Fixes for the independent verifier's findings on method 1.3 (13 Nov 2026):
// the bounded series-guard search, passes counted by pass number, market
// tables that must come from option-market.mjs, and the re-run limit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EDGE_BINS, aggregate, loadPasses, widenToSeriesBand } from '../tools/aggregate.mjs';
import { buildOptionMarket } from '../tools/option-market.mjs';
import { writeForecast } from '../tools/write-forecast.mjs';
import { OPTION_TABLE_MARKER, isToolTable, optionTableHash } from '../tools/core/option-table.mjs';
import { quantileOf } from '../tools/core/quantile.mjs';
import { toValidatorQuestion } from '../tools/core/question.mjs';
import { locationOf, validateCdf } from '../../lib/cdf.mjs';
import { NOW, binaryPasses, itemFor, mcPasses, pctPasses, spreadAround, tempDataRepo, writeJsonFile } from './helpers.mjs';

const METHOD = JSON.parse(readFileSync(new URL('../method.json', import.meta.url), 'utf8'));
const C = METHOD.continuous;
const run = (item, passes, signals = {}, extra = {}) => aggregate({ item, passes, signals, method: METHOD, ...extra });
const scalingFor = (item) => toValidatorQuestion(item).scaling;
const bandOf = (cdf, item) => {
  const s = scalingFor(item);
  return { p10: quantileOf(cdf, 0.1, s), p50: quantileOf(cdf, 0.5, s), p90: quantileOf(cdf, 0.9, s) };
};
const withBand = (b) => ({ context: { series_band_width_10_90: b } });
const PRACTICE_DIR = fileURLToPath(new URL('../../../practice/round_2026-11-13/forecaster-data/', import.meta.url));
const hasPracticeEarly = () => existsSync(join(PRACTICE_DIR, 'runs', '900003', 'passes')) && existsSync(join(PRACTICE_DIR, 'runs', '900003', 'signals.json'));
const closedNumeric = () => itemFor('numeric', 2, { range: { range_min: 0, range_max: 100, zero_point: null, open_lower_bound: false, open_upper_bound: false, inbound_outcome_count: 200, cdf_points: 201 } });

// Every widened (or kept) forecast must hold to the same four promises.
function assertSafe(out, plain, item, label) {
  const s = scalingFor(item);
  const cdf = out.forecast.cdf;
  const last = cdf.length - 1;
  assert.deepEqual(validateCdf(cdf, s), [], `${label}: CDF validator`);
  if (s.open_lower_bound) assert.ok(cdf[0] - plain.forecast.cdf[0] <= C.series_band_max_outside_growth + 1e-12, `${label}: mass below ${cdf[0]}`);
  if (s.open_upper_bound) assert.ok((1 - cdf[last]) - (1 - plain.forecast.cdf[last]) <= C.series_band_max_outside_growth + 1e-12, `${label}: mass above ${1 - cdf[last]}`);
  const b = bandOf(cdf, item);
  assert.ok(b.p10 !== null && b.p90 !== null, `${label}: 10th and 90th percentiles inside the range`);
  const m0 = locationOf(bandOf(plain.forecast.cdf, item).p50, s);
  assert.ok(Math.abs(locationOf(b.p50, s) - m0) < 1 / last, `${label}: median moved less than one bin`);
}

// ---- 1. the bounded series-guard search -------------------------------------

test('method.json holds the series-guard limits: max factor 3, at most 0.05 extra mass outside per side', () => {
  assert.equal(METHOD.version, '1.3');
  assert.equal(C.series_band_max_factor, 3);
  assert.equal(C.series_band_max_outside_growth, 0.05);
});

const narrow = [spreadAround(50, 4), spreadAround(51, 4), spreadAround(49, 4)];

for (const [needed, expectCapped] of [[1.2, false], [2.5, false], [6, true]]) {
  test(`series guard, open bounds: needed factor about ${needed}`, () => {
    const item = itemFor('numeric');
    const plain = run(item, pctPasses(narrow));
    const w0 = plain.forecast && (bandOf(plain.forecast.cdf, item).p90 - bandOf(plain.forecast.cdf, item).p10);
    const series = (needed * w0) / C.series_band_min_share;
    const out = run(item, pctPasses(narrow), withBand(series));
    const b = bandOf(out.forecast.cdf, item);
    assertSafe(out, plain, item, `factor ${needed}`);
    assert.equal(out.checks.band_widened, true);
    if (expectCapped) {
      // The target is out of reach: a partial widening, flagged as such.
      assert.ok(out.flags.includes('band_widened_partly'), out.flags.join(','));
      assert.ok(!out.flags.includes('band_widened_to_series'), out.flags.join(','));
      assert.ok(out.flags.includes('band_widen_capped_by_max_factor'), out.flags.join(','));
      assert.match(out.comment_lines.passes, /widened partly from .* by a factor of 3 \(series guard: target 0\.85 x the series band .* not reached, stopped at the maximum factor 3\)/);
      assert.equal(out.checks.band_widen_factor, C.series_band_max_factor);
      assert.ok(b.p90 - b.p10 < needed * w0, 'not stretched past the maximum factor');
      assert.match(out.comment_lines.passes, /stopped at the maximum factor 3/);
    } else {
      assert.ok(out.flags.includes('band_widened_to_series'), out.flags.join(','));
      assert.ok(!out.flags.includes('band_widened_partly'), out.flags.join(','));
      assert.ok(!out.flags.some((f) => f.startsWith('band_widen_capped')), out.flags.join(','));
      assert.ok(Math.abs(b.p90 - b.p10 - C.series_band_min_share * series) < 0.05, `width ${b.p90 - b.p10}`);
      assert.ok(Math.abs(out.checks.band_widen_factor - needed) < 0.1, `factor ${out.checks.band_widen_factor}`);
    }
  });
}

test('series guard: the verifier case, factor 2 too narrow and factor 4 past the range, now bisects to the smallest factor', () => {
  const item = itemFor('numeric');
  const sets = [spreadAround(50, 10), spreadAround(50, 10), spreadAround(50, 10)];
  const plain = run(item, pctPasses(sets));
  const p = bandOf(plain.forecast.cdf, item);
  const w0 = p.p90 - p.p10;
  assert.ok(50 - 4 * (50 - p.p10) < 0, 'a factor of 4 would push the 10th percentile below the range');
  const series = (2.3 * w0) / C.series_band_min_share;
  const out = run(item, pctPasses(sets), withBand(series));
  const b = bandOf(out.forecast.cdf, item);
  assertSafe(out, plain, item, 'verifier case');
  assert.ok(Math.abs(b.p90 - b.p10 - C.series_band_min_share * series) < 0.1, `width ${b.p90 - b.p10}`);
  assert.ok(out.checks.band_widen_factor > 2 && out.checks.band_widen_factor < 2.6, String(out.checks.band_widen_factor));
  assert.ok(out.forecast.cdf[0] < 0.05, `mass below the range ${out.forecast.cdf[0]}`);
});

test('series guard, closed bounds: widens to the target and keeps cdf[0] = 0 and cdf[last] = 1', () => {
  const item = closedNumeric();
  const plain = run(item, pctPasses(narrow));
  const p = bandOf(plain.forecast.cdf, item);
  const series = (2.5 * (p.p90 - p.p10)) / C.series_band_min_share;
  const out = run(item, pctPasses(narrow), withBand(series));
  const b = bandOf(out.forecast.cdf, item);
  assertSafe(out, plain, item, 'closed');
  assert.equal(out.forecast.cdf[0], 0);
  assert.equal(out.forecast.cdf.at(-1), 1);
  assert.ok(Math.abs(b.p90 - b.p10 - C.series_band_min_share * series) < 0.05, `width ${b.p90 - b.p10}`);
});

test('series guard, log scale: needed 2.5 is reached in ratios; needed above 3 stops at the maximum factor', () => {
  const item = itemFor('numeric_log');
  const sets = [spreadAround(1000, 40), spreadAround(1010, 40), spreadAround(990, 40)];
  const plain = run(item, pctPasses(sets));
  const reach = run(item, pctPasses(sets), withBand(300));
  assertSafe(reach, plain, item, 'log 300');
  const b = bandOf(reach.forecast.cdf, item);
  assert.ok(b.p90 - b.p10 >= C.series_band_min_share * 300 - 1, `width ${b.p90 - b.p10}`);
  assert.ok(b.p90 - b.p50 > b.p50 - b.p10, 'wider above the median, as ratios are');

  const far = run(item, pctPasses(sets), withBand(400));
  assertSafe(far, plain, item, 'log 400');
  assert.ok(far.flags.includes('band_widen_capped_by_max_factor'), far.flags.join(','));
  assert.equal(far.checks.band_widen_factor, 3);
});

test('series guard: a series band wider than the whole question range never pushes the band past the range', () => {
  for (const item of [itemFor('numeric'), closedNumeric()]) {
    const plain = run(item, pctPasses(narrow));
    for (const series of [150, 1000]) {
      const out = run(item, pctPasses(narrow), withBand(series));
      assertSafe(out, plain, item, `band ${series}`);
      assert.ok(out.flags.includes('band_widen_capped_by_bounds') || out.flags.some((f) => f.startsWith('band_guard_skipped_')), out.flags.join(','));
    }
  }
});

test('series guard: if every factor above 1.01 puts too much mass outside an open bound, the unwidened forecast is kept and flagged', () => {
  const item = itemFor('numeric');
  // The passes sit near the open lower bound, so any stretch pushes mass below it.
  const sets = [spreadAround(15, 10), spreadAround(15, 10), spreadAround(15, 10)];
  const strict = { ...METHOD, continuous: { ...C, series_band_max_outside_growth: 0.001 } };
  const plain = aggregate({ item, passes: pctPasses(sets), signals: {}, method: strict });
  const out = aggregate({ item, passes: pctPasses(sets), signals: withBand(70), method: strict });
  assert.deepEqual(out.forecast.cdf, plain.forecast.cdf);
  assert.ok(out.flags.includes('band_guard_skipped_outside_mass_lower'), out.flags.join(','));
  assert.ok(!out.flags.includes('band_widened_to_series'));
  assert.ok(!out.flags.includes('band_widened_partly'));
  assert.equal(out.checks.band_guard_skipped, 'outside_mass_lower');
  assert.equal(out.checks.band_widened, false);
  assert.match(out.comment_lines.passes, /series guard skipped, band kept at .* \(more than 0\.001 extra probability below the range\)/);

  const direct = widenToSeriesBand(sets, scalingFor(item), 60, { maxFactor: 3, maxOutsideGrowth: 0.001 });
  assert.equal(direct.widened, false);
  assert.equal(direct.skipped, 'outside_mass_lower');
  assert.ok(direct.attempt.factor > 1);
});

// ---- 1b. closed bounds and the largest safe factor ---------------------------

// Mass in the 2 outermost bins of each side (the edge region of a closed bound).
const edgeMass = (cdf) => ({ lower: cdf[EDGE_BINS] - cdf[0], upper: cdf.at(-1) - cdf.at(-1 - EDGE_BINS) });

// The same promise for a closed bound: at most 0.05 extra mass in its edge region.
function assertEdgeSafe(out, plain, item, label) {
  const s = scalingFor(item);
  const a = edgeMass(out.forecast.cdf);
  const b = edgeMass(plain.forecast.cdf);
  if (!s.open_lower_bound) assert.ok(a.lower - b.lower <= C.series_band_max_outside_growth + 1e-12, `${label}: edge mass low +${a.lower - b.lower}`);
  if (!s.open_upper_bound) assert.ok(a.upper - b.upper <= C.series_band_max_outside_growth + 1e-12, `${label}: edge mass high +${a.upper - b.upper}`);
}

test('method: the edge region of a closed bound is the 2 outermost bins, in code and in method.md', () => {
  assert.equal(EDGE_BINS, 2);
  const text = readFileSync(new URL('../method.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /2 outermost bins of each closed bound/);
});

test('series guard, closed bounds: mass piling up at the bound is limited to 0.05 per side (the verifier case)', () => {
  // Passes close to the closed lower bound: the old guard put +0.18 in the edge bins.
  const item = closedNumeric();
  const sets = [spreadAround(20, 8), spreadAround(21, 8), spreadAround(19, 8)];
  const plain = run(item, pctPasses(sets));
  for (const series of [40, 60, 100, 300]) {
    const out = run(item, pctPasses(sets), withBand(series));
    assertSafe(out, plain, item, `closed ${series}`);
    assertEdgeSafe(out, plain, item, `closed ${series}`);
    assert.equal(out.forecast.cdf[0], 0);
    assert.equal(out.forecast.cdf.at(-1), 1);
    assert.equal(out.checks.band_mass_region_lower, 'edge');
    assert.ok(out.checks.band_mass_change_lower <= C.series_band_max_outside_growth + 1e-9, String(out.checks.band_mass_change_lower));
  }
  const capped = run(item, pctPasses(sets), withBand(100));
  assert.ok(capped.flags.includes('band_widened_partly'), capped.flags.join(','));
  assert.ok(capped.flags.includes('band_widen_capped_by_edge_mass_lower'), capped.flags.join(','));
  assert.equal(capped.checks.band_widen_capped_by, 'edge_mass_lower');
  assert.ok(Math.abs(capped.checks.band_mass_change_lower - C.series_band_max_outside_growth) < 0.002, `uses the limit: ${capped.checks.band_mass_change_lower}`);
  assert.match(capped.comment_lines.passes, /widened partly .* not reached, stopped before more than 0\.05 extra probability in the 2 bins at the closed lower bound\)/);
});

test('series guard: the factor used is the largest safe one, not all-or-nothing', () => {
  const item = itemFor('numeric');
  const sets = [spreadAround(50, 10), spreadAround(50, 10), spreadAround(50, 10)];
  const s = scalingFor(item);
  const r = widenToSeriesBand(sets, s, 60, { maxFactor: 3, maxOutsideGrowth: 0.001 });
  assert.equal(r.widened, true);
  assert.equal(r.reached, false);
  assert.equal(r.capped, 'outside_mass_lower');
  assert.ok(r.factor > 1.5 && r.factor < 3, String(r.factor));
  assert.ok(r.massChange.lower <= 0.001 && r.massChange.upper <= 0.001);
  assert.ok(r.after.width > r.before.width && r.after.width < 60);
  // A slightly larger factor is no longer safe.
  const over = widenToSeriesBand(sets, s, (r.after.width + 0.5), { maxFactor: r.factor * 1.01, maxOutsideGrowth: 0.001 });
  assert.equal(over.capped, 'outside_mass_lower');
  assert.ok(over.factor <= r.factor * 1.0001, `${over.factor} vs ${r.factor}`);
  // With the method's 0.05 the same case reaches the target.
  const full = widenToSeriesBand(sets, s, 60, { maxFactor: 3, maxOutsideGrowth: C.series_band_max_outside_growth });
  assert.equal(full.reached, true);
  assert.ok(full.after.width >= 60);
  assert.equal(full.factor, full.neededFactor);
});

test('series guard: the checks record the factor, widths and the mass change per side', () => {
  const item = itemFor('numeric');
  const out = run(item, pctPasses(narrow), withBand(30));
  for (const key of ['band_widen_factor', 'band_width_10_90_before_guard', 'band_width_10_90', 'band_widen_target_width', 'band_widen_needed_factor', 'band_mass_change_lower', 'band_mass_change_upper']) {
    assert.equal(typeof out.checks[key], 'number', key);
  }
  assert.equal(out.checks.band_widen_reached_target, true);
  assert.equal(out.checks.band_widen_capped_by, null);
  assert.equal(out.checks.band_mass_region_lower, 'outside');
  assert.equal(out.checks.band_mass_region_upper, 'outside');
});

test('series guard: an open side and a closed side are each held to their own limit', () => {
  for (const [lo, up] of [[true, false], [false, true]]) {
    const item = itemFor('numeric', 3, { range: { range_min: 0, range_max: 100, zero_point: null, open_lower_bound: lo, open_upper_bound: up, inbound_outcome_count: 200, cdf_points: 201 } });
    const sets = lo ? [spreadAround(80, 8), spreadAround(81, 8), spreadAround(79, 8)] : [spreadAround(20, 8), spreadAround(21, 8), spreadAround(19, 8)];
    const plain = run(item, pctPasses(sets));
    for (const series of [40, 80, 200]) {
      const out = run(item, pctPasses(sets), withBand(series));
      assertSafe(out, plain, item, `${lo}/${up} ${series}`);
      assertEdgeSafe(out, plain, item, `${lo}/${up} ${series}`);
    }
  }
});

test('practice round: Brent with its own series band still widens to about 71.4-115.5, median 92.52', { skip: !hasPracticeEarly() && 'practice round files not present' }, async () => {
  const item = JSON.parse(await readFile(join(PRACTICE_DIR, 'questions', '900003.json'), 'utf8'));
  const signals = JSON.parse(await readFile(join(PRACTICE_DIR, 'runs', '900003', 'signals.json'), 'utf8'));
  const passes = await loadPasses(join(PRACTICE_DIR, 'runs', '900003', 'passes'));
  const out = aggregate({ item, passes, signals, method: METHOD, allowFew: true });
  const b = bandOf(out.forecast.cdf, item);
  assert.ok(out.flags.includes('band_widened_to_series'), out.flags.join(','));
  assert.ok(Math.abs(b.p10 - 71.4) < 0.1 && Math.abs(b.p90 - 115.5) < 0.1, `${b.p10}-${b.p90}`);
  assert.ok(Math.abs(b.p50 - 92.52) < 0.01, String(b.p50));
});

test('series guard: a band given as a string or a non-positive number is ignored with a flag', () => {
  const item = itemFor('numeric');
  const plain = run(item, pctPasses(narrow));
  for (const bad of ['51.87', 0, -5, '']) {
    const out = run(item, pctPasses(narrow), withBand(bad));
    assert.deepEqual(out.forecast.cdf, plain.forecast.cdf, String(bad));
    assert.ok(out.flags.includes('series_band_invalid_ignored'), `${JSON.stringify(bad)}: ${out.flags}`);
    assert.ok(!out.flags.includes('band_widened_to_series'));
    assert.deepEqual(out.checks.series_band_width_10_90_ignored, bad);
  }
  assert.ok(!run(item, pctPasses(narrow), withBand(null)).flags.includes('series_band_invalid_ignored'), 'null means no band, no flag');
});

test('series guard: a widened forecast is accepted by write-forecast', async (t) => {
  const dir = await tempDataRepo(t);
  const item = itemFor('numeric', 63);
  await writeJsonFile(join(dir, 'questions', '63.json'), item);
  const agg = run(item, pctPasses([...narrow, spreadAround(50, 4), spreadAround(50, 4)]), withBand(30));
  assert.ok(agg.flags.includes('band_widened_to_series'));
  const comment = `${agg.comment_lines.forecast}\nQuestion as read: test.\n${agg.comment_lines.markets}\n${agg.comment_lines.passes}`;
  await writeForecast({ item, aggregate: agg, comment, dataDir: dir, method: METHOD, nowMs: NOW });
  const file = JSON.parse(await readFile(join(dir, 'forecasts', '63.json'), 'utf8'));
  assert.deepEqual(validateCdf(file.forecast.cdf, scalingFor(item)), []);
});

// The verifier's failing cases with the practice round's real passes: Brent
// (open bounds, 40-160) with series bands of 88 and more, Bitcoin (log scale)
// with 150k and more. Outputs go to FORECASTER_FIXCHECK_DIR if it is set.
const PRACTICE = fileURLToPath(new URL('../../../practice/round_2026-11-13/forecaster-data/', import.meta.url));
const hasPractice = existsSync(join(PRACTICE, 'runs', '900003', 'passes')) && existsSync(join(PRACTICE, 'runs', '900004', 'passes'));

test('practice round: Brent and Bitcoin with the verifier\'s wide series bands stay inside the range', { skip: !hasPractice && 'practice round files not present' }, async () => {
  const cases = [['900003', [51.869152, 60, 87, 88, 89, 90, 110, 120, 130, 150, 200]], ['900004', [27940.028, 60000, 150000, 200000, 400000]]];
  const report = [];
  for (const [id, bands] of cases) {
    const item = JSON.parse(await readFile(join(PRACTICE, 'questions', `${id}.json`), 'utf8'));
    const passes = await loadPasses(join(PRACTICE, 'runs', id, 'passes'));
    const plain = run(item, passes);
    for (const series of bands) {
      const out = run(item, passes, withBand(series));
      assertSafe(out, plain, item, `${id} band ${series}`);
      const b = bandOf(out.forecast.cdf, item);
      assert.ok(b.p90 - b.p10 <= C.series_band_min_share * series * 1.001 || out.checks.band_widened === false, `${id} ${series}: no overshoot`);
      report.push({ id, series, flags: out.flags, p10: b.p10, p50: b.p50, p90: b.p90, below: out.forecast.cdf[0], above: 1 - out.forecast.cdf.at(-1), factor: out.checks.band_widen_factor, skipped: out.checks.band_guard_skipped });
    }
  }
  const brent88 = report.find((r) => r.id === '900003' && r.series === 88);
  assert.ok(brent88.flags.includes('band_widened_to_series') && brent88.below < 0.05 && brent88.above < 0.05, JSON.stringify(brent88));
  const outDir = process.env.FORECASTER_FIXCHECK_DIR;
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'band-cases.json'), JSON.stringify(report, null, 2));
  }
});

// ---- 2. passes counted by pass number ---------------------------------------

const p = (file, value) => ({ file, data: { p: value } });

test('passes: pass-1.md and pass-1.json count once, with a flag, so a shortfall shows', () => {
  const out = run(itemFor('binary'), [p('pass-1.md', 0.3), p('pass-1.json', 0.9), p('pass-2.md', 0.3), p('pass-3.md', 0.35), p('pass-4.md', 0.3)]);
  assert.equal(out.checks.passes_valid, 4);
  assert.deepEqual(out.passes.map((x) => x.pass), [1, 2, 3, 4]);
  assert.equal(out.passes[0].value, 0.3, 'the .md file is the one counted');
  assert.ok(out.flags.includes('duplicate_pass_number'));
  assert.ok(out.flags.includes('fewer_passes_than_required'));
  assert.match(out.comment_lines.passes, /only 4 of 5 required passes valid \(missing or invalid: P5\)/);
  assert.match(out.comment_lines.passes, /several files for P1, each counted once\.$/);
  assert.ok(out.dropped_passes.some((d) => d.file === 'pass-1.json'));
});

test('passes: duplicates cannot lift a run over min_valid_passes', () => {
  assert.throws(() => run(itemFor('binary'), [p('pass-1.md', 0.3), p('pass-1.json', 0.3), p('pass-2.md', 0.3)]), { code: 'too_few_passes' });
});

test('passes: pass numbers outside 1..required are ignored with a flag', () => {
  const out = run(itemFor('binary'), [p('pass-1.md', 0.3), p('pass-2.md', 0.3), p('pass-3.md', 0.3), p('pass-6.md', 0.9), p('pass-7.md', 0.9), p('pass-0.md', 0.9)]);
  assert.equal(out.checks.passes_valid, 3);
  assert.equal(out.forecast.probability_yes, 0.3);
  assert.ok(out.flags.includes('pass_number_out_of_range'));
  assert.ok(out.flags.includes('fewer_passes_than_required'));
  assert.match(out.comment_lines.passes, /3 file\(s\) numbered outside P1-P5 ignored\.$/);

  const only = [6, 7, 8, 9, 10].map((k) => p(`pass-${k}.md`, 0.5));
  assert.throws(() => run(itemFor('binary'), only), { code: 'no_valid_passes' });

  const fast = run(itemFor('binary'), binaryPasses([0.2, 0.3, 0.25, 0.9, 0.9]), {}, { fastPath: true });
  assert.equal(fast.checks.passes_valid, 3);
  assert.equal(fast.forecast.probability_yes, 0.25);
  assert.ok(fast.flags.includes('pass_number_out_of_range'));
});

test('passes: the counting is the same when the files are read from a folder', async (t) => {
  const dir = await tempDataRepo(t);
  const write = (name, v) => writeFile(join(dir, name), `why\n\`\`\`json\n{"p": ${v}}\n\`\`\`\n`);
  await write('pass-1.md', 0.4);
  await writeFile(join(dir, 'pass-1.json'), '{"p": 0.4}');
  await write('pass-2.md', 0.4);
  await write('pass-3.md', 0.4);
  await write('pass-12.md', 0.4);
  const out = run(itemFor('binary'), await loadPasses(dir));
  assert.equal(out.checks.passes_valid, 3);
  assert.ok(out.flags.includes('duplicate_pass_number'));
  assert.ok(out.flags.includes('pass_number_out_of_range'));
});

// ---- 3. multiple-choice market tables ---------------------------------------

const mcItem = () => itemFor('multiple_choice', 71);
const sets = [{ Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }, { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 }];
const kalshi = (id, price, volume, spread = 0.02) => ({ venue: 'kalshi', id, title: `Event: ${id}`, url: 'https://kalshi.com/markets/x', price_yes: price, outcomes: null, volume_usd: volume, spread, close_time: null, real_money: true });
const marketsFile = (results) => ({ checked_at: '2026-11-16T09:50:00.000Z', results, errors: [] });
const allThree = { match: 'same', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-B' }, 'Gamma (Δ)': { venue: 'kalshi', id: 'K-G' } } };

test('option-market: the table carries the tool marker and a hash of the option names and prices', () => {
  const out = buildOptionMarket({ item: mcItem(), markets: marketsFile([kalshi('K-A', 0.6, 300000), kalshi('K-B', 0.3, 300000), kalshi('K-G', 0.1, 300000)]), map: allThree, method: METHOD });
  assert.equal(out.market.produced_by, OPTION_TABLE_MARKER);
  assert.equal(out.market.table_hash, optionTableHash(out.market.probabilities));
  assert.ok(isToolTable(out.market));
  assert.deepEqual(out.problem_codes, []);
  assert.equal(run(mcItem(), mcPasses(sets), { market: out.market }).checks.blend_weight, 0.5);
});

test('aggregate: a table typed by hand, or a tool table edited afterwards, is not blended and is flagged', () => {
  const out = buildOptionMarket({ item: mcItem(), markets: marketsFile([kalshi('K-A', 0.6, 300000), kalshi('K-B', 0.3, 300000), kalshi('K-G', 0.1, 300000)]), map: allThree, method: METHOD });
  const edited = { ...out.market, probabilities: { ...out.market.probabilities, Alpha: 0.65 } };
  const { produced_by: _a, table_hash: _b, ...handTyped } = out.market;
  for (const [label, market] of [['edited', edited], ['hand-typed', handTyped], ['wrong marker', { ...out.market, produced_by: 'me' }]]) {
    const agg = run(mcItem(), mcPasses(sets), { market });
    assert.equal(agg.checks.blend_weight, 0, label);
    assert.ok(agg.flags.includes('option_market_not_from_tool'), `${label}: ${agg.flags}`);
    assert.ok(!agg.flags.includes('option_market_blended'), label);
    assert.equal(agg.forecast.probabilities.Alpha, 0.5, label);
  }
});

test('option-market: refusal reasons reach the flags by name (partial, bad_sum, duplicate_market)', () => {
  const markets = marketsFile([kalshi('K-A', 0.5, 300000), kalshi('K-B', 0.3, 300000), kalshi('K-G', 0.6, 300000)]);
  const flagsFor = (map) => {
    const built = buildOptionMarket({ item: mcItem(), markets, map, method: METHOD });
    const agg = run(mcItem(), mcPasses(sets), { market: built.market });
    assert.equal(agg.checks.blend_weight, 0);
    return { codes: built.problem_codes, flags: agg.flags };
  };
  const partial = flagsFor({ match: 'same', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-B' }, 'Gamma (Δ)': null } });
  assert.deepEqual(partial.codes, ['partial']);
  assert.ok(partial.flags.includes('option_market_partial'));
  assert.ok(!partial.flags.includes('option_market_mapping_refused'));

  const badSum = flagsFor(allThree);
  assert.deepEqual(badSum.codes, ['bad_sum']);
  assert.ok(badSum.flags.includes('option_market_bad_sum'));

  // Alpha and Beta on one market; the prices of K-A twice plus K-B would even add up to 1.3 - the duplicate is caught directly.
  const dup = flagsFor({ match: 'same', options: { Alpha: { venue: 'kalshi', id: 'K-A' }, Beta: { venue: 'kalshi', id: 'K-A' }, 'Gamma (Δ)': { venue: 'kalshi', id: 'K-B' } } });
  assert.ok(dup.codes.includes('duplicate_market'), dup.codes.join(','));
  assert.ok(dup.flags.includes('option_market_duplicate_market'), dup.flags.join(','));
});

test('option-market: two outcomes of one multi-outcome market are not a duplicate; the same outcome twice is', () => {
  const poly = { venue: 'polymarket', id: 'P1', title: 'Which one?', url: 'https://polymarket.com/event/x', price_yes: null, outcomes: { A: 0.5, B: 0.3, G: 0.2 }, volume_usd: 300000, spread: 0.01, real_money: true };
  const ok = buildOptionMarket({ item: mcItem(), markets: marketsFile([poly]), map: { match: 'same', options: { Alpha: { venue: 'polymarket', id: 'P1', outcome: 'A' }, Beta: { venue: 'polymarket', id: 'P1', outcome: 'B' }, 'Gamma (Δ)': { venue: 'polymarket', id: 'P1', outcome: 'G' } } }, method: METHOD });
  assert.equal(ok.status, 'ok');
  const twice = buildOptionMarket({ item: mcItem(), markets: marketsFile([poly]), map: { match: 'same', options: { Alpha: { venue: 'polymarket', id: 'P1', outcome: 'A' }, Beta: { venue: 'polymarket', id: 'P1', outcome: 'A' }, 'Gamma (Δ)': { venue: 'polymarket', id: 'P1', outcome: 'G' } } }, method: METHOD });
  assert.ok(twice.problem_codes.includes('duplicate_market'));
});

test('option-market: a set of yes/no markets is weighted by its smallest market, so thin markets never add up to a deep one', () => {
  const deep = buildOptionMarket({ item: mcItem(), markets: marketsFile([kalshi('K-A', 0.6, 300000), kalshi('K-B', 0.3, 300000), kalshi('K-G', 0.1, 20000)]), map: allThree, method: METHOD });
  assert.equal(deep.market.volume_usd, 20000);
  assert.equal(deep.market.volume_rule, 'smallest market');
  assert.equal(run(mcItem(), mcPasses(sets), { market: deep.market }).checks.blend_weight, 0.15);

  const thin = buildOptionMarket({ item: mcItem(), markets: marketsFile([kalshi('K-A', 0.6, 90000), kalshi('K-B', 0.3, 90000), kalshi('K-G', 0.1, 90000)]), map: allThree, method: METHOD });
  assert.equal(thin.market.volume_usd, 90000, 'not 270000');
  assert.equal(run(mcItem(), mcPasses(sets), { market: thin.market }).checks.blend_weight, 0.3, 'not the deep-market weight');
});

// ---- 4. RUNBOOK: a pass runs at most twice ----------------------------------

test('RUNBOOK says a pass is run at most twice wherever the re-run is mentioned', () => {
  const text = readFileSync(new URL('../RUNBOOK.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const sentence = 'A pass is run at most twice in total: the first run and one re-run.';
  assert.ok(text.split(sentence).length - 1 >= 3, 'in step 4 and twice in step 5');
});
