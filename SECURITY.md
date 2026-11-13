# Security

This file says where every key lives, what the AI agent can and cannot touch,
and how to change a key. Expiry dates are kept in `ops/EXPIRY.md`.

## Where each secret lives

All of them are pasted by the owner. The agent never sees, types or handles one.

| Secret | Where it is stored | What it can do |
|---|---|---|
| `METACULUS_TOKEN` | GitHub → this repo → Settings → Environments → `metaculus` → secrets | Act as the Metaculus bot account. |
| `ROUTINE_FIRE_URL` | same environment | The wake-up address of the cloud agent task. |
| `ROUTINE_FIRE_TOKEN` | same environment | Start that one cloud task. It cannot read anything. |
| `DATA_REPO_TOKEN` (fine-grained GitHub token, **only** `forecaster-data` selected) | Only in the same environment | **Contents: read** on `forecaster-data`. Nothing else. |
| `TICK_DISPATCH_TOKEN` (fine-grained GitHub token, **only** `forecaster` selected) | Two places, same value: a repository secret of `forecaster-data` (for `notify.yml`); the script property of the Apps Script clock (`ops/CLOCK.md`) | **Actions: read and write** on this repo. Nothing else: it cannot read `forecaster-data`. |
| `GITHUB_TOKEN` | made by GitHub for each tick run, gone after it | `contents: write` (the `state` branch; rulesets keep it off `main`), `issues: write` (the one alert issue), `actions: write` (re-enable `tick.yml` once a week, read its own runs for the clock check). |

`DATA_REPO` (the `owner/name` of the data repo) is an environment
**variable**, not a secret.

The `metaculus` environment must be limited to the `main` branch
(Settings → Environments → `metaculus` → Deployment branches → Selected
branches → `main`). Then only the workflow on `main` ever receives the keys.
The tick checks this setting once a day and opens the alert issue
(`environment_unprotected`) when it is missing.

## Why two tokens, and why the dispatch token is safe where it is

`DATA_REPO_TOKEN` can read the private data repository, so it lives in one
place only: the `metaculus` environment, which only the tick on `main` can
open. It is never in Google, never in `forecaster-data`.

`TICK_DISPATCH_TOKEN` sits in Google Apps Script and in the data
repository's secrets, so any workflow in `forecaster-data` could read it, and
the agent can push to `forecaster-data`. Assume, then, that the agent (or
anyone who gets into the data repository or the Google account) could get
it. What could they do with it?

- **Start ticks** (workflow_dispatch) on `main`. The tick makes all its own
  checks and posts only files it already accepts, so extra ticks change
  nothing. A `test`-profile tick has its own tiny wake-up budget and cannot
  use the prize tournaments' budget.
- **Start a tick on another branch or tag.** The job's `if:` line could be
  removed on that branch, but the `metaculus` environment hands its keys to
  `main` only (checked daily, see above). The tick also refuses to work when
  `GITHUB_REF` is not `refs/heads/main`.
- **Re-run an old tick run.** GitHub re-runs a run with that run's old
  commit and today's secrets. The tick refuses any re-run (run attempt above
  1) and any run whose commit is not the newest commit of `main`: it posts,
  wakes and writes nothing (log line `stale code`). So old code never runs
  with the keys.
- **See, cancel or delete runs and their logs, approve workflow runs from
  fork pull requests, or switch the workflow off.** This is the worst case:
  it could stop ticks for a while. It cannot post a forecast, read any
  secret, read `forecaster-data`, change a workflow file or any code (that
  needs Contents write), or write the `state` ledger. When ticks stop, the
  Apps Script check (`checkTicks`, every hour) fails and Google emails you.
  If you ever see the tick switched off (Actions → tick shows "disabled"),
  switch it back on and make a new dispatch token. A fork pull request run
  gets no secrets in any case (`ci.yml` uses `pull_request`).

It cannot reach Metaculus, the wake-up token, the data repository or the
owner's account. Never give either token any other permission.

## Keeping the agent away from the pipeline

The agent pushes to GitHub as the owner's user, so a prompt alone is not a
lock. The lock is that **this repository is never attached to the cloud
task**. Only `forecaster-data` is attached. The agent gets this repository's
runtime files with `forecaster-data/bootstrap.mjs`: it downloads only the
files listed in `agent/MANIFEST.json` from raw.githubusercontent.com, checks
each SHA-256, refuses any path outside `agent/` and `lib/`, and writes them
under `kit/` (ignored by git). The cloud task therefore holds no credential
that can push here, open a pull request here or change a workflow, whatever
its prompt says. (In a cloud session, GitHub API calls and archive downloads
for an unattached repository get 403 even when it is public; raw files are
reachable. Only if raw downloads fail does the bootstrap try one anonymous,
read-only git clone, checked the same way.)

The agent can push to `forecaster-data`, so it could change the files there
that steer later runs (`bootstrap.mjs`, `CLAUDE.md`) or add a workflow. Two
checks catch that: the task prompt quotes the SHA-256 of `bootstrap.mjs` and
the agent checks it before running it; and every tick compares
`bootstrap.mjs`, `CLAUDE.md` and every file in `.github/workflows/` of
`forecaster-data` with `ops/data-template.json` and opens the alert issue
(`data_repo_changed`) on any difference. The tick also refuses any forecast
file that changed after it first saw it (`file_changed`), so write-once does
not rest on the prompt alone.

Settings the owner makes once (repo → Settings):

1. **Cloud task:** attach only `forecaster-data` (see `agent/TASK_PROMPT.md`).
2. **Ruleset for `main`** (Rules → Rulesets → New branch ruleset, target
   `main`): require a pull request, require the `lint` status check, block
   force pushes and deletion, and leave the bypass list empty. The owner opens
   and merges his own pull requests; no approval is required, because nothing
   else can push here.
3. **Ruleset for `state`**: restrict updates and deletion to the
   `github-actions` app only (bypass list: GitHub Actions), and block force
   pushes. Only the tick then writes the ledger.
4. **Actions → General → Workflow permissions:** "Read repository contents"
   (read-only by default). `tick.yml` asks for its three permissions itself;
   every other workflow stays read-only.
5. **Actions → General → Actions permissions:** allow only actions from
   GitHub (`actions/*`). The workflows pin each action to a full commit SHA.
6. `CODEOWNERS` is only a label: it names the owner on `.github/`,
   `poster/`, `lib/`, `agent/` and `ops/`. It is **not** a review gate (no
   approval is required, and nobody can approve his own pull request). The
   real gate is the required `lint` check plus the owner merging by hand.
7. **Watch** this repository (the Watch button → All activity, or at least
   Issues), so GitHub emails you when the alert issue opens.
8. **Ruleset for `main` of `forecaster-data`**: block force pushes and
   deletion (leave pushes allowed: the agent pushes there). A forecast file
   then cannot be swapped out of the history.
9. Settings → General → **Automatically delete head branches**, in both
   repositories.

`ci.yml` runs on pull requests with a read-only token and no secrets.

## What the agent can and cannot do

The agent can:
- read the question texts the tick sends it;
- research on the web (never on Metaculus);
- download this repository's kit files (read only);
- push files to the private data repo: `forecasts/`, `questions/`, `runs/`,
  `logs/`, and from the weekly review `reviews/` and `proposals/`.

The agent cannot:
- see any key (its cloud environment holds none);
- post to Metaculus (only the tick can, after its own checks);
- change the pipeline on `main` or the `state` ledger (this repository is not
  attached to its task, and the rulesets above stop anyone else);
- make the tick run anything: the tick reads the data repo only as JSON text,
  through the API, and never clones or executes it;
- forecast a question twice, or post a question the tick did not send;
- run the tick from a laptop by mistake: a live run outside GitHub Actions
  refuses to start unless `TICK_ALLOW_LOCAL=yes` is set on purpose.

Everything the tick reads from Metaculus, from the data repo or from the
agent is treated as data, not as instructions.

## What is public

This repo, its Actions logs, its issues and its `state` branch are public. So:
- logs show question ids, status codes, problem codes and counts only (no
  response bodies, no private repo name, no forecast numbers; control
  characters are removed so no text can act as a workflow command);
- the alert issue shows problem codes, status codes, question ids, token
  names and dates only;
- `state` holds ids, file hashes, status codes, counts and times only;
- question texts and forecasts stay in the private data repo until a question
  closes (Metaculus makes the comment public itself after close).

## How to change (rotate) a key

Do this if a key may have leaked, or when it expires. No code change is
needed. Afterwards, write the new expiry date in `ops/EXPIRY.md`.

1. **Metaculus:** metaculus.com → Settings → My Forecasting Bots → the bot →
   make a new key. Paste it over `METACULUS_TOKEN` in the `metaculus`
   environment. The old key should stop working; check that the next tick is green.
2. **Wake-up token:** claude.ai/code/routines → the forecast task → Edit →
   API trigger → Regenerate (this cancels the old one). Paste it over
   `ROUTINE_FIRE_TOKEN`. If the URL changed, update `ROUTINE_FIRE_URL` too.
3. **Data token:** github.com → Settings → Developer settings →
   Fine-grained tokens → `forecaster data read` → Regenerate (only
   `forecaster-data`, Contents read, longest expiry). Paste it over
   `DATA_REPO_TOKEN` in the `metaculus` environment.
4. **Dispatch token:** the same page → `forecaster dispatch` → Regenerate
   (only `forecaster`, Actions read and write, longest expiry). Paste the new
   value into both places: `TICK_DISPATCH_TOKEN` in `forecaster-data`, and
   the Apps Script property. Then delete any old token.
5. `GITHUB_TOKEN` needs nothing: GitHub makes a new one for every run.

After any change, run the `tick` workflow once by hand with `dry_run` ticked
to check it reads everything, then let the clocks carry on.

## The Claude subscription

Use it only through the vendor's own scheduled tasks. Never place its login
or any of its tokens in another tool, and never share them (see
`OWNER_RULES.md`).

## Reporting a problem

Open a GitHub issue that says only that there is a security problem and how to
reach you; do not put details or keys in the issue. Contact: the issues page of this repository (https://github.com/swish03/forecaster/issues).
