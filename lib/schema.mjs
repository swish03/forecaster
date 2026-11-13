// Validation of a forecast file (forecasts/<question_id>.json in the data repo)
// against the shared contract and against the live question it answers.
// Problems are { code, detail }. Details never quote question text, option
// names, file contents or forecast values. The tick prints only the codes in
// its public logs; the agent's tools print the details in the private run.

import { CONTINUOUS_TYPES, cdfRules, validateCdf, zeroPointProblem } from './cdf.mjs';

export const QUESTION_TYPES = new Set(['binary', 'multiple_choice', 'numeric', 'discrete', 'date']);

export const DEFAULT_LIMITS = Object.freeze({
  binary_min: 0.01,
  binary_max: 0.99,
  mc_min: 0.001,
  mc_sum_tolerance: 1e-6,
  comment_min_chars: 50,
  comment_max_chars: 3000,
  max_passes: 10,
  max_blend_weight: 0.5,
  future_skew_seconds: 300,
});

const TOP_LEVEL_KEYS = [
  'schema', 'question_id', 'post_id', 'tournament', 'type', 'title', 'created_at',
  'method_version', 'forecast', 'comment', 'passes', 'signals', 'checks',
];

const problem = (code, detail = '') => ({ code, detail });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isProbability = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const nonEmptyString = (v, max = 1000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// Is the question itself complete enough to forecast? Used at discovery and before posting.
export function questionProblems(question) {
  const out = [];
  if (!Number.isInteger(question.question_id)) out.push(problem('question_id_missing'));
  if (!Number.isInteger(question.post_id)) out.push(problem('post_id_missing'));
  if (!QUESTION_TYPES.has(question.type)) out.push(problem('question_type_unsupported', String(question.type)));
  if (question.type === 'multiple_choice') {
    const options = question.options;
    if (!Array.isArray(options) || options.length < 2 || new Set(options).size !== options.length) {
      out.push(problem('question_options_invalid'));
    }
  }
  if (CONTINUOUS_TYPES.has(question.type)) {
    const s = question.scaling;
    if (!s || typeof s.range_min !== 'number' || typeof s.range_max !== 'number' || !(s.range_max > s.range_min)) {
      out.push(problem('question_range_invalid'));
    } else if (question.type === 'discrete' && !Number.isInteger(s.inbound_outcome_count)) {
      out.push(problem('question_outcome_count_missing'));
    } else if (typeof s.open_lower_bound !== 'boolean' || typeof s.open_upper_bound !== 'boolean') {
      out.push(problem('question_bounds_missing'));
    } else if (zeroPointProblem(s)) {
      out.push(problem('question_zero_point_invalid', zeroPointProblem(s)));
    } else {
      try {
        cdfRules(s);
      } catch {
        out.push(problem('question_outcome_count_invalid'));
      }
    }
  }
  return out;
}

function forecastProblems(forecast, question, limits) {
  if (!isObject(forecast)) return [problem('forecast_not_object')];
  const keys = Object.keys(forecast);
  if (question.type === 'binary') {
    if (keys.length !== 1 || !('probability_yes' in forecast)) return [problem('forecast_shape', 'binary needs only probability_yes')];
    const p = forecast.probability_yes;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < limits.binary_min || p > limits.binary_max) {
      return [problem('binary_out_of_range', `must be in [${limits.binary_min}, ${limits.binary_max}]`)];
    }
    return [];
  }
  if (question.type === 'multiple_choice') {
    if (keys.length !== 1 || !isObject(forecast.probabilities)) return [problem('forecast_shape', 'multiple choice needs only probabilities')];
    const given = Object.keys(forecast.probabilities);
    const options = question.options;
    const sameOptions = given.length === options.length && options.every((o) => Object.hasOwn(forecast.probabilities, o));
    if (!sameOptions) return [problem('mc_options_mismatch', `expected ${options.length} options matching character for character`)];
    const values = options.map((o) => forecast.probabilities[o]);
    if (values.some((v) => !isProbability(v) || v < limits.mc_min)) return [problem('mc_value_out_of_range', `each option must be in [${limits.mc_min}, 1]`)];
    const sum = values.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > limits.mc_sum_tolerance) return [problem('mc_sum', `must sum to 1 within ${limits.mc_sum_tolerance}`)];
    return [];
  }
  if (keys.length !== 1 || !('cdf' in forecast)) return [problem('forecast_shape', 'continuous needs only cdf')];
  return validateCdf(forecast.cdf, question.scaling);
}

function contractProblems(file, limits, nowMs) {
  const out = [];
  const unknown = Object.keys(file).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (unknown.length) out.push(problem('unknown_fields', `${unknown.length} unknown top-level field(s)`));
  const missing = TOP_LEVEL_KEYS.filter((k) => !(k in file));
  if (missing.length) out.push(problem('missing_fields', missing.join(', ')));
  if (file.schema !== 1) out.push(problem('schema_version'));
  if (!nonEmptyString(file.tournament, 100)) out.push(problem('tournament_invalid'));
  if (!nonEmptyString(file.title, 1000)) out.push(problem('title_invalid'));
  if (!nonEmptyString(file.method_version, 50)) out.push(problem('method_version_invalid'));

  const created = typeof file.created_at === 'string' ? Date.parse(file.created_at) : Number.NaN;
  if (!Number.isFinite(created)) out.push(problem('created_at_invalid'));
  else if (created > nowMs + limits.future_skew_seconds * 1000) out.push(problem('created_at_in_future'));

  if (typeof file.comment !== 'string' || file.comment.trim().length < limits.comment_min_chars) {
    out.push(problem('comment_too_short', `minimum ${limits.comment_min_chars} characters`));
  } else if (file.comment.length > limits.comment_max_chars) {
    out.push(problem('comment_too_long', `maximum ${limits.comment_max_chars} characters`));
  }

  if (!Array.isArray(file.passes) || file.passes.length < 1 || file.passes.length > limits.max_passes) {
    out.push(problem('passes_invalid', `need 1 to ${limits.max_passes} passes`));
  } else if (file.passes.some((p) => p === null || p === undefined)) {
    out.push(problem('passes_invalid', 'empty pass'));
  }

  const s = file.signals;
  if (!isObject(s) || !['market', 'community', 'base_rate'].every((k) => k in s)) {
    out.push(problem('signals_invalid', 'needs market, community and base_rate'));
  } else if (
    !(s.market === null || isObject(s.market)) ||
    !(s.community === null || isObject(s.community)) ||
    !(s.base_rate === null || typeof s.base_rate === 'string')
  ) {
    out.push(problem('signals_invalid', 'wrong value types'));
  }

  const c = file.checks;
  if (!isObject(c) || c.validated !== true || typeof c.clamped !== 'boolean') {
    out.push(problem('checks_invalid', 'needs validated: true and clamped: true/false'));
  } else if (typeof c.blend_weight !== 'number' || !(c.blend_weight >= 0 && c.blend_weight <= limits.max_blend_weight)) {
    out.push(problem('blend_weight_invalid', `must be in [0, ${limits.max_blend_weight}]`));
  } else if (c.blend_weight > 0 && isObject(s) && s.market === null && s.community === null) {
    out.push(problem('blend_without_signal'));
  }
  return out;
}

// Problem codes that say something about the forecast's numbers (for
// example "below 1%"). The tick's logs and its state branch are public, so
// these are shown there only as 'forecast_value_rule'. The agent's own tools
// print the full codes and details in the private run.
export const VALUE_PROBLEM_CODES = new Set([
  'binary_out_of_range', 'mc_value_out_of_range', 'mc_sum', 'blend_weight_invalid', 'blend_without_signal',
  'cdf_value_range', 'cdf_lower_bound', 'cdf_upper_bound', 'cdf_step_too_small', 'cdf_step_too_large',
]);

export const publicProblemCodes = (codes) => [...new Set(codes.map((c) => (VALUE_PROBLEM_CODES.has(c) ? 'forecast_value_rule' : c)))];

// The percent text the agent's aggregate tool writes for a yes/no forecast.
export const percentText = (p) => `${String(Number((p * 100).toPrecision(4)))}%`;

// The comment must begin with the forecast that is really posted. For yes/no
// questions the number itself is checked (the first line starts with
// "Forecast: <p>%"); for other types the line must start with "Forecast:".
function commentForecastProblems(file, question) {
  const first = String(file.comment ?? '').trim().split('\n')[0];
  if (!first.startsWith('Forecast:')) return [problem('comment_forecast_mismatch', 'the first line must be the Forecast line')];
  if (question.type === 'binary' && !first.startsWith(`Forecast: ${percentText(file.forecast.probability_yes)}`)) {
    return [problem('comment_forecast_mismatch', 'the Forecast line does not match probability_yes')];
  }
  return [];
}

// Full check of a parsed forecast file against the live question it answers.
export function validateForecastFile(file, question, { limits = DEFAULT_LIMITS, nowMs = Date.now() } = {}) {
  if (!isObject(file)) return [problem('file_not_object')];
  const all = { ...DEFAULT_LIMITS, ...limits };
  const out = [...questionProblems(question)];
  if (out.length) return out;
  if (file.question_id !== question.question_id) out.push(problem('question_id_mismatch'));
  if (file.post_id !== question.post_id) out.push(problem('post_id_mismatch'));
  if (file.type !== question.type) out.push(problem('type_mismatch', `question is ${question.type}`));
  out.push(...contractProblems(file, all, nowMs));
  if (file.type === question.type) {
    const forecast = forecastProblems(file.forecast, question, all);
    out.push(...forecast);
    if (!forecast.length && typeof file.comment === 'string') out.push(...commentForecastProblems(file, question));
  }
  return out;
}
