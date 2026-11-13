// Small shared HTTP layer: one request with a timeout, typed errors, and the
// "did this request reach the server at all?" test that guards every write.

export class HttpError extends Error {
  constructor({ method, path, status, bodyExcerpt = '' }) {
    super(`${method} ${path} failed with HTTP ${status}`);
    this.name = 'HttpError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export class NetworkError extends Error {
  constructor({ method, path, cause }) {
    const reason = cause?.name === 'TimeoutError' ? 'timed out' : 'network error';
    super(`${method} ${path} ${reason}`);
    this.name = 'NetworkError';
    this.method = method;
    this.path = path;
    this.cause = cause;
    this.reachedServer = !notReached(cause);
  }
}

// Only failures that happen before any byte is sent prove the server never saw
// the request. A timeout or a reset could come after the server acted.
const NOT_REACHED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

function notReached(error) {
  const code = error?.cause?.code ?? error?.code;
  return NOT_REACHED_CODES.has(code);
}

export async function sendRequest({ fetch, method, url, path, headers = {}, body, timeoutMs }) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  let text;
  try {
    response = await fetch(url, init);
    text = await response.text();
  } catch (cause) {
    throw new NetworkError({ method, path, cause });
  }
  return { status: response.status, headers: response.headers, text, json: parseJson(text) };
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isSuccess(status) {
  return status >= 200 && status < 300;
}

export function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

// Retry-After is either a number of seconds or an HTTP date.
export function retryAfterMs(headers, nowMs) {
  const value = headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

export function excerpt(text, max = 200) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
