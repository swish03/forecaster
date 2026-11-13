// A complete fake world for the tick: GitHub (public + data repo), Metaculus
// and the routine endpoint, with a movable clock. No network.

import { readFileSync } from 'node:fs';

import { runTick } from '../../poster/tick.mjs';
import { FakeGitHub, FakeMetaculus, FakeRoutine, TOKENS, gitBlobSha, makeFetch } from './fakes.mjs';
import { NOW, forecastFile, minutes, postWith, questionFor } from './fixtures.mjs';

// The real config, with no pause between Metaculus requests.
export const REAL_CONFIG = { ...JSON.parse(readFileSync(new URL('../../poster/config.json', import.meta.url), 'utf8')), request_spacing_ms: 0 };
// The default world switches the 30-minute batch hold off, so tests about
// posting and refiring see a wake-up on the first tick. The hold itself is
// tested with REAL_CONFIG in test/firing-budget.test.mjs.
export const CONFIG = { ...REAL_CONFIG, firing: { ...REAL_CONFIG.firing, batch_hold_minutes: 0 } };
export const PUBLIC = 'OWNER_GITHUB_USER/forecaster';
export const DATA = 'OWNER_GITHUB_USER/forecaster-data';

// The files of the data repository that the tick guards (data_repo_changed),
// with stand-in contents, and the matching ops/data-template.json.
export const GUARDED = {
  'bootstrap.mjs': '// bootstrap stand-in\n',
  'CLAUDE.md': '# rules stand-in\n',
  '.github/workflows/notify.yml': 'name: notify\n',
};
export const DATA_TEMPLATE = JSON.stringify({
  schema: 1,
  files: Object.fromEntries(Object.entries(GUARDED).map(([p, t]) => [p, gitBlobSha(Buffer.from(t))])),
});
const REAL_METHOD = readFileSync(new URL('../../agent/method.json', import.meta.url), 'utf8');

export function world({ config = CONFIG, expiryText = '' } = {}) {
  const github = new FakeGitHub();
  github.addRepo(PUBLIC, { readToken: null, writeToken: TOKENS.workflow });
  github.addRepo(DATA, { readToken: TOKENS.data, writeToken: 'agent-push' });
  github.commitFiles(DATA, 'main', { 'README.md': 'data repo', ...GUARDED });
  // The public repository's main: the tick refuses to run any other commit.
  const mainSha = github.commitFiles(PUBLIC, 'main', { 'README.md': 'forecaster' });
  const metaculus = new FakeMetaculus();
  const routine = new FakeRoutine();
  const env = {
    METACULUS_TOKEN: TOKENS.metaculus,
    DATA_REPO_TOKEN: TOKENS.data,
    DATA_REPO: DATA,
    GITHUB_TOKEN: TOKENS.workflow,
    GITHUB_REPOSITORY: PUBLIC,
    ROUTINE_FIRE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire',
    ROUTINE_FIRE_TOKEN: TOKENS.fire,
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: mainSha,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
  };
  const lines = [];
  const w = {
    github, metaculus, routine, env, lines, clock: NOW, posts: new Map(), expiryText, mainSha,
    files: { 'ops/data-template.json': DATA_TEMPLATE, 'agent/method.json': REAL_METHOD },
    run: (opts = {}) => runTick({
      config, profileName: 'live', env, fetch: makeFetch({ github, metaculus, routine }),
      now: () => w.clock, sleep: async () => {}, write: (l) => lines.push(l),
      readRepoFile: async (path) => {
        if (path === 'ops/EXPIRY.md') return w.expiryText;
        if (path in w.files) return w.files[path];
        throw new Error(`no file ${path}`);
      },
      ...opts,
    }),
    open(kind, id, closeInMinutes = 150, tournament = '33121') {
      const raw = questionFor(kind, id, w.clock + minutes(closeInMinutes));
      const post = postWith(raw);
      metaculus.addPost(post, [tournament]);
      w.posts.set(id, { raw, post });
      return raw;
    },
    // A post with several questions (group or conditional): registers each one.
    openPost(post, questions, tournament = '33121') {
      metaculus.addPost(post, [tournament]);
      for (const raw of questions) w.posts.set(raw.id, { raw, post });
      return post;
    },
    // name: the file name inside forecasts/ (default <id>.json).
    writeForecast(id, overrides = {}, name = `${id}.json`) {
      const { raw, post } = w.posts.get(id);
      const file = forecastFile(raw, post.id, { created_at: new Date(w.clock - minutes(5)).toISOString(), ...overrides });
      github.commitFiles(DATA, 'main', { [`forecasts/${name}`]: JSON.stringify(file) });
      return file;
    },
    state(name) {
      const text = github.readFile(PUBLIC, 'state', name);
      return text ? JSON.parse(text) : undefined;
    },
    forecastWrites: () => metaculus.writes.filter((x) => x.path.startsWith('/api/questions/')),
    issues: () => github.repos.get(PUBLIC).issues,
  };
  return w;
}

