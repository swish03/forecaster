// Wakes the cloud agent through its routine "fire" endpoint.
// Checked on 12 Nov 2026 against the official pages
// https://platform.claude.com/docs/en/api/claude-code/routines-fire and
// https://code.claude.com/docs/en/routines:
//   POST https://api.anthropic.com/v1/claude_code/routines/trig_.../fire
//   Authorization: Bearer <per-task token>
//   anthropic-version: required; "accepts every version from 2023-06-01 on"
//   anthropic-beta: experimental-cc-routine-2026-04-01 (accepted with or without)
//   body: {"text": "..."} up to 65,536 characters
// The version strings live in config.json (routine_api_version, routine_beta).
// The endpoint has no idempotency key: a repeated request starts a second
// session. So a request is repeated only after a 429 (refused, nothing
// started) or when it provably never reached the server.

import { NetworkError, defaultSleep, isSuccess, retryAfterMs, sendRequest } from '../lib/http.mjs';

const TEXT_LIMIT = 65536;
const ENVELOPE_RESERVE = 300;
// Cut first: long texts, least important first. Cut last: short labels.
const CUT_ORDER = [
  ['description'], ['fine_print'], ['conditional', 'condition', 'fine_print'], ['resolution_criteria'],
  ['conditional', 'condition', 'resolution_criteria'], ['group_title'], ['label'], ['title'],
];

// JSON with <, > and & written as \u escapes: still the same JSON value, but
// the text can never contain the closing tag of the payload block.
export const encodeJson = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

// kit_ref: the commit of the public repository whose kit (runbook, method,
// tools) the agent must use for these questions. It is fixed at a question's
// first wake-up, so a later wake-up or a replacement uses the same kit.
const envelope = (questions, part, parts, sentAt, kitRef) =>
  encodeJson({ kind: 'forecast_request', schema: 1, sent_at: sentAt, kit_ref: kitRef, part, parts, questions });

function getAt(obj, path) {
  return path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setAt(obj, path, value) {
  let o = obj;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path[path.length - 1]] = value;
}

// Cuts text fields of one oversized item until it fits. Throws if it cannot.
function shrinkItem(item, budget) {
  const copy = structuredClone(item);
  for (const path of CUT_ORDER) {
    const size = encodeJson(copy).length;
    if (size <= budget) break;
    const text = getAt(copy, path);
    if (typeof text !== 'string') continue;
    const keep = Math.max(0, text.length - (size - budget) - 50);
    setAt(copy, path, `${text.slice(0, keep)} [cut to fit]`);
    copy.truncated = true;
  }
  if (encodeJson(copy).length > budget) throw new Error(`question ${item.question_id} cannot fit in one fire text`);
  return copy;
}

// Fits the items of one post into one budget, cutting each item evenly if needed.
function fitPost(postItems, budget) {
  const total = postItems.reduce((sum, item) => sum + encodeJson(item).length + 1, 0);
  if (total <= budget) return postItems;
  const share = Math.floor(budget / postItems.length) - 1;
  return postItems.map((item) => (encodeJson(item).length > share ? shrinkItem(item, share) : item));
}

// Splits question items into fire texts of at most maxChars characters each.
// Items with the same post_id stay in the same text, because a group or a
// conditional pair is posted in one request. Returns
// { texts: [{ text, questionIds }], skipped: [question ids that cannot fit] }.
export function buildFireTexts(items, { maxChars = 60000, sentAt, kitRef = null }) {
  if (maxChars > TEXT_LIMIT) throw new Error(`fire text limit is ${TEXT_LIMIT} characters`);
  const budget = maxChars - ENVELOPE_RESERVE;
  const byPost = new Map();
  for (const item of items) {
    if (!byPost.has(item.post_id)) byPost.set(item.post_id, []);
    byPost.get(item.post_id).push(item);
  }
  const skipped = [];
  const groups = [];
  let current = [];
  let size = 0;
  for (const raw of byPost.values()) {
    let postItems;
    try {
      postItems = fitPost(raw, budget);
    } catch {
      skipped.push(...raw.map((item) => item.question_id));
      continue;
    }
    const postSize = postItems.reduce((sum, item) => sum + encodeJson(item).length + 1, 0);
    if (current.length && size + postSize > budget) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(...postItems);
    size += postSize;
  }
  if (current.length) groups.push(current);
  const texts = groups.map((questions, i) => ({
    text: envelope(questions, i + 1, groups.length, sentAt, kitRef),
    questionIds: questions.map((q) => q.question_id),
  }));
  return { texts, skipped };
}

export function assertFireUrl(url, prefix) {
  const id = typeof url === 'string' && url.startsWith(prefix) ? url.slice(prefix.length) : '';
  if (!/^trig_[A-Za-z0-9_-]+\/fire$/.test(id)) {
    throw new Error('ROUTINE_FIRE_URL does not look like a routine fire URL');
  }
}

// One fire. Outcomes:
//   fired         the server accepted it (a session started)
//   rate_limited  429 and the wait was too long or still limited (nothing started)
//   rejected      the server said no, e.g. bad token (nothing started)
//   unknown       5xx or a timeout: a session may or may not have started
//   not_sent      the network failed before the request left (nothing started)
export async function fireRoutine({
  url,
  token,
  version,
  beta = null,
  text,
  fetch = globalThis.fetch,
  timeoutMs = 30000,
  sleep = defaultSleep,
  now = Date.now,
  maxWaitMs = 60000,
}) {
  if (!token) throw new Error('ROUTINE_FIRE_TOKEN is not set');
  if (text.length > TEXT_LIMIT) throw new Error('fire text is over the size limit');
  const headers = { Authorization: `Bearer ${token}`, 'anthropic-version': version };
  if (beta) headers['anthropic-beta'] = beta;
  const path = '/fire';
  let retried = false;
  for (;;) {
    let result;
    try {
      result = await sendRequest({ fetch, method: 'POST', url, path, headers, body: { text }, timeoutMs });
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      if (!error.reachedServer && !retried) {
        retried = true;
        await sleep(2000);
        continue;
      }
      return { outcome: error.reachedServer ? 'unknown' : 'not_sent', status: null };
    }
    if (isSuccess(result.status)) return { outcome: 'fired', status: result.status };
    if (result.status === 429) {
      const wait = retryAfterMs(result.headers, now());
      if (!retried && wait !== null && wait <= maxWaitMs) {
        retried = true;
        await sleep(wait);
        continue;
      }
      return { outcome: 'rate_limited', status: 429, retryAfterMs: wait };
    }
    if (result.status >= 500) return { outcome: 'unknown', status: result.status };
    return { outcome: 'rejected', status: result.status };
  }
}
