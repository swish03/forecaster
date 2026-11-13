// Tiny GitHub REST client shared by the data-repo reader and the state store.

import { HttpError, NetworkError, defaultSleep, excerpt, isSuccess, sendRequest } from '../lib/http.mjs';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function assertRepoName(repo, label) {
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo.split('/').some((part) => /^\.+$/.test(part))) {
    throw new Error(`${label} must look like owner/name`);
  }
}

export function assertBranchName(branch, label) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new Error(`${label} is not a plain branch name`);
  }
}

export function createGitHubClient({ apiUrl = 'https://api.github.com', token, label, fetch = globalThis.fetch, timeoutMs = 30000, sleep = defaultSleep }) {
  if (!token) throw new Error(`${label} is not set`);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'forecaster-poster',
  };

  // GitHub sends the expiry date of a fine-grained token in this header on
  // every answer. The tick turns it into a token_expiring alert by itself,
  // so a blank date in ops/EXPIRY.md does not hide it.
  let expiresOn = null;
  const noteExpiry = (headers) => {
    const value = headers?.get?.('github-authentication-token-expiration');
    const day = typeof value === 'string' ? value.trim().slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) expiresOn = day;
  };

  // Returns { status, json } for 2xx and for any status listed in `allow`;
  // throws HttpError otherwise. Only GETs are retried (once).
  async function call(method, path, { body, allow = [] } = {}) {
    const attempts = method === 'GET' ? 2 : 1;
    for (let attempt = 1; ; attempt += 1) {
      let result;
      try {
        result = await sendRequest({ fetch, method, url: `${apiUrl}${path}`, path, headers, body, timeoutMs });
      } catch (error) {
        if (error instanceof NetworkError && attempt < attempts) {
          await sleep(2000);
          continue;
        }
        throw error;
      }
      noteExpiry(result.headers);
      if (isSuccess(result.status) || allow.includes(result.status)) return { status: result.status, json: result.json };
      if (result.status >= 500 && attempt < attempts) {
        await sleep(2000);
        continue;
      }
      throw new HttpError({ method, path, status: result.status, bodyExcerpt: excerpt(result.text) });
    }
  }

  // The token's expiry day (YYYY-MM-DD) from the last answer, or null.
  return { call, tokenExpiresOn: () => expiresOn };
}
