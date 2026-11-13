// Housekeeping for the tick: the one alert issue the owner sees, the weekly
// keep-alive of the schedule, and the token expiry table in ops/EXPIRY.md.
//
// The alert issue is public (this repository is public), so it holds problem
// codes, HTTP status codes, question ids, token names and dates only: never
// forecast numbers, question text, reasoning, response bodies or keys.

const BOT_LOGIN = 'github-actions[bot]';

// What the owner should do for each problem code, in plain words.
export const HINTS = {
  metaculus_setup: 'Metaculus refused the bot key or an address. Check METACULUS_TOKEN (SECURITY.md, "How to change (rotate) a key") and the tournament slugs in poster/config.json (ops/SEASONS.md).',
  wake_setup: 'The wake-up call to the forecast task was refused. Check ROUTINE_FIRE_URL and ROUTINE_FIRE_TOKEN, and that the forecast task is switched on (a paused task answers HTTP 400).',
  data_repo_unreadable: 'The tick could not read the private data repository. Check DATA_REPO_TOKEN (the data read token) and its date in ops/EXPIRY.md.',
  missed_questions: 'Questions closed with no forecast. Check that the forecast task is switched on, that GitHub is still connected to it, and the usage page of the subscription.',
  fire_budget_reached: 'The daily wake-up budget is used up. New questions now wait until they are close to their deadline. Check the usage page; nothing else is needed.',
  clock_slow: 'The tick runs too rarely to catch every question. Set up the clock in ops/CLOCK.md.',
  token_expiring: 'A token expires soon or has expired. Renew it as ops/EXPIRY.md says and write the new date there.',
  wake_rate_limited: 'The forecast task refused a wake-up because of a rate limit (HTTP 429). Check the usage page of the subscription. A 400 or 403 after many wake-ups in one day can also mean the daily run cap was reached.',
  wake_hard_cap: 'The tick stopped waking the agent today because it reached firing.daily_fire_hard_cap (just under the plan\'s daily run cap). Questions found later today may close without a forecast. Nothing to do unless this happens often; then see poster/README.md.',
  unsent_file: 'A forecast file appeared in forecaster-data for a question the tick had never sent. It is never posted; the question is still sent to the agent as usual. Do not open the file. If this repeats, the agent may be misbehaving: check the alert issue for data_repo_changed and look at forecaster -> Actions for odd runs.',
  data_repo_changed: 'bootstrap.mjs, CLAUDE.md or a workflow in forecaster-data is not what ops/data-template.json expects. Compare them with forecaster-data-template and put the right files back with a commit. If you changed them on purpose, update ops/data-template.json with poster/make-data-template.mjs.',
  environment_unprotected: 'The metaculus environment does not limit its keys to the main branch. Set it: forecaster -> Settings -> Environments -> metaculus -> Deployment branches -> Selected branches -> main (SECURITY.md).',
  no_live_questions: 'For 3 days the tick found no open question in the prize tournaments. A season may have ended, or a tournament slug is wrong or missing. See ops/SEASONS.md.',
};

// Problem details may only hold plain words, numbers, dates and token names.
export const cleanDetail = (text) => String(text ?? '').replace(/[^A-Za-z0-9 _.,:()/-]/g, '').slice(0, 200);

export function problemSignature(problems) {
  return problems.map((p) => `${p.code}=${p.detail}`).sort().join(';');
}

export function dedupeProblems(problems) {
  const seen = new Map();
  for (const p of problems) {
    const clean = { code: p.code, detail: cleanDetail(p.detail) };
    seen.set(`${clean.code}=${clean.detail}`, clean);
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));
}

// Rows of the markdown table in ops/EXPIRY.md whose "Expires" cell holds a
// date (YYYY-MM-DD) within warnDays, or already past. Blank dates are skipped.
export function expiringTokens(text, nowMs, warnDays) {
  const rows = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  let expiresAt = -1;
  const out = [];
  for (const line of rows) {
    const c = cells(line);
    if (expiresAt === -1) {
      expiresAt = c.findIndex((x) => /^expires/i.test(x));
      continue;
    }
    const date = (c[expiresAt] ?? '').replace(/[`*]/g, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    const daysLeft = Math.floor((ms - nowMs) / 86400000);
    if (daysLeft <= warnDays) out.push({ token: cleanDetail(c[0].replace(/[`*]/g, '')).trim() || 'token', expires: date, days_left: daysLeft });
  }
  return out;
}

export function issueBody({ problems, iso, runUrl, healthyHours }) {
  const lines = [
    'The forecaster tick found something that only the owner can fix.',
    'This issue shows problem codes, status codes, question ids and token names only.',
    '',
    `Problems seen at ${iso}:`,
    '',
  ];
  for (const p of problems) lines.push(`- \`${p.code}\`${p.detail ? ` (${p.detail})` : ''}: ${HINTS[p.code] ?? 'See README.md.'}`);
  lines.push('');
  if (runUrl) lines.push(`Latest tick run: ${runUrl}`, '');
  lines.push(`This issue is closed by the tick itself after ${healthyHours} hours without problems.`);
  return lines.join('\n');
}

// Opens, updates or closes the one alert issue. Returns the new value of
// ops.alert (null when there is no open alert) and what was done.
export async function syncAlertIssue({ call, repo, title, problems, prev, nowMs, healthyHours, runUrl, dryRun, log }) {
  const iso = new Date(nowMs).toISOString();
  const signature = problemSignature(problems);
  const base = `/repos/${repo}/issues`;

  if (!problems.length) {
    if (!prev) return { alert: null, action: 'none' };
    const quietMs = nowMs - Date.parse(prev.last_problem_at);
    if (!(quietMs >= healthyHours * 3600000)) return { alert: prev, action: 'waiting' };
    if (dryRun) {
      log(`alert: dry run, would close issue #${prev.issue}`);
      return { alert: prev, action: 'dry_run' };
    }
    if (prev.issue) {
      await call('POST', `${base}/${prev.issue}/comments`, { body: { body: `No problems for ${healthyHours} hours (checked ${iso}). Closing.` } });
      await call('PATCH', `${base}/${prev.issue}`, { body: { state: 'closed', state_reason: 'completed' } });
      log(`alert: closed issue #${prev.issue} after ${healthyHours} healthy hours`);
    }
    return { alert: null, action: 'closed' };
  }

  if (dryRun) {
    log(`alert: dry run, would open or update the "${title}" issue: ${problems.map((p) => p.code).join(', ')}`);
    return { alert: prev ?? null, action: 'dry_run' };
  }
  const body = issueBody({ problems, iso, runUrl, healthyHours });
  let issue = prev?.issue ?? null;
  if (issue) {
    const current = await call('GET', `${base}/${issue}`, { allow: [404, 410] });
    if (current.status !== 200 || current.json?.state !== 'open') {
      // The owner closed it by hand: stay quiet until the problems change.
      if (current.status === 200 && prev.signature === signature) {
        return { alert: { ...prev, last_problem_at: iso }, action: 'muted' };
      }
      issue = null;
    }
  }
  if (!issue) {
    const query = new URLSearchParams({ state: 'open', creator: BOT_LOGIN, per_page: '100' });
    const list = await call('GET', `${base}?${query}`);
    const found = (Array.isArray(list.json) ? list.json : []).find((i) => i?.title === title && !i.pull_request);
    issue = found?.number ?? null;
    if (found) prev = { ...(prev ?? {}), issue, signature: null, opened_at: prev?.opened_at ?? iso };
  }
  if (!issue) {
    const created = await call('POST', base, { body: { title, body } });
    const number = created.json?.number;
    if (!Number.isInteger(number)) throw new Error('GitHub did not return an issue number');
    log(`alert: opened issue #${number}: ${problems.map((p) => p.code).join(', ')}`);
    return { alert: { issue: number, signature, opened_at: iso, last_problem_at: iso }, action: 'opened' };
  }
  if (prev?.signature !== signature) {
    await call('POST', `${base}/${issue}/comments`, { body: { body } });
    log(`alert: updated issue #${issue}: ${problems.map((p) => p.code).join(', ')}`);
    return { alert: { issue, signature, opened_at: prev?.opened_at ?? iso, last_problem_at: iso }, action: 'updated' };
  }
  return { alert: { ...prev, issue, last_problem_at: iso }, action: 'unchanged' };
}

// Public repositories switch schedules off after 60 days without activity.
// Calling the documented "enable a workflow" endpoint once a week keeps it on.
export async function keepAlive({ call, repo, workflow, nowMs, last, everyDays }) {
  const lastMs = Date.parse(last ?? '');
  if (Number.isFinite(lastMs) && nowMs - lastMs < everyDays * 86400000) return null;
  await call('PUT', `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/enable`);
  return new Date(nowMs).toISOString();
}

// Paths whose git blob id differs from the expected one, plus paths that
// exist on only one side. Expected: { path: blob sha } from ops/data-template.json.
export function compareGuardedFiles(expected, actual) {
  const paths = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  return [...paths].filter((p) => expected?.[p] !== actual?.[p]).sort();
}

// 'protected' when the environment hands its secrets to the main branch only,
// 'unprotected' when it does not, 'unknown' when GitHub does not tell us.
export async function checkEnvironment({ call, repo, name }) {
  const base = `/repos/${repo}/environments/${encodeURIComponent(name)}`;
  const env = await call('GET', base, { allow: [403, 404] });
  if (env.status === 404) return 'unprotected';
  if (env.status !== 200) return 'unknown';
  const policy = env.json?.deployment_branch_policy;
  if (!policy || policy.custom_branch_policies !== true) return 'unprotected';
  const list = await call('GET', `${base}/deployment-branch-policies`, { allow: [403, 404] });
  if (list.status !== 200) return 'unknown';
  const rules = Array.isArray(list.json?.branch_policies) ? list.json.branch_policies : [];
  const onlyMain = rules.length === 1 && rules[0]?.name === 'main' && (rules[0].type ?? 'branch') === 'branch';
  return onlyMain ? 'protected' : 'unprotected';
}
