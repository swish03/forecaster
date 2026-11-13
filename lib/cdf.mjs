// Continuous forecasts (numeric, discrete, date) as Metaculus wants them:
// a CDF evaluated at N + 1 evenly spaced grid points of the question's range.
// Rules: research/specs/metaculus_bot_spec.md 3.5 and metaculus_method.md 3.6.

export const CONTINUOUS_TYPES = new Set(['numeric', 'discrete', 'date']);

const DEFAULT_OUTCOME_COUNT = 200;
const SERVER_MAX_STEP = 0.59;
const OPEN_LOWER_MIN = 0.001;
const OPEN_UPPER_MAX = 0.999;
const CAP_SAFETY = 0.95;
const DECIMALS = 10;
// Rounding to 10 decimals can move a step by up to 1e-10; only the maximum
// step gets this slack. The minimum step is checked strictly, because the
// server's own comparison is not documented.
const ROUNDING_TOLERANCE = 1e-9;
// The template mixes in 1% uniform mass, which makes the smallest steps equal
// 0.01/N exactly and lets float error push them a hair below it. 1.01% keeps
// every step strictly above the minimum.
const UNIFORM_MASS = 0.0101;
// A log scale whose ratio is this close to 1 is treated as linear.
const LOG_RATIO_EPSILON = 1e-9;

export function cdfRules(scaling) {
  const n = scaling.inbound_outcome_count ?? DEFAULT_OUTCOME_COUNT;
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(`inbound_outcome_count must be an integer of at least 2, got ${n}`);
  }
  return {
    intervals: n,
    points: n + 1,
    openLower: scaling.open_lower_bound === true,
    openUpper: scaling.open_upper_bound === true,
    minStep: 0.01 / n,
    maxStep: Math.min(SERVER_MAX_STEP, (0.2 * 200) / n),
  };
}

// Returns a list of { code, detail } problems; an empty list means valid.
export function validateCdf(cdf, scaling) {
  const rules = cdfRules(scaling);
  if (!Array.isArray(cdf)) return [{ code: 'cdf_not_array', detail: '' }];
  if (cdf.length !== rules.points) {
    return [{ code: 'cdf_length', detail: `expected ${rules.points} points, got ${cdf.length}` }];
  }
  const bad = cdf.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1);
  if (bad !== -1) return [{ code: 'cdf_value_range', detail: `point ${bad} is not a number in [0, 1]` }];

  const problems = [];
  const first = cdf[0];
  const last = cdf[cdf.length - 1];
  if (rules.openLower ? first < OPEN_LOWER_MIN : first !== 0) {
    problems.push({ code: 'cdf_lower_bound', detail: rules.openLower ? 'open lower bound needs cdf[0] >= 0.001' : 'closed lower bound needs cdf[0] = 0' });
  }
  if (rules.openUpper ? last > OPEN_UPPER_MAX : last !== 1) {
    problems.push({ code: 'cdf_upper_bound', detail: rules.openUpper ? 'open upper bound needs cdf[last] <= 0.999' : 'closed upper bound needs cdf[last] = 1' });
  }
  for (let i = 1; i < cdf.length; i += 1) {
    const step = cdf[i] - cdf[i - 1];
    if (step < rules.minStep) {
      problems.push({ code: 'cdf_step_too_small', detail: `step ${i} is ${step}, minimum ${rules.minStep}` });
      break;
    }
    if (step > rules.maxStep + ROUNDING_TOLERANCE) {
      problems.push({ code: 'cdf_step_too_large', detail: `step ${i} is ${step}, maximum ${rules.maxStep}` });
      break;
    }
  }
  return problems;
}

// The log-scale ratio r = (max - zero) / (min - zero), or null for a linear scale.
function logRatio({ range_min: lo, range_max: hi, zero_point: zero }) {
  if (zero === null || zero === undefined) return null;
  const ratio = (hi - zero) / (lo - zero);
  return Math.abs(ratio - 1) < LOG_RATIO_EPSILON ? null : ratio;
}

// A zero point must lie outside the range, or the log axis is undefined.
export function zeroPointProblem(scaling) {
  const { range_min: lo, range_max: hi, zero_point: zero } = scaling;
  if (zero === null || zero === undefined) return null;
  if (typeof zero !== 'number' || !Number.isFinite(zero)) return 'zero point is not a number';
  if (zero >= lo && zero <= hi) return 'zero point lies inside the range';
  return null;
}

// Position of a real-world value on the question's internal [0, 1] axis.
export function locationOf(value, scaling) {
  const { range_min: lo, range_max: hi } = scaling;
  const ratio = logRatio(scaling);
  if (ratio === null) return (value - lo) / (hi - lo);
  const inner = ((value - lo) * (ratio - 1) + (hi - lo)) / (hi - lo);
  return inner > 0 ? Math.log(inner) / Math.log(ratio) : Number.NaN;
}

// Real-world value at a position of the internal axis (inverse of locationOf).
export function valueAt(location, scaling) {
  const { range_min: lo, range_max: hi } = scaling;
  const ratio = logRatio(scaling);
  if (ratio === null) return lo + (hi - lo) * location;
  return lo + ((hi - lo) * (ratio ** location - 1)) / (ratio - 1);
}

// Date questions may give percentile values as ISO strings; the range is in Unix seconds.
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return Number.NaN;
}

const TIE_STEP = 1e-9;

// Percentile values -> sorted points { x, p } on the internal axis.
// A value at or beyond a closed bound means "mass on the bound": it is placed
// just inside the bound (within the first or last bin, and never past a
// declared value that is already inside), so the mass lands in cdf[1] or in
// the last bin, as the spec says. This works in axis units, so it is the
// same on log and linear scales.
function sanitizePercentiles(percentiles, scaling, rules) {
  const { range_min: lo, range_max: hi } = scaling;
  const entries = Object.entries(percentiles ?? {})
    .map(([key, value]) => ({ p: Number(key) / 100, v: toNumber(value) }))
    .filter(({ p, v }) => p > 0 && p < 1 && Number.isFinite(v))
    .sort((a, b) => a.p - b.p)
    .map(({ p, v }) => {
      if (!rules.openLower && v <= lo) return { p, x: null, at: 'lower' };
      if (!rules.openUpper && v >= hi) return { p, x: null, at: 'upper' };
      return { p, x: locationOf(v, scaling), at: null };
    })
    .filter(({ x, at }) => at !== null || Number.isFinite(x));
  if (entries.length < 2) throw new Error('need at least 2 usable percentiles inside the scale');

  const inside = entries.filter((e) => e.at === null).map((e) => e.x);
  const halfBin = 0.5 / rules.intervals;
  const firstInside = inside.length ? Math.min(...inside) : 1;
  const lastInside = inside.length ? Math.max(...inside) : 0;
  const lowerX = Math.min(halfBin, Math.max(firstInside, 0) / 2);
  const upperX = 1 - Math.min(halfBin, Math.max(1 - lastInside, 0) / 2);
  const atLower = entries.filter((e) => e.at === 'lower');
  const atUpper = entries.filter((e) => e.at === 'upper');
  atLower.forEach((e, i) => { e.x = lowerX + i * TIE_STEP; });
  atUpper.forEach((e, i) => { e.x = upperX - (atUpper.length - 1 - i) * TIE_STEP; });

  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].x <= entries[i - 1].x) entries[i].x = entries[i - 1].x + TIE_STEP;
  }
  return entries.map(({ x, p }) => ({ x, p }));
}

function extend(a, b, x) {
  return a.p + ((b.p - a.p) * (x - a.x)) / (b.x - a.x);
}

function interpolate(points, x) {
  const n = points.length;
  if (x <= points[0].x) return extend(points[0], points[1], x);
  if (x >= points[n - 1].x) return extend(points[n - 2], points[n - 1], x);
  let i = 1;
  while (points[i].x < x) i += 1;
  return extend(points[i - 1], points[i], x);
}

function runningMax(values) {
  let max = -Infinity;
  return values.map((v) => (max = Math.max(max, v)));
}

// One pass's percentiles -> an unstandardised CDF on the grid (method 3.6 steps 1-3).
export function cdfFromPercentiles(percentiles, scaling) {
  const rules = cdfRules(scaling);
  const points = sanitizePercentiles(percentiles, scaling, rules);
  if (!rules.openLower) points.unshift({ x: 0, p: 0 });
  if (!rules.openUpper) points.push({ x: 1, p: 1 });
  const grid = Array.from({ length: rules.points }, (_, i) => i / rules.intervals);
  const raw = grid.map((x) => Math.min(1, Math.max(0, interpolate(points, x))));
  return runningMax(raw);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pointwise median of several CDFs on the same grid (method 3.6 step 4).
export function medianCdf(cdfs) {
  if (!Array.isArray(cdfs) || cdfs.length === 0) throw new Error('need at least one CDF');
  const length = cdfs[0].length;
  if (cdfs.some((c) => c.length !== length)) throw new Error('all CDFs must have the same length');
  return runningMax(Array.from({ length }, (_, i) => median(cdfs.map((c) => c[i]))));
}

// Moves mass above the per-bin cap to the nearest bins that have room,
// shared evenly between the left and right neighbour at each distance.
// Returns the new CDF and whether any mass had to move.
function capBins(cdf, cap) {
  const bins = cdf.slice(1).map((v, i) => v - cdf[i]);
  let moved = false;
  for (let i = 0; i < bins.length; i += 1) {
    if (bins[i] <= cap) continue;
    moved = true;
    let excess = bins[i] - cap;
    bins[i] = cap;
    for (let d = 1; excess > 1e-15 && d < bins.length; d += 1) {
      const near = [i - d, i + d].filter((j) => j >= 0 && j < bins.length);
      for (let pass = 0; pass < 2 && excess > 1e-15; pass += 1) {
        const open = near.filter((j) => cap - bins[j] > 1e-15);
        if (!open.length) break;
        const share = excess / open.length;
        for (const j of open) {
          const take = Math.min(cap - bins[j], share);
          bins[j] += take;
          excess -= take;
        }
      }
    }
    if (excess > 1e-12) throw new Error('distribution is too concentrated to fit the per-bin cap');
  }
  const out = [cdf[0]];
  for (const bin of bins) out.push(out[out.length - 1] + bin);
  return { cdf: out, moved };
}

const round = (v) => Number(v.toFixed(DECIMALS));

// Rescale, mix in uniform mass, cap bins and round (method 3.6 step 5).
// Returns { cdf, binCapApplied }.
function standardize(cdf, scaling) {
  const rules = cdfRules(scaling);
  if (cdf.length !== rules.points) throw new Error(`expected ${rules.points} points, got ${cdf.length}`);
  const lo = rules.openLower ? 0 : cdf[0];
  const hi = rules.openUpper ? 1 : cdf[cdf.length - 1];
  if (!(hi > lo)) throw new Error('CDF has no mass inside the range');

  // The template's 0.988 / 0.989 / 0.99 weights, each lowered by the extra 0.0001 uniform mass.
  const shift = UNIFORM_MASS - 0.01;
  let weight = 0.99 - shift;
  let offset = 0;
  if (rules.openLower && rules.openUpper) [weight, offset] = [0.988 - shift, 0.001];
  else if (rules.openLower) [weight, offset] = [0.989 - shift, 0.001];
  else if (rules.openUpper) weight = 0.989 - shift;

  const mixed = cdf.map((v, i) => weight * ((v - lo) / (hi - lo)) + UNIFORM_MASS * (i / rules.intervals) + offset);
  const capped = capBins(mixed, CAP_SAFETY * rules.maxStep);
  const out = capped.cdf.map(round);
  if (!rules.openLower) out[0] = 0;
  if (!rules.openUpper) out[out.length - 1] = 1;
  return { cdf: out, binCapApplied: capped.moved };
}

export function standardizeCdf(cdf, scaling) {
  return standardize(cdf, scaling).cdf;
}

// Several passes' percentiles -> one valid CDF plus whether the per-bin cap
// had to move mass (which flattens a very confident forecast). Throws if the
// result is not valid.
export function buildCdfWithInfo(percentileSets, scaling) {
  const zeroProblem = zeroPointProblem(scaling);
  if (zeroProblem) throw new Error(zeroProblem);
  const cdfs = percentileSets.map((set) => cdfFromPercentiles(set, scaling));
  const result = standardize(medianCdf(cdfs), scaling);
  const problems = validateCdf(result.cdf, scaling);
  if (problems.length) throw new Error(`built CDF is invalid: ${problems.map((p) => p.code).join(', ')}`);
  return result;
}

export function buildCdf(percentileSets, scaling) {
  return buildCdfWithInfo(percentileSets, scaling).cdf;
}
