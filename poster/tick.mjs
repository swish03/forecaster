// The tick: run by .github/workflows/tick.yml whenever a clock starts it
// (ops/CLOCK.md: an outside 15-minute clock, a push to the data repo, and
// GitHub's own schedule as a backup).
//   1. Post new, valid forecast files from the private data repo (soonest
//      deadline first; the questions of one post go together in one request).
//   2. Record questions we sent that closed without any forecast file ("missed").
//   3. List open questions not yet forecast and wake the agent once for them
//      (new questions with plenty of time are held briefly so they go out
//      together; a daily budget caps the number of wake-ups).
//   4. Housekeeping: weekly keep-alive of the schedule, a daily check of the
//      clock, token expiry dates, and the one alert issue for the owner.
// Logs are public (public repo), so they show question ids, status codes and
// problem codes only: never question text, forecast values, private repo
// names, response bodies, URLs with secrets, or tokens.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { HttpError, NetworkError, defaultSleep } from '../lib/http.mjs';
import { publicProblemCodes, questionProblems, validateForecastFile } from '../lib/schema.mjs';
import { createMetaculusClient, isOpenAt, questionsOfPost } from './metaculus.mjs';
import { createGitHubClient } from './github.mjs';
import { createDataRepo } from './data-repo.mjs';
import { createStateStore } from './state.mjs';
import { assertFireUrl, buildFireTexts, fireRoutine } from './fire.mjs';
import { measureSchedule } from './measure-schedule.mjs';
import { checkEnvironment, compareGuardedFiles, dedupeProblems, expiringTokens, keepAlive, syncAlertIssue } from './ops.mjs';

const SECRET_NAMES = ['METACULUS_TOKEN', 'ROUTINE_FIRE_URL', 'ROUTINE_FIRE_TOKEN', 'DATA_REPO_TOKEN', 'GITHUB_TOKEN'];
// Final for the file it names. 'invalid' on the first file still lets the
// agent send one replacement (forecasts/<id>.r2.json) after a second fire.
const FINAL = new Set(['posted', 'rejected', 'invalid', 'late', 'not_sent', 'already_forecast', 'missed', 'unconfirmed', 'skipped_unforecast']);
// Waiting for a later tick: the API is asked first before any new attempt.
const PENDING = new Set(['in_flight', 'unknown', 'retry', 'forbidden']);
// A checked file of a group post that waits for its siblings. Like PENDING,
// its hash is recorded, so a changed file is refused (file_changed).
const WAITING = new Set([...PENDING, 'held']);
// Records that keep the run red for posting.alert_window_hours.
const NEEDS_ATTENTION = new Set(['invalid', 'rejected', 'late', 'not_sent', 'unconfirmed', 'missed', 'skipped_unforecast']);
// Questions that closed with no forecast from the bot (they score zero).
const LOST = new Set(['missed', 'skipped_unforecast', 'late']);

class SetupError extends Error {}
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// Replaces any secret value that slips into a message with ***, and control
// characters with spaces, so no text can start a GitHub workflow command.
function makeLogger(write, secrets) {
  return (message) => {
    let text = String(message);
    for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join('***');
    write(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' '));
  };
}

// Error text for public logs: which service and route, and the status code.
// Repo names, ids, shas, query strings and response bodies are left out.
function makeDescriber(repoLabels) {
  const route = (path) => {
    const clean = String(path ?? '').split('?')[0];
    const repo = clean.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (repo) {
      const rest = (repo[2] ?? '').replace(/\/[0-9a-f]{7,64}(?=\/|$)/g, '/:sha');
      return `${repoLabels[repo[1]] ?? 'github'} ${rest}`;
    }
    return `metaculus ${clean.replace(/\/\d+(?=\/|$)/g, '/:id')}`;
  };
  return (error) => {
    if (error instanceof HttpError) return `${error.method} ${route(error.path)} -> HTTP ${error.status}`;
    if (error instanceof NetworkError) return `${error.method} ${route(error.path)} -> ${error.reachedServer ? 'timeout or reset' : 'not reachable'}`;
    return error?.message ?? String(error);
  };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deadlineMs = (q) => Date.parse(q.deadline) || Infinity;

// The two most recent MiniBench round starts as dated slugs. The outgoing
// round is renamed minibench-YYYY-MM-DD while the next one runs (spec 3.3).
export function datedRoundSlugs(rounds, nowMs) {
  const first = Date.parse(`${rounds.first_monday}T00:00:00Z`);
  const step = rounds.every_days * 86400000;
  if (!Number.isFinite(first) || !(step > 0) || nowMs < first) return [];
  const latest = first + Math.floor((nowMs - first) / step) * step;
  return Array.from({ length: rounds.count }, (_, i) => latest - i * step)
    .filter((ms) => ms >= first)
    .map((ms) => `${rounds.slug_prefix}${new Date(ms).toISOString().slice(0, 10)}`);
}

function tournamentsOf(profile, nowMs) {
  const dated = profile.dated_rounds ? datedRoundSlugs(profile.dated_rounds, nowMs) : [];
  return [...profile.tournaments, ...dated.map((slug) => ({ slug, optional: true }))];
}

function createContext({ config, profileName, dryRun, env, fetch, now, sleep, readRepoFile }) {
  const profile = config.profiles?.[profileName];
  if (!profile || !Array.isArray(profile.tournaments) || !profile.tournaments.length) {
    throw new SetupError(`unknown or empty profile "${profileName}"`);
  }
  // The GitHub concurrency group is what keeps two ticks apart, so live runs
  // happen only inside Actions unless the owner says otherwise on purpose.
  if (!dryRun && env.GITHUB_ACTIONS !== 'true' && env.TICK_ALLOW_LOCAL !== 'yes') {
    throw new SetupError('live runs only inside GitHub Actions (use --dry-run, or set TICK_ALLOW_LOCAL=yes after stopping the workflow)');
  }
  const required = ['METACULUS_TOKEN', 'DATA_REPO_TOKEN', 'DATA_REPO', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'];
  if (!dryRun) required.push('ROUTINE_FIRE_URL', 'ROUTINE_FIRE_TOKEN');
  // A live run inside Actions must know which commit it runs, to refuse
  // re-runs of old runs and runs of any branch but main (checkFreshCode).
  const liveInActions = !dryRun && env.GITHUB_ACTIONS === 'true';
  if (liveInActions) required.push('GITHUB_SHA', 'GITHUB_REF');
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new SetupError(`missing environment variables: ${missing.join(', ')}`);
  if (!dryRun) assertFireUrl(env.ROUTINE_FIRE_URL, config.routine_fire_url_prefix);
  if (env.GITHUB_SHA && !SHA_PATTERN.test(env.GITHUB_SHA)) throw new SetupError('GITHUB_SHA is not a commit id');

  const timeoutMs = config.timeout_ms;
  const metaculus = createMetaculusClient({
    baseUrl: config.metaculus_base_url, token: env.METACULUS_TOKEN, fetch, timeoutMs, spacingMs: config.request_spacing_ms, sleep, now,
  });
  const dataGitHub = createGitHubClient({ apiUrl: config.github_api_url, token: env.DATA_REPO_TOKEN, label: 'DATA_REPO_TOKEN', fetch, timeoutMs, sleep });
  const stateGitHub = createGitHubClient({ apiUrl: config.github_api_url, token: env.GITHUB_TOKEN, label: 'GITHUB_TOKEN', fetch, timeoutMs, sleep });
  return {
    config,
    profile,
    profileName,
    // Profile settings may narrow the firing rules (the test profile has its own small budget).
    firing: { ...config.firing, ...(profile.firing ?? {}) },
    dryRun,
    liveInActions,
    sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1) || 1,
    // The kit the agent must use for questions first sent by this tick.
    kitRef: env.GITHUB_SHA && SHA_PATTERN.test(env.GITHUB_SHA) ? env.GITHUB_SHA : null,
    now,
    describe: makeDescriber({ [env.DATA_REPO]: 'data repo', [env.GITHUB_REPOSITORY]: 'state' }),
    metaculus,
    dataRepo: createDataRepo({ github: dataGitHub, repo: env.DATA_REPO, branch: config.data_repo_branch }),
    store: createStateStore({ github: stateGitHub, repo: env.GITHUB_REPOSITORY, branch: config.state_branch }),
    dataTokenExpiresOn: dataGitHub.tokenExpiresOn,
    publicRepo: env.GITHUB_REPOSITORY,
    publicGitHub: stateGitHub,
    inActions: env.GITHUB_ACTIONS === 'true',
    runUrl: env.GITHUB_RUN_ID && /^\d+$/.test(env.GITHUB_RUN_ID)
      ? `${/^https:\/\/[A-Za-z0-9.-]+$/.test(env.GITHUB_SERVER_URL ?? '') ? env.GITHUB_SERVER_URL : 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null,
    readRepoFile,
    fire: (text) => fireRoutine({
      url: env.ROUTINE_FIRE_URL, token: env.ROUTINE_FIRE_TOKEN, version: config.routine_api_version, beta: config.routine_beta, text,
      fetch, timeoutMs, sleep, now, maxWaitMs: config.firing.max_wait_seconds * 1000,
    }),
  };
}

function newSummary() {
  return { statuses: {}, fired: [], skipped: [], missed: [], errors: [], attention: [], wouldPost: [], wouldFire: [], held: [], problems: [] };
}

// A live run refuses to do anything when its code is not main's newest
// commit, or when it is a re-run. GitHub re-runs an old run with that run's
// old commit and today's secrets, so an old run must never post or fire.
// Returns null when fine, else { exitCode, reason }.
export async function checkFreshCode(ctx) {
  if (!ctx.liveInActions) return null;
  if (ctx.ref !== 'refs/heads/main') return { exitCode: 2, reason: 'this run is not on main' };
  if (ctx.runAttempt > 1) return { exitCode: 2, reason: `this is re-run attempt ${ctx.runAttempt}; re-runs never post or fire (start a new run instead)` };
  const head = await ctx.publicGitHub.call('GET', `/repos/${ctx.publicRepo}/git/ref/heads/main`);
  if (head.json?.object?.sha !== ctx.sha) return { exitCode: 1, reason: 'main has moved on since this run was started; a newer tick will do the work' };
  return null;
}

function note(summary, status, questionId) {
  (summary.statuses[status] ??= []).push(questionId);
}

const overBudget = (run) => run.now() - run.startedMs > run.config.posting.time_budget_seconds * 1000;

// A 401 or 404 from Metaculus means the key or an address is wrong: the owner
// must fix it, so it goes to the alert issue.
function noteMetaculusSetup(run, error) {
  if (error instanceof HttpError && [401, 404].includes(error.status) && !String(error.path).startsWith('/repos/')) {
    run.alerts.push({ code: 'metaculus_setup', detail: `HTTP ${error.status}` });
  }
}

// ---- step 1: post forecasts -------------------------------------------------

// Which file of a question to look at now: { file } (or {} for none), or
// { unrequested } for a replacement file the tick never asked for.
//  - never sent: the first file found, which then gets 'not_sent';
//  - sent only as a replacement (a file existed before the question was ever
//    sent, entry.only_r2): only <id>.r2.json counts;
//  - waiting (pending or held): the same revision as before;
//  - the first file refused: the replacement, once the tick asked for it.
export function fileToCheck(record, byRevision, entry) {
  if (!entry) return { file: record ? null : byRevision.get(1) ?? byRevision.get(2) ?? null };
  if (!record || record.status === 'not_sent') return { file: byRevision.get(entry.only_r2 ? 2 : 1) ?? null };
  if (WAITING.has(record.status)) return { file: byRevision.get(record.revision ?? 1) ?? null };
  if (record.status === 'invalid' && (record.revision ?? 1) === 1 && byRevision.has(2)) {
    return entry.r2_requested_at ? { file: byRevision.get(2) } : { unrequested: byRevision.get(2) };
  }
  return { file: null };
}

async function loadCandidates(run, files) {
  const maxBytes = run.config.posting.max_file_bytes;
  const byQuestion = new Map();
  for (const f of files) {
    if (!byQuestion.has(f.questionId)) byQuestion.set(f.questionId, new Map());
    byQuestion.get(f.questionId).set(f.revision, f);
  }
  const records = {};
  const loaded = [];
  for (const [qid, byRevision] of byQuestion) {
    const choice = fileToCheck(run.state.posted[qid], byRevision, run.state.fired[qid]);
    if (choice.unrequested) {
      records[qid] = { status: 'invalid', at: run.iso, hash: null, revision: 2, problems: ['not_requested'] };
      continue;
    }
    const f = choice.file;
    if (!f) continue;
    const invalid = (problems, hash = null) => ({ status: 'invalid', at: run.iso, hash, revision: f.revision, problems });
    if (f.size > maxBytes) {
      records[qid] = invalid(['file_too_large']);
      continue;
    }
    let bytes;
    try {
      bytes = await run.dataRepo.readBlob(f.sha);
    } catch (error) {
      run.summary.errors.push(`read_failed:${qid}`);
      run.log(`question ${qid}: could not read forecast file (${run.describe(error)})`);
      continue;
    }
    const hash = sha256(bytes);
    try {
      loaded.push({ qid, revision: f.revision, file: JSON.parse(bytes.toString('utf8')), hash });
    } catch {
      records[qid] = invalid(['json_parse'], hash);
    }
  }
  return { records, loaded };
}

// Decides what to do with one forecast file: a final record, or ready to post.
async function checkCandidate(run, { qid, revision, file, hash }) {
  const cfg = run.config.posting;
  const prior = run.state.posted[qid];
  const entry = run.state.fired[qid];
  const pending = PENDING.has(prior?.status);
  const final = (status, extra = {}) => ({ record: { status, at: run.iso, hash, revision, ...extra } });

  if (!entry) {
    run.alerts.push({ code: 'unsent_file', detail: String(qid) });
    return final('not_sent');
  }
  // Write-once: a file waiting for a later tick must stay exactly the file
  // first checked. A changed file is never posted.
  if (WAITING.has(prior?.status) && prior.hash && (prior.revision ?? 1) === revision && prior.hash !== hash) {
    return final('invalid', { problems: ['file_changed'] });
  }
  if (!file || typeof file !== 'object' || file.question_id !== qid) return final('invalid', { problems: ['question_id_mismatch'] });
  if (!Number.isInteger(file.post_id)) return final('invalid', { problems: ['post_id_missing'] });
  if (entry.tournament && file.tournament !== entry.tournament) return final('invalid', { problems: ['tournament_mismatch'] });
  // The file must come from the method version fixed at the first wake-up.
  if (entry.method_version && file.method_version !== entry.method_version) return final('invalid', { problems: ['method_version_mismatch'] });

  let post;
  try {
    post = await run.metaculus.getPost(file.post_id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return final('invalid', { problems: ['post_not_found'] });
    throw error;
  }
  const siblings = questionsOfPost(post).questions;
  const question = siblings.find((q) => q.question_id === qid);
  if (!question) return final('invalid', { problems: ['post_mismatch'] });

  if (question.already_forecast) {
    return pending
      ? final('posted', { posted_at: prior.at, http: prior.http ?? null, attempts: prior.attempts, confirmed_by: 'api' })
      : final('already_forecast');
  }
  if (!question.deadline) return final('invalid', { problems: ['no_close_time'] });
  if (!isOpenAt(question, run.nowMs, cfg.close_margin_seconds * 1000)) return final('late');
  if (pending && (prior.attempts ?? 0) >= cfg.max_post_attempts) return final('unconfirmed', { attempts: prior.attempts });
  // After an unclear answer, Metaculus's own record may lag behind. Wait at
  // least one clock period before sending again.
  if (prior?.status === 'unknown' && run.nowMs - Date.parse(prior.at) < cfg.unknown_retry_after_minutes * 60000) return { wait: true };

  const problems = validateForecastFile(file, question, { limits: run.config.limits, nowMs: run.nowMs });
  if (problems.length) return final('invalid', { problems: publicProblemCodes(problems.map((p) => p.code)) });
  return {
    ready: {
      qid, revision, file, hash, question, siblings, prior: prior ?? null,
      attempts: (prior?.attempts ?? 0) + 1, forbidden: prior?.forbidden ?? 0,
    },
  };
}

// Groups ready files by post. A group or conditional post waits until every
// open, unforecast question of it has a ready file, unless its deadline is near.
// A sibling whose first file was refused still counts as "coming" while
// its replacement can be (or was) asked for, so the group waits for it.
function replacementComing(run, id, record) {
  const entry = run.state.fired[id];
  return record?.status === 'invalid' && (record.revision ?? 1) === 1 && Boolean(entry)
    && (Boolean(entry.r2_requested_at) || entry.count < run.firing.max_fires_per_question);
}

function postBatches(run, ready, records) {
  const holdMinutes = run.config.posting.group_hold_until_minutes_left;
  const byPost = new Map();
  for (const r of ready) {
    if (!byPost.has(r.file.post_id)) byPost.set(r.file.post_id, []);
    byPost.get(r.file.post_id).push(r);
  }
  const batches = [];
  for (const [postId, items] of byPost) {
    const readyIds = new Set(items.map((r) => r.qid));
    const finalStatus = (id) => {
      const record = records[id] ?? run.state.posted[id];
      return FINAL.has(record?.status) && !replacementComing(run, id, record);
    };
    const waitingFor = items[0].siblings
      .filter((q) => q.status === 'open' && !q.already_forecast && !readyIds.has(q.question_id) && !finalStatus(q.question_id))
      .map((q) => q.question_id);
    const minutesLeft = (Math.min(...items.map((r) => deadlineMs(r.question))) - run.nowMs) / 60000;
    if (waitingFor.length && minutesLeft > holdMinutes) {
      run.log(`post ${postId}: holding ${[...readyIds].join(', ')} until ${waitingFor.join(', ')} also have files`);
      // The held file's hash is recorded now, so it cannot be swapped later.
      for (const r of items) {
        if (r.prior?.status === 'held' && r.prior.hash === r.hash) continue;
        records[r.qid] = { status: 'held', at: run.iso, hash: r.hash, revision: r.revision };
      }
      continue;
    }
    if (waitingFor.length) run.log(`post ${postId}: deadline near, posting ${[...readyIds].join(', ')} without ${waitingFor.join(', ')}`);
    batches.push({ postId, items, deadline: Math.min(...items.map((r) => deadlineMs(r.question))) });
  }
  return batches.sort((a, b) => a.deadline - b.deadline || a.postId - b.postId);
}

function resultRecord(r, result, iso, maxForbidden) {
  const base = { hash: r.hash, revision: r.revision, http: result.http };
  switch (result.outcome) {
    case 'posted':
      return { status: 'posted', posted_at: iso, attempts: r.attempts, ...base };
    case 'rejected':
      return { status: 'rejected', at: iso, attempts: r.attempts, ...base };
    case 'forbidden': {
      const forbidden = r.forbidden + 1;
      const status = forbidden >= maxForbidden ? 'rejected' : 'forbidden';
      return { status, at: iso, attempts: r.attempts - 1, forbidden, ...base };
    }
    case 'retry':
    case 'setup_error':
      // Nothing was saved, so this does not use up an attempt.
      return { status: 'retry', at: iso, attempts: r.attempts - 1, forbidden: r.forbidden, ...base };
    default:
      return { status: 'unknown', at: iso, attempts: r.attempts, forbidden: r.forbidden, ...base };
  }
}

async function postPhase(run, files) {
  const { records, loaded } = await loadCandidates(run, files);
  const ready = [];
  for (const candidate of loaded) {
    if (overBudget(run)) {
      run.log(`time budget used: question ${candidate.qid} and later files wait for the next tick`);
      break;
    }
    let decision;
    try {
      decision = await checkCandidate(run, candidate);
    } catch (error) {
      noteMetaculusSetup(run, error);
      run.summary.errors.push(`check_failed:${candidate.qid}`);
      run.log(`question ${candidate.qid}: check failed, will try next tick (${run.describe(error)})`);
      continue;
    }
    if (decision.record) records[candidate.qid] = decision.record;
    else if (decision.ready) ready.push(decision.ready);
    else run.log(`question ${candidate.qid}: unclear earlier answer, waiting before a new attempt`);
  }
  for (const [qid, record] of Object.entries(records)) {
    note(run.summary, record.status, Number(qid));
    run.log(`question ${qid}: ${record.status}${record.problems ? ` (${record.problems.join(', ')})` : ''}`);
  }
  const batches = postBatches(run, ready, records);

  if (run.dryRun) {
    for (const r of batches.flatMap((b) => b.items)) {
      run.summary.wouldPost.push(r.qid);
      run.log(`question ${r.qid}: dry run, would post (${r.question.type})`);
    }
    return;
  }

  await run.commit((s) => {
    Object.assign(s.posted, records);
    return s;
  }, 'tick: forecast checks');

  // Each batch is claimed with its own state commit just before its POST.
  // The claim only succeeds if the records are still what this tick checked,
  // so two overlapping ticks can never both post the same question.
  let results = {};
  const save = async (claim, message) => {
    let claimed = false;
    const finished = results;
    await run.commit((s) => {
      Object.assign(s.posted, finished);
      claimed = Boolean(claim) && claim.items.every((r) => sameRecord(s.posted[r.qid] ?? null, r.prior));
      if (claimed) {
        for (const r of claim.items) {
          s.posted[r.qid] = { status: 'in_flight', at: run.iso, hash: r.hash, revision: r.revision, attempts: r.attempts, forbidden: r.forbidden };
        }
      }
      return s;
    }, message);
    results = {};
    return claimed;
  };

  for (const batch of batches) {
    if (overBudget(run)) {
      run.log(`time budget used: ${batch.items.map((r) => r.qid).join(', ')} wait for the next tick`);
      break;
    }
    // The deadline is checked again right before sending: earlier batches and
    // state commits take time, and a question may have closed meanwhile.
    const margin = run.config.posting.close_margin_seconds * 1000;
    const nowMs = run.now();
    for (const r of batch.items.filter((x) => !isOpenAt(x.question, nowMs, margin))) {
      results[r.qid] = { status: 'late', at: new Date(nowMs).toISOString(), hash: r.hash, revision: r.revision };
      note(run.summary, 'late', r.qid);
      run.log(`question ${r.qid}: late (deadline passed before it could be sent)`);
    }
    batch.items = batch.items.filter((x) => isOpenAt(x.question, nowMs, margin));
    if (!batch.items.length) continue;
    const ids = batch.items.map((r) => r.qid).join(', ');
    if (!(await save(batch, `tick: claim ${ids}`))) {
      run.summary.errors.push(`claim_lost:${batch.postId}`);
      run.log(`post ${batch.postId}: state changed under this tick, not posting ${ids}`);
      continue;
    }
    let result;
    try {
      result = await run.metaculus.submitForecasts({
        postId: batch.postId,
        items: batch.items.map((r) => ({ questionId: r.qid, type: r.question.type, forecast: r.file.forecast, options: r.question.options })),
        comments: batch.items.map((r) => r.file.comment),
      });
    } catch (error) {
      result = { outcome: 'unknown', http: null };
      run.log(`post ${batch.postId}: post failed (${run.describe(error)})`);
    }
    const iso = new Date(run.now()).toISOString();
    for (const r of batch.items) {
      results[r.qid] = resultRecord(r, result, iso, run.config.posting.max_forbidden_attempts);
      note(run.summary, results[r.qid].status, r.qid);
    }
    if (result.outcome !== 'posted') run.summary.errors.push(`post_${result.outcome}:${batch.postId}`);
    run.log(`question ${ids}: post ${result.outcome} (HTTP ${result.http ?? 'none'})`);
    if (result.outcome === 'setup_error') {
      run.alerts.push({ code: 'metaculus_setup', detail: `HTTP ${result.http}` });
      run.log('posting stopped: the Metaculus token or endpoint was refused; check METACULUS_TOKEN and the API path');
      break;
    }
  }
  if (Object.keys(results).length) await save(null, 'tick: forecast results');
}

// ---- step 2: missed questions ----------------------------------------------

// A question that has a file but no record is left to postPhase (it becomes
// 'late' once it can be checked), so a read error is never logged as "missed".
async function missedPhase(run, files) {
  // A question sent only as a replacement (only_r2) needs its .r2 file.
  const hasFile = (qid, entry) => files.some((f) => f.questionId === qid && (!entry.only_r2 || f.revision === 2));
  const missed = Object.entries(run.state.fired)
    .filter(([qid, entry]) => {
      const record = run.state.posted[qid];
      const open = !record || (record.status === 'not_sent' && entry.only_r2);
      return open && !hasFile(Number(qid), entry) && entry.closes_at && Date.parse(entry.closes_at) < run.nowMs;
    })
    .map(([qid]) => Number(qid));
  if (!missed.length) return;
  run.summary.missed.push(...missed);
  for (const qid of missed) run.log(`question ${qid}: MISSED (closed with no forecast file)`);
  await run.commit((s) => {
    for (const qid of missed) s.posted[qid] = { status: 'missed', at: run.iso, hash: null };
    return s;
  }, 'tick: record missed questions');
}

// ---- step 3: discover and fire ---------------------------------------------

async function discover(run, botUserId) {
  const found = new Map();
  for (const t of tournamentsOf(run.profile, run.nowMs)) {
    let posts;
    try {
      posts = await run.metaculus.listOpenPosts({ tournament: t.id ?? t.slug, notForecasterId: botUserId, optional: t.optional === true });
    } catch (error) {
      noteMetaculusSetup(run, error);
      run.summary.errors.push(`list_failed:${t.slug}`);
      run.log(`tournament ${t.slug}: listing failed (${run.describe(error)})`);
      continue;
    }
    for (const post of posts) {
      const { questions, skipped } = questionsOfPost(post);
      for (const s of skipped) {
        run.summary.skipped.push({ post_id: s.post_id, reason: s.reason });
        if (s.reason !== 'not_a_question') {
          run.summary.errors.push(`unforecastable_post:${s.post_id}`);
          run.log(`post ${s.post_id}: cannot be forecast (${s.reason})`);
        }
      }
      for (const q of questions) if (!found.has(q.question_id)) found.set(q.question_id, { ...q, tournament: t.slug });
    }
  }
  return [...found.values()];
}

// Returns { attempt, revision } to fire, or { reason } to skip
// (with unforecast: true when the question will now close with no forecast).
function fireDecision(run, q, filesByQuestion) {
  const cfg = run.firing;
  if (q.status !== 'open') return { reason: 'not_open' };
  if (q.already_forecast) return { reason: 'already_forecast' };
  const problems = questionProblems(q);
  if (!q.deadline) problems.push({ code: 'deadline_missing' });
  if (problems.length) return { reason: `question_incomplete:${problems[0].code}` };

  const minutesLeft = (deadlineMs(q) - run.nowMs) / 60000;
  const entry = run.state.fired[q.question_id];
  const record = run.state.posted[q.question_id];
  const revisions = filesByQuestion?.get(q.question_id);
  // A forecast file appeared before the question was ever sent. It never
  // counts, and it must not block the question: send the question as a
  // replacement request, so only a new <id>.r2.json can be posted.
  if (record?.status === 'not_sent' && !entry) {
    if (!filesByQuestion) return { reason: 'data_repo_unknown' };
    if (revisions?.has(2)) return { reason: 'unsent_files_block', unsentFiles: true };
    return minutesLeft >= cfg.first_fire_min_minutes_left
      ? { attempt: 1, revision: 2, onlyR2: true, previousProblems: ['file_before_request'] }
      : { reason: 'closing_too_soon' };
  }
  if (record) {
    // The first file was refused: one more fire asks the agent for a replacement.
    const canReplace = record.status === 'invalid' && (record.revision ?? 1) === 1 && entry
      && entry.count < cfg.max_fires_per_question && filesByQuestion && !revisions?.has(2);
    if (!canReplace) return { reason: 'has_post_record' };
    if (minutesLeft < cfg.refire_min_minutes_left) return { reason: 'closing_too_soon' };
    return { attempt: entry.count + 1, revision: 2, previousProblems: record.problems ?? [] };
  }
  if (revisions?.size) return { reason: 'forecast_file_exists' };

  // Never sent and too close to its deadline: it will close with no forecast.
  if (!entry) return minutesLeft >= cfg.first_fire_min_minutes_left ? { attempt: 1, revision: 1 } : { reason: 'closing_too_soon', unforecast: true };
  if (entry.count >= cfg.max_fires_per_question) return { reason: 'fired_max' };
  if (!filesByQuestion) return { reason: 'data_repo_unknown' };
  if ((run.nowMs - Date.parse(entry.first_fired_at)) / 60000 < cfg.refire_after_minutes) return { reason: 'waiting_for_agent' };
  if (minutesLeft < cfg.refire_min_minutes_left) return { reason: 'closing_too_soon' };
  return { attempt: entry.count + 1, revision: entry.only_r2 ? 2 : 1, previousProblems: entry.only_r2 ? ['file_before_request'] : undefined };
}

function payloadItem(q, { attempt, revision, previousProblems }) {
  return {
    question_id: q.question_id,
    post_id: q.post_id,
    post_kind: q.post_kind,
    tournament: q.tournament,
    type: q.type,
    title: q.title,
    label: q.label,
    group_title: q.group_title,
    conditional: q.conditional,
    description: q.description,
    resolution_criteria: q.resolution_criteria,
    fine_print: q.fine_print,
    options: q.type === 'multiple_choice' ? q.options : null,
    unit: q.unit,
    range: q.scaling ? { ...q.scaling, cdf_points: (q.scaling.inbound_outcome_count ?? 200) + 1 } : null,
    open_time: q.open_time,
    scheduled_close_time: q.scheduled_close_time,
    deadline: q.deadline,
    scheduled_resolve_time: q.scheduled_resolve_time,
    attempt,
    revision,
    previous_file_problems: revision === 2 ? previousProblems ?? [] : null,
  };
}

// Questions found too late to send are recorded once, so the run goes red
// for them (a question that closes unforecast scores 0).
async function recordUnforecast(run, skips) {
  const fresh = skips.filter(({ q }) => !run.state.posted[q.question_id]);
  if (!fresh.length) return;
  for (const { q, reason } of fresh) {
    note(run.summary, 'skipped_unforecast', q.question_id);
    run.log(`question ${q.question_id}: WILL CLOSE UNFORECAST (${reason})`);
  }
  await run.commit((s) => {
    for (const { q, reason } of fresh) s.posted[q.question_id] = { status: 'skipped_unforecast', at: run.iso, hash: null, reason };
    return s;
  }, 'tick: record questions found too late');
}

// The live profile remembers when it last saw an open question it had not
// forecast yet. Days without one usually mean a wrong or missing tournament
// slug (ops/SEASONS.md), so that goes to the alert issue (no_live_questions).
async function noteLiveQuestions(run, found) {
  if (run.profileName !== 'live') return;
  const last = Date.parse(run.state.ops.live_seen_at ?? '');
  const stale = !Number.isFinite(last) || run.nowMs - last >= 3600000;
  if (!(found > 0 && stale) && Number.isFinite(last)) return;
  await run.commit((s) => {
    s.ops.live_seen_at = run.iso;
    return s;
  }, 'tick: note open questions seen');
}

async function firePhase(run, botUserId, files) {
  let filesByQuestion = null;
  if (files) {
    filesByQuestion = new Map();
    for (const f of files) {
      if (!filesByQuestion.has(f.questionId)) filesByQuestion.set(f.questionId, new Set());
      filesByQuestion.get(f.questionId).add(f.revision);
    }
  }
  let toFire = [];
  const unforecast = [];
  const found = await discover(run, botUserId);
  for (const q of found) {
    const decision = fireDecision(run, q, filesByQuestion);
    if (decision.reason) {
      run.summary.skipped.push({ question_id: q.question_id, reason: decision.reason });
      if (decision.unforecast) unforecast.push({ q, reason: decision.reason });
      if (decision.unsentFiles) run.alerts.push({ code: 'unsent_file', detail: String(q.question_id) });
      if (decision.reason.startsWith('question_incomplete:')) {
        run.summary.errors.push(`${decision.reason}:${q.question_id}`);
        run.log(`question ${q.question_id}: cannot be sent (${decision.reason})`);
      }
    } else toFire.push({ q, decision });
  }
  await noteLiveQuestions(run, found.length);
  await recordUnforecast(run, unforecast);
  toFire.sort((a, b) => deadlineMs(a.q) - deadlineMs(b.q));
  const perTick = run.firing.max_questions_per_tick;
  if (Number.isInteger(perTick) && perTick >= 0 && toFire.length > perTick) {
    run.log(`fire: profile ${run.profileName} sends at most ${perTick} question(s) per tick`);
    toFire = toFire.slice(0, perTick);
  }
  if (!toFire.length) {
    if (run.state.ops.hold_since) {
      await run.commit((s) => {
        delete s.ops.hold_since;
        return s;
      }, 'tick: clear batch hold');
    }
    run.log('fire: nothing new to send');
    return;
  }
  toFire = await holdFire(run, toFire);
  if (!toFire.length) return;
  const byId = new Map(toFire.map(({ q, decision }) => [q.question_id, { q, decision }]));

  // One wake-up uses one kit. A question keeps the kit of its first wake-up,
  // so its second wake-up or its replacement runs with the same method.
  const byKit = new Map();
  for (const item of toFire) {
    const kit = run.state.fired[item.q.question_id]?.kit_ref ?? run.kitRef;
    if (!byKit.has(kit)) byKit.set(kit, []);
    byKit.get(kit).push(item);
  }
  const texts = [];
  for (const [kitRef, items] of byKit) {
    const built = buildFireTexts(items.map(({ q, decision }) => payloadItem(q, decision)), {
      maxChars: run.config.firing.max_text_chars, sentAt: run.iso, kitRef,
    });
    for (const id of built.skipped) {
      run.summary.errors.push(`payload_too_large:${id}`);
      run.log(`question ${id}: too large for one fire text, not sent`);
    }
    texts.push(...built.texts);
  }
  const allowed = texts.slice(0, run.firing.max_fires_per_tick);
  if (texts.length > allowed.length) run.log(`fire: ${texts.length - allowed.length} part(s) left for the next tick`);
  if (!allowed.length) return;

  if (run.dryRun) {
    for (const chunk of allowed) {
      run.summary.wouldFire.push(...chunk.questionIds);
      run.log(`fire: dry run, would send ${chunk.questionIds.length} question(s) in ${chunk.text.length} characters: ${chunk.questionIds.join(', ')}`);
    }
    return;
  }

  // The fire is recorded before it is sent. If this tick dies after the
  // fire, the question still counts as sent, so the agent's file is accepted
  // and no second session is started by mistake.
  const before = new Map(allowed.flatMap((c) => c.questionIds).map((id) => [id, run.state.fired[id]]));
  await run.commit((s) => {
    for (const [id, prev] of before) {
      const { q, decision } = byId.get(id);
      const next = {
        first_fired_at: prev?.first_fired_at ?? run.iso,
        last_fired_at: run.iso,
        count: (prev?.count ?? 0) + 1,
        closes_at: q.deadline,
        tournament: prev?.tournament ?? q.tournament,
        kit_ref: prev?.kit_ref ?? run.kitRef,
        method_version: prev?.method_version ?? run.methodVersion,
        pending: true,
      };
      if (decision.onlyR2 || prev?.only_r2) next.only_r2 = true;
      const r2 = decision.revision === 2 ? run.iso : prev?.r2_requested_at;
      if (r2) next.r2_requested_at = r2;
      s.fired[id] = next;
    }
    return s;
  }, 'tick: fire intent');

  const sent = [];
  let sessions = 0;
  for (const chunk of allowed) {
    const result = await run.fire(chunk.text);
    run.log(`fire: ${result.outcome} (HTTP ${result.status ?? 'none'}) for ${chunk.questionIds.join(', ')}`);
    // A session may exist after 'unknown', so those questions count as sent;
    // the 60-minute second-fire rule covers the case where none started.
    if (result.outcome === 'fired' || result.outcome === 'unknown') {
      sent.push(...chunk.questionIds);
      sessions += 1;
    }
    if (result.outcome === 'rejected' && [400, 401, 403].includes(result.status)) {
      run.alerts.push({ code: 'wake_setup', detail: `HTTP ${result.status}` });
    }
    if (result.outcome === 'rate_limited') run.alerts.push({ code: 'wake_rate_limited', detail: 'HTTP 429' });
    if (result.outcome !== 'fired') {
      run.summary.errors.push(`fire_${result.outcome}`);
      if (result.outcome !== 'unknown') break;
    }
  }
  run.summary.fired.push(...sent);
  const sentSet = new Set(sent);
  const day = utcDay(run.nowMs);
  const key = fireCounterKey(run);
  await run.commit((s) => {
    for (const [id, prev] of before) {
      if (sentSet.has(id)) delete s.fired[id].pending;
      else if (prev) s.fired[id] = prev;
      else delete s.fired[id];
    }
    if (sessions) {
      const count = s.ops[key]?.day === day ? s.ops[key].count : 0;
      s.ops[key] = { day, count: count + sessions };
      delete s.ops.hold_since;
    }
    return s;
  }, 'tick: record fired questions');
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// The live profile counts in ops.fires; any other profile has its own
// counter, so a demo on the test profile never uses the live budget.
const fireCounterKey = (run) => (run.profileName === 'live' ? 'fires' : `fires_${run.profileName}`);

function firesToday(run) {
  const f = run.state.ops[fireCounterKey(run)];
  return f?.day === utcDay(run.nowMs) ? f.count : 0;
}

// Decides which questions to send now. Returns the ones to send (maybe none).
//  - Hard cap: after firing.daily_fire_hard_cap wake-ups today (UTC), none
//    at all: the subscription's own daily cap would refuse them anyway.
//  - Daily budget: after firing.daily_fire_budget wake-ups, a first wake-up
//    waits until some question would otherwise have under
//    over_budget_fire_if_minutes_left_under (120) minutes left; then every
//    open question goes in that one wake-up. Second wake-ups and replacement
//    requests are never held by the budget.
//  - Batch hold: when every question to send is new and has more than
//    batch_hold_if_minutes_left_over (120) minutes left, wait up to
//    batch_hold_minutes (30) so several questions go out in one wake-up.
async function holdFire(run, toFire) {
  const cfg = run.firing;
  const isNew = ({ decision }) => decision.attempt === 1 && decision.revision === 1;
  const ids = (list) => list.map(({ q }) => q.question_id);
  const minutesLeft = (list) => Math.min(...list.map(({ q }) => (deadlineMs(q) - run.nowMs) / 60000));
  const used = firesToday(run);
  if (cfg.daily_fire_hard_cap > 0 && used >= cfg.daily_fire_hard_cap) {
    run.summary.held.push(...ids(toFire));
    if (run.profileName === 'live') run.alerts.push({ code: 'wake_hard_cap', detail: `${utcDay(run.nowMs)}: ${used} wake-ups` });
    run.log(`fire: daily hard cap reached (${used} of ${cfg.daily_fire_hard_cap}); nothing is sent until 00:00 UTC: ${ids(toFire).join(', ')}`);
    return [];
  }
  if (cfg.daily_fire_budget > 0 && used >= cfg.daily_fire_budget) {
    const fresh = toFire.filter(isNew);
    if (!fresh.length || minutesLeft(fresh) < cfg.over_budget_fire_if_minutes_left_under) {
      if (fresh.length) run.log(`fire: daily budget used, but a question has under ${cfg.over_budget_fire_if_minutes_left_under} minutes left: sending every open question now`);
      return toFire;
    }
    const others = toFire.filter((x) => !isNew(x));
    run.summary.held.push(...ids(fresh));
    run.log(`fire: daily budget used (${used} of ${cfg.daily_fire_budget}); holding ${ids(fresh).join(', ')} until one has under ${cfg.over_budget_fire_if_minutes_left_under} minutes left`);
    return others;
  }
  if (!(cfg.batch_hold_minutes > 0)) return toFire;
  if (!toFire.every(isNew) || !(minutesLeft(toFire) > cfg.batch_hold_if_minutes_left_over)) return toFire;
  const since = Date.parse(run.state.ops.hold_since ?? '');
  if (!Number.isFinite(since)) {
    await run.commit((s) => {
      s.ops.hold_since ??= run.iso;
      return s;
    }, 'tick: start batch hold');
    run.summary.held.push(...ids(toFire));
    run.log(`fire: holding ${ids(toFire).join(', ')} for up to ${cfg.batch_hold_minutes} minutes so more questions can go in one wake-up`);
    return [];
  }
  const waited = (run.nowMs - since) / 60000;
  if (waited < cfg.batch_hold_minutes) {
    run.summary.held.push(...ids(toFire));
    run.log(`fire: still holding ${ids(toFire).join(', ')} (${Math.floor(waited)} of ${cfg.batch_hold_minutes} minutes)`);
    return [];
  }
  return toFire;
}


// ---- main ------------------------------------------------------------------

// Problem records from the last alert window keep the run red, so one green
// run cannot hide a question that was lost.
function recentProblems(run) {
  const since = run.nowMs - run.config.posting.alert_window_hours * 3600000;
  return Object.entries(run.state.posted)
    .filter(([, r]) => NEEDS_ATTENTION.has(r.status) && Date.parse(r.at) >= since)
    .map(([qid, r]) => `${qid}:${r.status}`);
}

// ---- step 4: housekeeping ---------------------------------------------------

// Each part is independent: a failure is logged and the others still run.
async function housekeeping(run) {
  const parts = [keepAlivePart, clockPart, expiryPart, dataRepoGuardPart, environmentPart];
  for (const part of parts) {
    try {
      await part(run);
    } catch (error) {
      run.summary.errors.push(`${part.label}_failed`);
      run.log(`${part.label}: failed (${run.describe(error)})`);
    }
  }
  try {
    await alertPart(run);
  } catch (error) {
    run.summary.errors.push('alert_failed');
    run.log(`alert: could not open or update the issue (${run.describe(error)})`);
  }
}

// Weekly: re-enable this workflow so GitHub never switches the schedule off
// after 60 days without activity (live runs inside Actions only).
async function keepAlivePart(run) {
  if (run.dryRun || !run.inActions) return;
  const at = await keepAlive({
    call: run.publicGitHub.call, repo: run.publicRepo, workflow: run.config.tick_workflow_file,
    nowMs: run.nowMs, last: run.state.ops.keepalive_at, everyDays: run.config.keepalive.enable_every_days,
  });
  if (!at) return;
  run.log('keep-alive: workflow enable call sent');
  await run.commit((s) => {
    s.ops.keepalive_at = at;
    return s;
  }, 'tick: weekly keep-alive');
}
keepAlivePart.label = 'keepalive';

// Daily: measure how often this workflow really ran in the last 48 hours.
async function clockPart(run) {
  const cfg = run.config.clock;
  const last = Date.parse(run.state.ops.clock_check?.at ?? '');
  if (Number.isFinite(last) && run.nowMs - last < cfg.measure_every_hours * 3600000) return;
  const report = await measureSchedule({
    get: async (path) => (await run.publicGitHub.call('GET', path)).json,
    repo: run.publicRepo, workflow: run.config.tick_workflow_file, nowMs: run.nowMs,
    hours: cfg.measure_window_hours, maxMedianMinutes: cfg.max_median_gap_minutes, minRuns: cfg.min_runs,
  });
  const check = {
    at: run.iso, runs: report.all.runs, median_minutes: report.all.median_minutes,
    p90_minutes: report.all.p90_minutes, max_minutes: report.all.max_minutes, verdict: report.verdict,
  };
  run.log(`clock: ${check.runs} runs in ${cfg.measure_window_hours} h, median gap ${check.median_minutes ?? '-'} min, p90 ${check.p90_minutes ?? '-'} min, longest ${check.max_minutes ?? '-'} min (${check.verdict})`);
  await run.commit((s) => {
    s.ops.clock_check = check;
    return s;
  }, 'tick: daily clock check');
}
clockPart.label = 'clock';

async function expiryPart(run) {
  const cfg = run.config.alerts;
  let text;
  try {
    text = await run.readRepoFile(cfg.expiry_file);
  } catch {
    run.log(`expiry: ${cfg.expiry_file} not found, skipped`);
    return;
  }
  for (const t of expiringTokens(text, run.nowMs, cfg.expiry_warn_days)) {
    run.alerts.push({ code: 'token_expiring', detail: `${t.token} ${t.expires}` });
    run.log(`expiry: ${t.token} expires ${t.expires} (${t.days_left} days)`);
  }
}
expiryPart.label = 'expiry';

// GitHub tells the expiry date of the plumbing token on every answer.
function dataTokenExpiry(run) {
  const day = run.dataTokenExpiresOn?.();
  if (!day) return;
  const daysLeft = Math.floor((Date.parse(`${day}T00:00:00Z`) - run.nowMs) / 86400000);
  if (!(daysLeft <= run.config.alerts.expiry_warn_days)) return;
  run.alerts.push({ code: 'token_expiring', detail: `DATA_REPO_TOKEN ${day}` });
  run.log(`expiry: DATA_REPO_TOKEN expires ${day} (${daysLeft} days, from GitHub's answer)`);
}

// The files that steer the agent (bootstrap.mjs, CLAUDE.md) and the data
// repository's workflows must be exactly the ones in ops/data-template.json.
// The agent can push to that repository, so a change there is shown to the
// owner at once (data_repo_changed). Only paths and counts are logged.
async function dataRepoGuardPart(run) {
  dataTokenExpiry(run);
  if (!run.dataRepoReadable) return;
  let expected;
  try {
    expected = JSON.parse(await run.readRepoFile(run.config.alerts.data_template_file));
  } catch {
    run.log(`data repo guard: ${run.config.alerts.data_template_file} not readable, skipped`);
    return;
  }
  const actual = await run.dataRepo.guardedFiles();
  const changed = compareGuardedFiles(expected?.files ?? {}, actual);
  if (!changed.length) return;
  run.alerts.push({ code: 'data_repo_changed', detail: `${changed.length} file(s)` });
  run.log(`data repo guard: ${changed.length} guarded file(s) differ from ${run.config.alerts.data_template_file}`);
}
dataRepoGuardPart.label = 'data_repo_guard';

// Daily: the metaculus environment must hand its keys to main only.
async function environmentPart(run) {
  if (run.dryRun || !run.inActions) return;
  const last = Date.parse(run.state.ops.environment_check?.at ?? '');
  const verdict = Number.isFinite(last) && run.nowMs - last < run.config.clock.measure_every_hours * 3600000
    ? run.state.ops.environment_check.verdict
    : null;
  let current = verdict;
  if (!current) {
    current = await checkEnvironment({ call: run.publicGitHub.call, repo: run.publicRepo, name: run.config.environment_name });
    run.log(`environment check: ${current}`);
    await run.commit((s) => {
      s.ops.environment_check = { at: run.iso, verdict: current };
      return s;
    }, 'tick: daily environment check');
  }
  if (current === 'unprotected') run.alerts.push({ code: 'environment_unprotected', detail: run.config.environment_name });
}
environmentPart.label = 'environment';

function collectProblems(run) {
  const cfg = run.config.alerts;
  const problems = [...run.alerts];
  const since = run.nowMs - cfg.missed_window_hours * 3600000;
  const lost = Object.entries(run.state.posted)
    .filter(([, r]) => LOST.has(r.status) && Date.parse(r.at) >= since)
    .map(([qid]) => Number(qid))
    .sort((a, b) => a - b);
  if (lost.length >= cfg.missed_threshold) problems.push({ code: 'missed_questions', detail: lost.join(', ') });
  const budget = run.firing.daily_fire_budget;
  if (run.profileName === 'live' && budget > 0 && firesToday(run) >= budget) problems.push({ code: 'fire_budget_reached', detail: `${utcDay(run.nowMs)}: ${firesToday(run)} of ${budget}` });
  const clock = run.state.ops.clock_check;
  if (clock?.verdict === 'too_slow') problems.push({ code: 'clock_slow', detail: `median gap ${clock.median_minutes} min` });
  const seen = Date.parse(run.state.ops.live_seen_at ?? '');
  const quietHours = (run.nowMs - seen) / 3600000;
  if (run.profileName === 'live' && Number.isFinite(seen) && quietHours >= cfg.no_live_questions_hours) {
    problems.push({ code: 'no_live_questions', detail: `none since ${run.state.ops.live_seen_at.slice(0, 10)}` });
  }
  return dedupeProblems(problems);
}

async function alertPart(run) {
  const problems = collectProblems(run);
  run.summary.problems.push(...problems);
  for (const p of problems) run.log(`problem for the owner: ${p.code}${p.detail ? ` (${p.detail})` : ''}`);
  const cfg = run.config.alerts;
  const { alert, action } = await syncAlertIssue({
    call: run.publicGitHub.call, repo: run.publicRepo, title: cfg.issue_title, problems,
    prev: run.state.ops.alert ?? null, nowMs: run.nowMs, healthyHours: cfg.healthy_hours_to_close,
    runUrl: run.runUrl, dryRun: run.dryRun, log: run.log,
  });
  if (action === 'none' || action === 'dry_run' || action === 'waiting') return;
  await run.commit((s) => {
    if (alert) s.ops.alert = alert;
    else delete s.ops.alert;
    return s;
  }, 'tick: alert issue');
}

async function tick(ctx, summary, log) {
  const run = { ...ctx, summary, log, nowMs: ctx.now(), state: null, alerts: [] };
  run.startedMs = run.nowMs;
  run.iso = new Date(run.nowMs).toISOString();
  const loaded = await ctx.store.load();
  run.state = { fired: loaded.fired, posted: loaded.posted, ops: loaded.ops ?? {} };
  run.commit = async (mutate, message) => {
    if (ctx.dryRun) {
      run.state = mutate(structuredClone(run.state));
      return;
    }
    const saved = await ctx.store.update(mutate, message);
    run.state = { fired: saved.fired, posted: saved.posted, ops: saved.ops ?? {} };
  };

  try {
    let me;
    try {
      me = await ctx.metaculus.getMe();
    } catch (error) {
      noteMetaculusSetup(run, error);
      throw error;
    }
    if (!Number.isInteger(me?.id)) throw new Error('could not read the bot user id from /users/me');

    run.methodVersion = await readMethodVersion(ctx);
    let files = null;
    try {
      files = await ctx.dataRepo.listForecasts();
      run.dataRepoReadable = true;
    } catch (error) {
      summary.errors.push('data_repo_unreadable');
      run.alerts.push({ code: 'data_repo_unreadable', detail: error instanceof HttpError ? `HTTP ${error.status}` : '' });
      log(`data repo: could not list forecasts (${run.describe(error)}); posting skipped this tick`);
    }
    if (files) {
      await postPhase(run, files);
      await missedPhase(run, files);
    }
    await firePhase(run, me.id, files);
  } finally {
    summary.attention.push(...recentProblems(run));
    await housekeeping(run);
  }
}

// The method version of the code this tick runs (agent/method.json), or null.
async function readMethodVersion(ctx) {
  try {
    const version = JSON.parse(await ctx.readRepoFile('agent/method.json'))?.version;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}

// Red only for what this run found. Older problems stay listed in the log
// ("needs attention") and in the alert issue, but they do not turn every
// run red: GitHub would email the owner about each of ~100 runs a day, and
// he would learn to ignore those emails.
export function exitCodeFor(summary) {
  const redStatus = Object.keys(summary.statuses).some((s) => NEEDS_ATTENTION.has(s));
  return summary.errors.length || summary.missed.length || redStatus ? 1 : 0;
}

export async function runTick({
  config,
  profileName = 'live',
  dryRun = false,
  env = process.env,
  fetch = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
  write = console.log,
  readRepoFile = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
}) {
  const log = makeLogger(write, SECRET_NAMES.map((n) => env[n]).filter(Boolean));
  const summary = newSummary();
  let ctx;
  try {
    ctx = createContext({ config, profileName, dryRun, env, fetch, now, sleep, readRepoFile });
  } catch (error) {
    log(`setup error: ${error.message}`);
    return { exitCode: 2, summary };
  }
  log(`tick start: profile ${profileName}${dryRun ? ', dry run (no writes)' : ''}`);
  let stale;
  try {
    stale = await checkFreshCode(ctx);
  } catch (error) {
    stale = { exitCode: 1, reason: `could not read main's head (${ctx.describe(error)})` };
  }
  if (stale) {
    log(`stale code: ${stale.reason}. Nothing was posted, sent or written.`);
    return { exitCode: stale.exitCode, summary };
  }
  try {
    await tick(ctx, summary, log);
  } catch (error) {
    summary.errors.push('tick_stopped');
    log(`tick stopped early: ${ctx.describe(error)}`);
  }
  const counts = Object.entries(summary.statuses).map(([s, ids]) => `${s} ${ids.length}`).join(', ') || 'no forecast files handled';
  log(`summary: ${counts}; fired ${summary.fired.length}; skipped ${summary.skipped.length}; missed ${summary.missed.length}; errors ${summary.errors.length}`);
  if (summary.errors.length) log(`errors: ${summary.errors.join(', ')}`);
  if (summary.attention.length) log(`earlier problems (last ${config.posting.alert_window_hours} h, see the alert issue): ${summary.attention.join(', ')}`);
  if (summary.held.length) log(`held for a later wake-up: ${summary.held.join(', ')}`);
  return { exitCode: exitCodeFor(summary), summary };
}

export const HELP = `tick: post finished forecasts, record missed questions, wake the agent.

Usage:
  node poster/tick.mjs --dry-run                  print what would happen, write nothing
  node poster/tick.mjs --dry-run --profile test   the same for the bot testing area
  node poster/tick.mjs                            a live run (only inside GitHub Actions)
  node poster/tick.mjs --help                     this text

Options:
  --dry-run         no posts, no wake-ups, no state writes, no issue changes
  --profile NAME    live (the prize tournaments) or test (the bot testing area);
                    default: TICK_PROFILE, else live

Keys are read from environment variables only (see poster/README.md):
  METACULUS_TOKEN, DATA_REPO_TOKEN, DATA_REPO, GITHUB_TOKEN, GITHUB_REPOSITORY,
  ROUTINE_FIRE_URL, ROUTINE_FIRE_TOKEN (live runs only).
A live run outside GitHub Actions is refused unless TICK_ALLOW_LOCAL=yes.

Exit codes: 0 all fine; 1 something needs attention; 2 setup problem.`;

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      profile: { type: 'string', default: process.env.TICK_PROFILE || 'live' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const { exitCode } = await runTick({ config, profileName: values.profile, dryRun: values['dry-run'] });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const log = makeLogger(console.error, SECRET_NAMES.map((n) => process.env[n]).filter(Boolean));
    log(`tick crashed: ${error?.message ?? error}`);
    process.exitCode = 2;
  });
}
