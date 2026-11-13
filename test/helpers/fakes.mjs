// In-memory stand-ins for GitHub, Metaculus and the routine fire endpoint,
// shaped after the documented responses in research/specs. No network.

import { createHash } from 'node:crypto';

// The git blob id of a file, as GitHub reports it (sha1 of "blob <size>\0" + bytes).
export const gitBlobSha = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');

export const TOKENS = Object.freeze({
  metaculus: 'test-metaculus-value',
  data: 'test-data-read-value',
  workflow: 'test-workflow-value',
  fire: 'test-fire-value',
});

export function json(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const refusedError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
export const timeoutError = () => new DOMException('The operation timed out.', 'TimeoutError');

// ---------------------------------------------------------------- GitHub ----

export class FakeGitHub {
  constructor() {
    this.repos = new Map();
    this.counter = 0;
    this.calls = [];
    this.beforeRefMove = null;
  }

  addRepo(name, { readToken, writeToken }) {
    this.repos.set(name, {
      readToken, writeToken, refs: {}, commits: {}, trees: {}, blobs: {},
      issues: [], runs: [], workflowEnabled: {}, enableCalls: 0, dispatches: [],
      // The metaculus environment, set up as SECURITY.md asks (main only).
      environments: { metaculus: { policy: { protected_branches: false, custom_branch_policies: true }, branches: [{ name: 'main', type: 'branch' }] } },
    });
  }

  // Test-side helper: a past Actions run of a workflow.
  addRun(repoName, { event = 'schedule', created_at }) {
    const repo = this.repos.get(repoName);
    repo.runs.push({ id: repo.runs.length + 1, event, created_at, status: 'completed' });
  }

  openIssues(repoName) {
    return this.repos.get(repoName).issues.filter((i) => i.state === 'open');
  }

  // Issues and Actions routes (the parts the tick uses), like the REST API.
  handleRepoApi(repo, method, rest, query, body, token) {
    const canWrite = token === repo.writeToken;
    if (rest === 'issues' && method === 'GET') {
      const creator = query.get('creator');
      const state = query.get('state') ?? 'open';
      return json(200, repo.issues.filter((i) => (state === 'all' || i.state === state) && (!creator || i.user.login === creator)));
    }
    if (rest === 'issues' && method === 'POST') {
      if (!canWrite) return json(403, { message: 'Resource not accessible by integration' });
      const issue = { number: repo.issues.length + 1, title: body.title, body: body.body, state: 'open', user: { login: 'github-actions[bot]' }, comments: [] };
      repo.issues.push(issue);
      return json(201, issue);
    }
    const one = rest.match(/^issues\/(\d+)(\/comments)?$/);
    if (one) {
      const issue = repo.issues.find((i) => i.number === Number(one[1]));
      if (!issue) return json(404, { message: 'Not Found' });
      if (method === 'GET' && !one[2]) return json(200, issue);
      if (!canWrite) return json(403, { message: 'Resource not accessible by integration' });
      if (method === 'POST' && one[2]) {
        issue.comments.push(body.body);
        return json(201, { id: issue.comments.length });
      }
      if (method === 'PATCH' && !one[2]) {
        Object.assign(issue, { state: body.state ?? issue.state });
        return json(200, issue);
      }
    }
    const envMatch = rest.match(/^environments\/([^/]+)(\/deployment-branch-policies)?$/);
    if (envMatch && method === 'GET') {
      const env = repo.environments[decodeURIComponent(envMatch[1])];
      if (!env) return json(404, { message: 'Not Found' });
      if (envMatch[2]) return json(200, { total_count: env.branches.length, branch_policies: env.branches });
      return json(200, { name: envMatch[1], deployment_branch_policy: env.policy });
    }
    const wf = rest.match(/^actions\/workflows\/([^/]+)\/(runs|enable|dispatches)$/);
    if (wf) {
      if (wf[2] === 'runs' && method === 'GET') {
        const created = (query.get('created') ?? '').replace(/^>=/, '');
        const since = created ? Date.parse(created) : -Infinity;
        const all = repo.runs.filter((r) => Date.parse(r.created_at) >= since).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        const perPage = Number(query.get('per_page') ?? 30);
        const page = Number(query.get('page') ?? 1);
        return json(200, { total_count: all.length, workflow_runs: all.slice((page - 1) * perPage, page * perPage) });
      }
      if (!canWrite) return json(403, { message: 'Resource not accessible by integration' });
      if (wf[2] === 'enable' && method === 'PUT') {
        repo.enableCalls += 1;
        repo.workflowEnabled[wf[1]] = true;
        return new Response(null, { status: 204 });
      }
      if (wf[2] === 'dispatches' && method === 'POST') {
        repo.dispatches.push({ workflow: wf[1], ...body });
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { message: `fake has no route for ${method} ${rest}` });
  }

  sha() {
    this.counter += 1;
    return this.counter.toString(16).padStart(40, '0');
  }

  makeTree(repo, files) {
    const entries = Object.entries(files).map(([path, content]) => {
      const bytes = Buffer.from(content, 'utf8');
      const blobSha = gitBlobSha(bytes);
      repo.blobs[blobSha] = bytes;
      return { path, sha: blobSha, size: repo.blobs[blobSha].length };
    });
    const treeSha = this.sha();
    repo.trees[treeSha] = entries;
    return treeSha;
  }

  filesAt(repo, commitSha) {
    if (!commitSha) return {};
    const tree = repo.trees[repo.commits[commitSha].tree];
    return Object.fromEntries(tree.map((e) => [e.path, repo.blobs[e.sha].toString('utf8')]));
  }

  // Test-side helper: add or replace files on a branch in one commit.
  commitFiles(repoName, branch, files) {
    const repo = this.repos.get(repoName);
    const head = repo.refs[branch];
    const tree = this.makeTree(repo, { ...this.filesAt(repo, head), ...files });
    const commit = this.sha();
    repo.commits[commit] = { tree, parents: head ? [head] : [] };
    repo.refs[branch] = commit;
    return commit;
  }

  // Like the real API: without ?recursive=1 a folder is one 'tree' entry
  // whose sha lists that folder's own entries.
  listTree(repo, treeSha, recursive) {
    const tree = repo.trees[treeSha];
    const blob = (e) => ({ path: e.path, type: 'blob', mode: '100644', sha: e.sha, size: e.size });
    if (recursive) return tree.map(blob);
    const out = [];
    const dirs = new Map();
    for (const e of tree) {
      const cut = e.path.indexOf('/');
      if (cut === -1) out.push(blob(e));
      else {
        const dir = e.path.slice(0, cut);
        if (!dirs.has(dir)) dirs.set(dir, []);
        dirs.get(dir).push({ ...e, path: e.path.slice(cut + 1) });
      }
    }
    for (const [dir, entries] of dirs) {
      const sha = this.sha();
      repo.trees[sha] = entries;
      out.push({ path: dir, type: 'tree', mode: '040000', sha });
    }
    return out;
  }

  readFile(repoName, branch, path) {
    const repo = this.repos.get(repoName);
    return this.filesAt(repo, repo.refs[branch])[path];
  }

  handle(method, path, body, auth) {
    this.calls.push({ method, path });
    const api = path.match(/^\/repos\/([^/]+\/[^/]+)\/((?:issues|actions|environments)[^?]*)(?:\?(.*))?$/);
    if (api) {
      const repo = this.repos.get(api[1]);
      if (!repo) return json(404, { message: 'Not Found' });
      const token = auth?.replace(/^Bearer /, '');
      if (token && token !== repo.readToken && token !== repo.writeToken) return json(401, { message: 'Bad credentials' });
      return this.handleRepoApi(repo, method, api[2], new URLSearchParams(api[3] ?? ''), body, token);
    }
    const m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/(.+)$/);
    const repo = m && this.repos.get(m[1]);
    if (!repo) return json(404, { message: 'Not Found' });
    const token = auth?.replace(/^Bearer /, '');
    const canRead = token === repo.readToken || token === repo.writeToken;
    if (!canRead) return json(401, { message: 'Bad credentials' });
    if (method !== 'GET' && token !== repo.writeToken) return json(403, { message: 'Resource not accessible' });
    const rest = m[2].split('?')[0];

    if (method === 'GET' && rest.startsWith('ref/heads/')) {
      const sha = repo.refs[rest.slice('ref/heads/'.length)];
      return sha ? json(200, { object: { sha, type: 'commit' } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && rest.startsWith('trees/')) {
      const sha = rest.slice('trees/'.length);
      const treeSha = repo.commits[sha]?.tree ?? sha;
      if (!repo.trees[treeSha]) return json(404, { message: 'Not Found' });
      return json(200, { sha: treeSha, truncated: false, tree: this.listTree(repo, treeSha, path.includes('recursive=1')) });
    }
    if (method === 'GET' && rest.startsWith('blobs/')) {
      const blob = repo.blobs[rest.slice('blobs/'.length)];
      return blob ? json(200, { encoding: 'base64', content: blob.toString('base64') }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === 'trees') {
      const files = Object.fromEntries(body.tree.map((e) => [e.path, e.content]));
      return json(201, { sha: this.makeTree(repo, files) });
    }
    if (method === 'POST' && rest === 'commits') {
      const sha = this.sha();
      repo.commits[sha] = { tree: body.tree, parents: body.parents };
      return json(201, { sha });
    }
    if (method === 'PATCH' && rest.startsWith('refs/heads/')) {
      const branch = rest.slice('refs/heads/'.length);
      this.beforeRefMove?.(m[1], branch);
      const current = repo.refs[branch];
      const commit = repo.commits[body.sha];
      if (!commit || (!body.force && !commit.parents.includes(current))) return json(422, { message: 'Update is not a fast forward' });
      repo.refs[branch] = body.sha;
      return json(200, { object: { sha: body.sha } });
    }
    if (method === 'POST' && rest === 'refs') {
      const branch = body.ref.replace('refs/heads/', '');
      this.beforeRefMove?.(m[1], branch);
      if (repo.refs[branch]) return json(422, { message: 'Reference already exists' });
      repo.refs[branch] = body.sha;
      return json(201, { object: { sha: body.sha } });
    }
    return json(404, { message: `fake has no route for ${method} ${rest}` });
  }
}

// ------------------------------------------------------------- Metaculus ----

export class FakeMetaculus {
  constructor({ botId = 4242 } = {}) {
    this.botId = botId;
    this.posts = new Map();
    this.tournaments = new Map();
    this.writes = [];
    this.calls = [];
    this.writeResponder = null;
  }

  addPost(post, tournamentKeys) {
    this.posts.set(post.id, post);
    for (const key of tournamentKeys) {
      if (!this.tournaments.has(String(key))) this.tournaments.set(String(key), []);
      this.tournaments.get(String(key)).push(post.id);
    }
  }

  questionsOf(post) {
    if (post.question) return [post.question];
    if (post.conditional) return [post.conditional.question_yes, post.conditional.question_no];
    return post.group_of_questions?.questions ?? [];
  }

  findQuestion(id) {
    for (const post of this.posts.values()) {
      const q = this.questionsOf(post).find((x) => x.id === id);
      if (q) return q;
    }
    return null;
  }

  markForecast(questionId) {
    const q = this.findQuestion(questionId);
    if (q) q.my_forecasts = { latest: { forecast_values: [0.5, 0.5] } };
  }

  handle(method, path, body, auth) {
    this.calls.push({ method, path });
    if (auth !== `Token ${TOKENS.metaculus}`) {
      return new Response('Permission Error: The API is only available to authenticated users.', { status: 403 });
    }
    const url = new URL(`https://x${path}`);
    if (method === 'GET' && url.pathname === '/api/users/me') return json(200, { id: this.botId, username: 'bot' });
    if (method === 'GET' && url.pathname === '/api/posts/') {
      const keys = url.searchParams.getAll('tournaments');
      const ids = keys.flatMap((k) => this.tournaments.get(k) ?? []);
      const notMine = url.searchParams.get('not_forecaster_id');
      const open = ids.map((id) => this.posts.get(id)).filter((p) => p.status === 'open')
        .filter((p) => !(notMine && this.questionsOf(p).some((q) => q.my_forecasts?.latest)));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const results = open.slice(offset, offset + limit);
      return json(200, { next: offset + limit < open.length ? 'next-page' : null, previous: null, results });
    }
    const one = url.pathname.match(/^\/api\/posts\/(\d+)\/$/);
    if (method === 'GET' && one) {
      const post = this.posts.get(Number(one[1]));
      return post ? json(200, post) : json(404, { detail: 'Not found.' });
    }
    if (method === 'POST') {
      this.writes.push({ path: url.pathname, body });
      if (this.writeResponder) {
        const scripted = this.writeResponder(url.pathname, body);
        if (scripted) return scripted;
      }
      if (url.pathname === '/api/questions/bulk-forecast-comment/') {
        for (const f of body.forecasts) this.markForecast(f.question);
        return json(201, {});
      }
      if (url.pathname === '/api/questions/forecast/') {
        for (const f of body) this.markForecast(f.question);
        return json(201, {});
      }
      if (url.pathname === '/api/comments/create/') return json(201, { id: 1 });
    }
    return json(404, { detail: 'Not found.' });
  }
}

// --------------------------------------------------------------- Routine ----

export class FakeRoutine {
  constructor() {
    this.requests = [];
    this.script = [];
  }

  handle(method, path, body, auth, headers) {
    this.requests.push({ body, auth, version: headers['anthropic-version'], beta: headers['anthropic-beta'] });
    const next = this.script.shift();
    if (typeof next === 'function') return next();
    if (next) return next;
    return json(200, { type: 'routine_fire', claude_code_session_url: 'https://claude.ai/code/session_x' });
  }
}

// One fetch that routes by host to the fakes above.
export function makeFetch({ github, metaculus, routine }) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers?.Authorization;
    const path = `${u.pathname}${u.search}`;
    let result;
    if (u.host === 'api.github.com' && github) result = github.handle(init.method, path, body, auth);
    else if (u.host === 'www.metaculus.com' && metaculus) result = metaculus.handle(init.method, path, body, auth);
    else if (u.host === 'api.anthropic.com' && routine) result = routine.handle(init.method, path, body, auth, init.headers);
    else throw new Error(`unexpected request to ${u.host}`);
    if (result instanceof Error) throw result;
    return result;
  };
}
