// A saved question (questions/<id>.json) is one payload item exactly as the
// tick sent it (poster/tick.mjs payloadItem). This turns it into the shape the
// shared validator in lib/schema.mjs expects, and answers simple time questions.

import { CONTINUOUS_TYPES } from '../../../lib/cdf.mjs';
import { questionProblems } from '../../../lib/schema.mjs';
import { DataError } from './cli.mjs';

export function toValidatorQuestion(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new DataError('question_not_object');
  let scaling = null;
  if (CONTINUOUS_TYPES.has(item.type) && item.range && typeof item.range === 'object') {
    scaling = { ...item.range };
    delete scaling.cdf_points;
  }
  return {
    question_id: item.question_id,
    post_id: item.post_id,
    type: item.type,
    options: Array.isArray(item.options) ? item.options : null,
    scaling,
    scheduled_close_time: item.scheduled_close_time ?? null,
  };
}

// Revision 2 = the one replacement the tick asks for after it refused the
// first forecast file. It uses its own file names so nothing is ever rewritten.
export const revisionOf = (item) => (item?.revision === 2 ? 2 : 1);

// File stem for a payload item: "<id>" or "<id>.r2".
export const fileStem = (item) => `${item.question_id}${revisionOf(item) === 2 ? '.r2' : ''}`;

// Problem codes for a payload item; empty means it can be forecast.
export function itemProblems(item) {
  let question;
  try {
    question = toValidatorQuestion(item);
  } catch (error) {
    return [error.code];
  }
  const codes = questionProblems(question).map((p) => p.code);
  if (typeof item.title !== 'string' || !item.title.trim()) codes.push('title_missing');
  if (typeof item.tournament !== 'string' || !item.tournament.trim()) codes.push('tournament_missing');
  for (const field of ['scheduled_close_time', 'deadline']) {
    if (item[field] !== null && item[field] !== undefined && !Number.isFinite(Date.parse(item[field]))) codes.push('close_time_invalid');
  }
  if (![undefined, null, 1, 2].includes(item.revision)) codes.push('revision_invalid');
  return codes;
}

// Minutes until the forecast stops counting: the tick's deadline (the
// earliest close or spot-scoring time), else the scheduled close time.
export function minutesLeft(item, nowMs) {
  const close = Date.parse(item.deadline ?? item.scheduled_close_time);
  return Number.isFinite(close) ? (close - nowMs) / 60000 : Infinity;
}

export function scalingOf(item) {
  const q = toValidatorQuestion(item);
  if (!q.scaling) throw new DataError('question_has_no_range', `question ${item.question_id} is ${item.type}`);
  return q.scaling;
}
