// The tick's memory: fired.json, posted.json and ops.json on the "state"
// branch of the public repo, read and written through the GitHub REST API with
// the workflow token. Only question ids, file hashes, status codes, counts and
// times are stored. ops.json holds the tick's own housekeeping (fires per day,
// the batch hold, the clock check, the weekly keep-alive, the alert issue).
//
// Writes use optimistic concurrency: a new commit is built on the head we
// read and the branch is moved with force=false. If someone moved it first,
// GitHub answers 422, we re-read and re-apply the same change.

import { assertBranchName, assertRepoName } from './github.mjs';

const FILES = ['fired.json', 'posted.json', 'ops.json'];
const KEY_OF = { 'fired.json': 'fired', 'posted.json': 'posted', 'ops.json': 'ops' };
const MAX_ATTEMPTS = 4;

export const emptyState = () => ({ fired: {}, posted: {}, ops: {} });
const pick = (s) => ({ fired: s.fired, posted: s.posted, ops: s.ops ?? {} });

function parseLedger(buffer, name) {
  let data;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`state file ${name} is not valid JSON; fix it by hand before the next tick`);
  }
  const isObject = data && typeof data === 'object' && !Array.isArray(data);
  // ops.json is a plain object of housekeeping fields; the two ledgers are keyed by question id.
  const valid = isObject && (name === 'ops.json' ||
    Object.entries(data).every(([k, v]) => /^\d+$/.test(k) && v && typeof v === 'object' && !Array.isArray(v)));
  if (!valid) throw new Error(`state file ${name} has an unexpected shape; fix it by hand before the next tick`);
  return data;
}

export function createStateStore({ github, repo, branch = 'state' }) {
  assertRepoName(repo, 'GITHUB_REPOSITORY');
  assertBranchName(branch, 'state branch');
  const base = `/repos/${repo}`;
  let cached = null;

  async function readFile(treeEntries, name) {
    const entry = treeEntries.find((e) => e.path === name && e.type === 'blob');
    if (!entry) return {};
    const blob = await github.call('GET', `${base}/git/blobs/${entry.sha}`);
    return parseLedger(Buffer.from(blob.json?.content ?? '', 'base64'), name);
  }

  // { fired, posted, ops, head } where head is null when the branch does not exist yet.
  async function load() {
    const ref = await github.call('GET', `${base}/git/ref/heads/${branch}`, { allow: [404] });
    if (ref.status === 404) {
      cached = { ...emptyState(), head: null };
      return cached;
    }
    const head = ref.json?.object?.sha;
    if (!head) throw new Error('state branch ref has no commit');
    const tree = await github.call('GET', `${base}/git/trees/${head}`);
    const entries = Array.isArray(tree.json?.tree) ? tree.json.tree : [];
    cached = { fired: await readFile(entries, 'fired.json'), posted: await readFile(entries, 'posted.json'), ops: await readFile(entries, 'ops.json'), head };
    return cached;
  }

  // Returns the new head sha, or null if the branch moved under us.
  async function writeCommit(next, head, message) {
    const tree = await github.call('POST', `${base}/git/trees`, {
      body: {
        tree: FILES.map((name) => ({
          path: name,
          mode: '100644',
          type: 'blob',
          content: `${JSON.stringify(next[KEY_OF[name]] ?? {}, null, 2)}\n`,
        })),
      },
    });
    const commit = await github.call('POST', `${base}/git/commits`, {
      body: { message, tree: tree.json.sha, parents: head ? [head] : [] },
    });
    const sha = commit.json.sha;
    const moved = head
      ? await github.call('PATCH', `${base}/git/refs/heads/${branch}`, { body: { sha, force: false }, allow: [422] })
      : await github.call('POST', `${base}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha }, allow: [422] });
    return moved.status === 422 ? null : sha;
  }

  // mutate(copy) receives a copy of { fired, posted, ops } and returns the new value.
  // It may run more than once (after a conflict), so it must be a pure change.
  async function update(mutate, message) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const current = cached ?? (await load());
      const next = pick(mutate(structuredClone(pick(current))));
      if (JSON.stringify(next) === JSON.stringify(pick(current))) return current;
      const head = await writeCommit(next, current.head, message);
      if (head) {
        cached = { ...next, head };
        return cached;
      }
      cached = null;
    }
    throw new Error(`state branch kept changing; gave up after ${MAX_ATTEMPTS} attempts`);
  }

  return { load, update };
}
