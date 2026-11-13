// Read-only view of the private data repository through the GitHub REST API.
// It lists forecasts/<question_id>.json (and the one allowed replacement,
// forecasts/<question_id>.r2.json) and fetches file bytes. Nothing from that
// repository is ever cloned or executed: files are only parsed as JSON.

import { assertBranchName, assertRepoName } from './github.mjs';

// Only the canonical spelling counts: no leading zeros, so two names can never
// mean the same question.
const FORECAST_NAME = /^([1-9]\d{0,11})(\.r2)?\.json$/;
const FORECASTS_DIR = 'forecasts';
export const GUARDED_ROOT_FILES = ['bootstrap.mjs', 'CLAUDE.md'];

export function createDataRepo({ github, repo, branch }) {
  assertRepoName(repo, 'DATA_REPO');
  assertBranchName(branch, 'data repo branch');
  const base = `/repos/${repo}`;

  return {
    // [{ questionId, revision, path, sha, size }] for every forecast file on the branch.
    // Only the forecasts/ folder is listed, so the rest of the repo can grow freely.
    async listForecasts() {
      const ref = await github.call('GET', `${base}/git/ref/heads/${branch}`);
      const commitSha = ref.json?.object?.sha;
      if (!commitSha) throw new Error('data repo branch has no commit');
      const root = await github.call('GET', `${base}/git/trees/${commitSha}`);
      const folder = (root.json?.tree ?? []).find((e) => e.path === FORECASTS_DIR && e.type === 'tree');
      if (!folder) return [];
      const tree = await github.call('GET', `${base}/git/trees/${folder.sha}`);
      if (tree.json?.truncated) throw new Error('forecasts folder listing was truncated by GitHub');
      const entries = Array.isArray(tree.json?.tree) ? tree.json.tree : [];
      return entries
        .filter((e) => e.type === 'blob' && FORECAST_NAME.test(e.path))
        .map((e) => {
          const [, id, r2] = e.path.match(FORECAST_NAME);
          return { questionId: Number(id), revision: r2 ? 2 : 1, path: `${FORECASTS_DIR}/${e.path}`, sha: e.sha, size: e.size };
        });
    },

    // Git blob ids of the files that steer the agent or hold workflows:
    // bootstrap.mjs, CLAUDE.md and every file in .github/workflows/.
    // { 'bootstrap.mjs': sha, 'CLAUDE.md': sha, '.github/workflows/notify.yml': sha, ... }
    // The tick compares them with ops/data-template.json (data_repo_changed).
    async guardedFiles() {
      const ref = await github.call('GET', `${base}/git/ref/heads/${branch}`);
      const commitSha = ref.json?.object?.sha;
      if (!commitSha) throw new Error('data repo branch has no commit');
      const list = async (sha) => {
        const tree = await github.call('GET', `${base}/git/trees/${sha}`);
        if (tree.json?.truncated) throw new Error('data repo listing was truncated by GitHub');
        return Array.isArray(tree.json?.tree) ? tree.json.tree : [];
      };
      const root = await list(commitSha);
      const out = {};
      for (const e of root) if (e.type === 'blob' && GUARDED_ROOT_FILES.includes(e.path)) out[e.path] = e.sha;
      const dotGithub = root.find((e) => e.path === '.github' && e.type === 'tree');
      const workflows = dotGithub ? (await list(dotGithub.sha)).find((e) => e.path === 'workflows' && e.type === 'tree') : null;
      if (workflows) for (const e of await list(workflows.sha)) out[`.github/workflows/${e.path}`] = e.type === 'blob' ? e.sha : `${e.type}`;
      return out;
    },

    // Raw bytes of one file, by its blob sha (from listForecasts).
    async readBlob(sha) {
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('invalid blob sha');
      const blob = await github.call('GET', `${base}/git/blobs/${sha}`);
      if (blob.json?.encoding !== 'base64' || typeof blob.json.content !== 'string') {
        throw new Error('unexpected blob encoding');
      }
      return Buffer.from(blob.json.content, 'base64');
    },
  };
}
