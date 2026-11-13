// Posts and forecast files built from the shapes documented in
// research/specs/metaculus_bot_spec.md 3.4 (Post with question /
// group_of_questions / conditional; scaling; open bounds; my_forecasts).

import { readFileSync } from 'node:fs';

import { buildCdf } from '../../lib/cdf.mjs';

// Files are written by the kit of the commit the tick runs, so they carry its method version.
export const METHOD_VERSION = JSON.parse(readFileSync(new URL('../../agent/method.json', import.meta.url), 'utf8')).version;

export const NOW = Date.parse('2026-11-16T10:00:00Z');
export const minutes = (n) => n * 60000;
export const iso = (ms) => new Date(ms).toISOString();

function baseQuestion(id, type, closeMs, extra = {}) {
  return {
    id,
    type,
    status: 'open',
    title: `Test question ${id}`,
    description: 'Background text.',
    resolution_criteria: 'Resolves per the named source.',
    fine_print: 'Fine print.',
    options: null,
    unit: null,
    scaling: { range_min: null, range_max: null, zero_point: null, open_lower_bound: null, open_upper_bound: null },
    open_lower_bound: null,
    open_upper_bound: null,
    inbound_outcome_count: null,
    open_time: iso(closeMs - minutes(180)),
    scheduled_close_time: iso(closeMs),
    my_forecasts: { latest: null },
    ...extra,
  };
}

function continuous(id, type, closeMs, { min, max, zero = null, openLower, openUpper, outcomes = 200 }) {
  return baseQuestion(id, type, closeMs, {
    scaling: { range_min: min, range_max: max, zero_point: zero, open_lower_bound: openLower, open_upper_bound: openUpper, inbound_outcome_count: outcomes },
    open_lower_bound: openLower,
    open_upper_bound: openUpper,
    inbound_outcome_count: outcomes,
  });
}

export function questionFor(type, id, closeMs = NOW + minutes(150)) {
  switch (type) {
    case 'binary':
      return baseQuestion(id, 'binary', closeMs);
    case 'multiple_choice':
      return baseQuestion(id, 'multiple_choice', closeMs, { options: ['Alpha', 'Beta', 'Gamma (Δ)'] });
    case 'numeric':
      return continuous(id, 'numeric', closeMs, { min: 0, max: 100, openLower: true, openUpper: true });
    case 'numeric_log':
      return continuous(id, 'numeric', closeMs, { min: 1, max: 10000, zero: 0, openLower: false, openUpper: true });
    case 'discrete':
      return continuous(id, 'discrete', closeMs, { min: -0.5, max: 9.5, openLower: false, openUpper: false, outcomes: 10 });
    case 'date':
      return continuous(id, 'date', closeMs, {
        min: Date.parse('2026-12-01T00:00:00Z') / 1000, max: Date.parse('2027-06-01T00:00:00Z') / 1000, openLower: false, openUpper: true,
      });
    default:
      throw new Error(`no fixture for ${type}`);
  }
}

export function postWith(question, postId = question.id + 100000) {
  return {
    id: postId,
    title: question.title,
    status: question.status,
    open_time: question.open_time,
    scheduled_close_time: question.scheduled_close_time,
    projects: { tournament: [{ slug: 'fall-futureeval-2026' }] },
    question,
  };
}

export function groupPost(postId, questions) {
  return {
    id: postId,
    title: 'Group title',
    status: 'open',
    group_of_questions: { description: 'Group background', resolution_criteria: 'Group criteria', fine_print: 'Group fine print', questions },
  };
}

// question_yes / question_no carry their own forecastable fields; their texts
// come from the child question (shape per spec 3.3 and 3.5).
export function conditionalPost(postId, { yes = 3, no = 4, closeMs = NOW + minutes(150) } = {}) {
  const branch = (id, word) => ({ ...baseQuestion(id, 'binary', closeMs), title: `Child (if condition ${word})`, description: null, resolution_criteria: null, fine_print: null });
  return {
    id: postId,
    title: 'Conditional',
    status: 'open',
    scheduled_close_time: iso(closeMs),
    conditional: {
      condition: { id: 1, title: 'Condition title', resolution_criteria: 'Condition criteria' },
      condition_child: { id: 2, title: 'Child title', description: 'Child background', resolution_criteria: 'Child criteria', fine_print: 'Child fine print' },
      question_yes: branch(yes, 'yes'),
      question_no: branch(no, 'no'),
    },
  };
}

// The scaling block exactly as the poster normalises it.
export function scalingOf(q) {
  return { ...q.scaling, open_lower_bound: q.open_lower_bound, open_upper_bound: q.open_upper_bound, inbound_outcome_count: q.inbound_outcome_count };
}

const PERCENTILES = { 5: 20, 10: 30, 25: 40, 50: 50, 75: 60, 90: 70, 95: 80 };

function forecastFor(q) {
  if (q.type === 'binary') return { probability_yes: 0.3 };
  if (q.type === 'multiple_choice') return { probabilities: { Alpha: 0.5, Beta: 0.3, 'Gamma (Δ)': 0.2 } };
  const s = scalingOf(q);
  const span = s.range_max - s.range_min;
  const set = Object.fromEntries(Object.entries(PERCENTILES).map(([p, v]) => [p, s.range_min + (span * v) / 100]));
  return { cdf: buildCdf([set], s) };
}

export function forecastFile(q, postId, overrides = {}) {
  return {
    schema: 1,
    question_id: q.id,
    post_id: postId,
    tournament: 'fall-futureeval-2026',
    type: q.type,
    title: q.title,
    created_at: iso(NOW - minutes(30)),
    method_version: METHOD_VERSION,
    forecast: forecastFor(q),
    comment: 'Forecast: 30% (bot v1.0, fully automated, no human input)\nQuestion as read: a test question.',
    passes: [{ value: 0.3, reason: 'outside view' }, { value: 0.32, reason: 'inside view' }],
    signals: { market: null, community: null, base_rate: 'about 25% in the reference class' },
    checks: { validated: true, clamped: false, blend_weight: 0 },
    ...overrides,
  };
}
