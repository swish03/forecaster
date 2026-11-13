// Minimal Metaculus API client: only the calls the poster needs.
// Shapes: research/specs/metaculus_bot_spec.md section 3.
// Reads may be retried (429, 5xx, network). Writes are sent exactly once;
// the tick decides about a later attempt after re-reading the question.

import { HttpError, NetworkError, defaultSleep, excerpt, isRetryableStatus, isSuccess, retryAfterMs, sendRequest } from '../lib/http.mjs';
import { CONTINUOUS_TYPES } from '../lib/cdf.mjs';

const READ_ATTEMPTS = 4;
const BACKOFF_START_MS = 2500;
const BACKOFF_MAX_MS = 75000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export function createMetaculusClient({
  baseUrl,
  token,
  fetch = globalThis.fetch,
  timeoutMs = 30000,
  spacingMs = 3500,
  sleep = defaultSleep,
  now = Date.now,
}) {
  if (!token) throw new Error('METACULUS_TOKEN is not set');
  if (!/^https:\/\//.test(baseUrl)) throw new Error('Metaculus base URL must be https');
  const headers = { Authorization: `Token ${token}`, Accept: 'application/json', 'Accept-Language': 'en' };
  let lastRequestAt = -Infinity;

  // forecasting-tools waits about 4 s between calls; no limit is published.
  async function pace() {
    const wait = lastRequestAt + spacingMs - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
  }

  async function once(method, path, body) {
    await pace();
    return sendRequest({ fetch, method, url: `${baseUrl}${path}`, path, headers, body, timeoutMs });
  }

  async function read(path) {
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt === READ_ATTEMPTS - 1;
      let result;
      try {
        result = await once('GET', path);
      } catch (error) {
        if (!(error instanceof NetworkError) || last) throw error;
        await sleep(Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 3 ** attempt));
        continue;
      }
      if (isSuccess(result.status)) return result.json;
      if (!isRetryableStatus(result.status) || last) {
        throw new HttpError({ method: 'GET', path, status: result.status, bodyExcerpt: excerpt(result.text) });
      }
      const hinted = retryAfterMs(result.headers, now());
      await sleep(Math.min(BACKOFF_MAX_MS, hinted ?? BACKOFF_START_MS * 3 ** attempt));
    }
  }

  // A write is sent once. Outcomes (spec 3.5 and 3.8):
  //   posted       2xx, saved
  //   rejected     400 or 405: the server refused this forecast (final)
  //   forbidden    403: may be a passing gateway block, so it can be tried again
  //   retry        429, or the request never left: nothing was saved
  //   setup_error  401 or 404: the token or the endpoint is wrong; stop the tick
  //   unknown      5xx or a timeout: it may or may not have been saved
  async function write(path, body) {
    let result;
    try {
      result = await once('POST', path, body);
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      return { outcome: error.reachedServer ? 'unknown' : 'retry', http: null };
    }
    const status = result.status;
    if (isSuccess(status)) return { outcome: 'posted', http: status };
    if (status === 400 || status === 405) return { outcome: 'rejected', http: status };
    if (status === 403) return { outcome: 'forbidden', http: status };
    if (status === 429) return { outcome: 'retry', http: status };
    if (status === 401 || status === 404) return { outcome: 'setup_error', http: status };
    return { outcome: 'unknown', http: status };
  }

  return {
    getMe: () => read('/users/me'),

    getPost: (postId) => read(`/posts/${encodeURIComponent(postId)}/`),

    // Every open post in one tournament that this user has not forecast yet.
    // No forecast_type filter: it silently drops group questions (method 3.3).
    // optional: a tournament that may not exist (an old MiniBench round, or a
    // slug added before the season opens). A 404 or a 400 then means none:
    // which of the two Metaculus sends for an unknown slug is not documented
    // (ops/SEASONS.md asks the owner to record it in week 1).
    async listOpenPosts({ tournament, notForecasterId, optional = false }) {
      const posts = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({
          tournaments: String(tournament),
          statuses: 'open',
          include_descriptions: 'true',
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
          order_by: '-published_at',
        });
        if (notForecasterId !== undefined && notForecasterId !== null) query.set('not_forecaster_id', String(notForecasterId));
        let data;
        try {
          data = await read(`/posts/?${query}`);
        } catch (error) {
          if (optional && error instanceof HttpError && [400, 404].includes(error.status)) return posts;
          throw error;
        }
        const results = Array.isArray(data?.results) ? data.results : [];
        posts.push(...results);
        if (!results.length || !data.next || results.length < PAGE_SIZE) return posts;
      }
      throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} open posts in tournament ${tournament}`);
    },

    // Forecasts for every question of one post, plus their private comments,
    // in one all-or-nothing call (spec 3.5: a group or a conditional pair must
    // be sent in one request). items: [{ questionId, type, forecast, options }].
    async submitForecasts({ postId, items, comments }) {
      if (!items.length) throw new Error('nothing to submit');
      const body = {
        forecasts: items.map((i) => ({ question: i.questionId, source: 'api', ...toMetaculusForecast(i.type, i.forecast, i.options) })),
        comments: comments.map((text) => ({ on_post: postId, text, is_private: true, included_forecast: true })),
      };
      return write('/questions/bulk-forecast-comment/', body);
    },
  };
}

// Contract forecast -> the field Metaculus expects for that question type.
// Multiple-choice values must sum to exactly 1, so the largest option (the
// first one if several are equal) gets 1 minus the others. Putting the
// rounding rest on the largest option means a small option checked at the
// floor is never pushed below it.
export function toMetaculusForecast(type, forecast, options = null) {
  if (type === 'binary') return { probability_yes: forecast.probability_yes };
  if (type === 'multiple_choice') {
    const keys = Array.isArray(options) && options.length ? options : Object.keys(forecast.probabilities);
    const values = Object.fromEntries(keys.map((k) => [k, forecast.probabilities[k]]));
    const largest = keys.reduce((best, k) => (values[k] > values[best] ? k : best), keys[0]);
    values[largest] = 1 - keys.filter((k) => k !== largest).reduce((sum, k) => sum + values[k], 0);
    return { probability_yes_per_category: values };
  }
  if (CONTINUOUS_TYPES.has(type)) return { continuous_cdf: forecast.cdf };
  throw new Error(`unsupported question type ${type}`);
}

const pick = (...values) => values.find((v) => v !== undefined && v !== null) ?? null;

// The moment after which a forecast no longer counts: the earliest of the
// close times and the spot-scoring time (spec 3.4 and section 4).
function deadlineOf(q, post) {
  const times = [
    pick(q.scheduled_close_time, post.scheduled_close_time),
    pick(q.actual_close_time, post.actual_close_time),
    pick(q.spot_scoring_time),
  ].map((t) => (typeof t === 'string' ? Date.parse(t) : Number.NaN)).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

// fallback: group-level texts for a group, the child question for a conditional.
function normalizeQuestion(q, post, { kind, fallback = null, conditional = null }) {
  const scaling = q.scaling ?? {};
  const continuous = CONTINUOUS_TYPES.has(q.type);
  return {
    question_id: q.id,
    post_id: post.id,
    post_kind: kind,
    type: q.type,
    status: pick(q.status, post.status),
    title: pick(q.title, fallback?.title, post.title),
    label: pick(q.label),
    group_title: kind === 'group' ? pick(post.title) : null,
    description: pick(q.description, fallback?.description),
    resolution_criteria: pick(q.resolution_criteria, fallback?.resolution_criteria),
    fine_print: pick(q.fine_print, fallback?.fine_print),
    options: Array.isArray(q.options) ? q.options : null,
    unit: pick(q.unit, fallback?.unit),
    scaling: continuous
      ? {
          range_min: pick(scaling.range_min),
          range_max: pick(scaling.range_max),
          zero_point: pick(scaling.zero_point),
          open_lower_bound: pick(q.open_lower_bound, scaling.open_lower_bound),
          open_upper_bound: pick(q.open_upper_bound, scaling.open_upper_bound),
          inbound_outcome_count: pick(q.inbound_outcome_count, scaling.inbound_outcome_count),
        }
      : null,
    conditional,
    open_time: pick(q.open_time, post.open_time),
    scheduled_close_time: pick(q.scheduled_close_time, post.scheduled_close_time),
    scheduled_resolve_time: pick(q.scheduled_resolve_time, post.scheduled_resolve_time),
    deadline: deadlineOf(q, post),
    already_forecast: Boolean(q.my_forecasts?.latest),
  };
}

// The two branches of a conditional post. Only question_yes and question_no
// are forecast, never condition or condition_child (spec 3.5).
function conditionalQuestions(post) {
  const c = post.conditional;
  const branches = [['yes', c.question_yes], ['no', c.question_no]];
  if (branches.some(([, q]) => !q || !Number.isInteger(q.id))) {
    return { questions: [], skipped: [{ post_id: post.id, reason: 'conditional_incomplete' }] };
  }
  const child = c.condition_child ?? {};
  const condition = {
    title: pick(c.condition?.title),
    resolution_criteria: pick(c.condition?.resolution_criteria),
    fine_print: pick(c.condition?.fine_print),
  };
  const questions = branches.map(([branch, q]) => normalizeQuestion(q, post, {
    kind: 'conditional',
    fallback: child,
    conditional: { branch, condition, child_title: pick(child.title) },
  }));
  return { questions, skipped: [] };
}

// A post holds one question, a group of questions, or a conditional pair.
export function questionsOfPost(post) {
  if (post?.question) return { questions: [normalizeQuestion(post.question, post, { kind: 'single' })], skipped: [] };
  const group = post?.group_of_questions;
  if (group && Array.isArray(group.questions)) {
    return { questions: group.questions.map((q) => normalizeQuestion(q, post, { kind: 'group', fallback: group })), skipped: [] };
  }
  if (post?.conditional) return conditionalQuestions(post);
  return { questions: [], skipped: [{ post_id: post?.id ?? null, reason: 'not_a_question' }] };
}

// Open now, and its deadline is more than the safety margin away.
// A question with no known deadline is never treated as open.
export function isOpenAt(question, nowMs, marginMs = 0) {
  if (question.status !== 'open') return false;
  const deadline = Date.parse(question.deadline);
  return Number.isFinite(deadline) && deadline - marginMs > nowMs;
}
