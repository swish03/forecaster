# forecaster

An autonomous forecasting bot for the Metaculus bot tournaments.
No person looks at a question or changes a forecast. A fixed pipeline does the
posting; an AI agent does the research and the forecasting.

This repository is **public** on purpose: it holds the method, the agent's
tools and prompts, and the trusted pipeline. The forecasts themselves live in a
separate **private** repository (`forecaster-data`), so nothing about an open
question becomes public before it closes.

## How it works, in plain words

A GitHub Actions job called **tick** runs on the protected `main` branch.
Three clocks start it (`ops/CLOCK.md`): a free Google Apps Script timer every
15 minutes, a push of a finished forecast to the data repository, and
GitHub's own schedule as a backup only. Each tick does these things, in order:

1. **Posts finished forecasts.** It reads the private data repository (read
   only), finds forecast files it has not handled yet, checks every one of
   them again itself, and posts the good ones to Metaculus together with the
   required reasoning comment, soonest deadline first. The questions of one
   group or conditional post go in one request. Bad, late or duplicate files
   are refused and the reason is written down.
2. **Notes missed questions.** If a question it sent to the agent closed with
   no forecast file, it records it as "missed" and the run turns red.
3. **Wakes the agent.** It asks Metaculus which questions are open and not yet
   forecast (the prize tournaments, MiniBench, and the last two dated
   MiniBench rounds). If there are new ones, it wakes the cloud agent
   **once**, sending the question texts as data. New questions with more than
   2 hours left wait up to 30 minutes so several go out in one wake-up. After
   12 wake-ups in a day (UTC), a new question waits until it would otherwise
   have under 120 minutes left; after 14, nothing more is sent that day. A
   question first seen with under 40 minutes left is recorded as lost and
   the run turns red. Each wake-up names the commit of the kit the agent
   must use, and a question keeps the kit of its first wake-up.
4. **Looks after itself.** Once a week it re-enables its own schedule (GitHub
   switches schedules off after 60 days without activity). Once a day it
   measures how often it really ran. When something needs the owner (a key
   refused, two lost questions in a day, the wake-up budget used up, a slow
   clock, a key expiring in 21 days, a changed file in the data repository,
   keys not limited to `main`, no live question for 3 days), it opens or
   updates **one** GitHub issue
   titled "Forecaster needs attention", so GitHub emails the owner. It closes
   that issue after 24 healthy hours.

The agent (a scheduled cloud task that holds **no secrets**) first runs
`bootstrap.mjs` in the data repository, which downloads this repository's
runbook, method, prompts and tools at the commit the wake-up names (every
file checked against `agent/MANIFEST.json`). Then it researches each question, forecasts with the
fixed method, checks its own work, and pushes one file per question to the
private data repository as soon as it is ready. That push starts a tick,
which posts it.

```
  clocks: Apps Script every 15 min ─┐   GitHub schedule (backup) ─┐
                                    ▼                              ▼
   ┌──────────────────────────────────────────┐
   │ tick (GitHub Actions, main only)         │
   │ environment "metaculus" holds the keys   │       question texts (JSON)
   │                                          │  ┌──────────────────────────┐
   │  1 read forecast files (read only) ◀─────┼┐ │                          │
   │  2 re-check, post forecast + comment ────┼┼▶│ Metaculus API            │
   │  3 list open questions ◀─────────────────┼┼─│                          │
   │  4 wake the agent once ──────────────┐   ││ └──────────────────────────┘
   │  5 ids/hashes/times → "state" branch │   ││
   │  6 alert issue for the owner         │   ││
   └──────────────────────────────────────┼───┘│
                ▲ notify.yml              │    │
                │ (on push)               ▼    │
   ┌────────────┴─────────────────────────────┐│
   │ private repo forecaster-data             ││
   │  forecasts/<id>.json  questions/  logs/  ├┘
   │  bootstrap.mjs → kit/ (from raw files)   │
   └──────────────────────────────────────────┘
                ▲ push, one commit per question
   ┌────────────┴─────────────────────────────┐
   │ cloud agent (no secrets)                 │
   │ bootstrap → research → forecast → push   │
   └──────────────────────────────────────────┘
```

## The rules the pipeline enforces

- **One forecast per question, ever.** Before posting, the tick checks its own
  ledger and Metaculus's record. It marks a forecast "in flight" before
  sending it, so a crash can never cause a second, blind submission.
- **A forecast always goes with its comment.** Both are sent in one
  all-or-nothing request.
- **Only questions it sent.** A file for a question the tick never sent to the
  agent is refused. The wake-up is written to the ledger before it is sent.
- **Never late.** A question whose deadline (the earliest of its close and
  scoring times) is past, or within one minute, is not posted.
- **The agent is woken at most twice per question.** The second time only if
  no file appeared after 60 minutes and at least 45 minutes remain, or once
  to ask for a replacement when the first file was refused.
- **Losses stay visible.** A refused, rejected, late or missed question keeps
  the run red for 24 hours.
- **Public logs show only ids, status codes and problem codes**, never
  question text, forecast numbers, response bodies or keys.

## What is where

| Path | What it is |
|---|---|
| `poster/` | The trusted pipeline: the tick and its small clients. See `poster/README.md`. |
| `lib/` | Shared checks: CDF rules and builder, probability helpers, forecast-file validation. |
| `agent/` | The agent side: the cloud task's prompt (`TASK_PROMPT.md`), the optional heartbeat and weekly review tasks (`HEARTBEAT_TASK_PROMPT.md`, `REVIEW_TASK_PROMPT.md`), the run procedure (`RUNBOOK.md`), the method (`method.md`, `method.json`), prompts, small tools and their tests, and `MANIFEST.json` (the kit list with hashes, made by `agent/tools/make-manifest.mjs`). |
| `ops/` | `CLOCK.md` (the three clocks and the Apps Script clock in `ops/clock/`), `EXPIRY.md` (every key and its expiry date), `SEASONS.md` (the season calendar and how to add a tournament), `data-template.json` (what the tick expects of `bootstrap.mjs`, `CLAUDE.md` and the workflows in the data repository; made by `poster/make-data-template.mjs`). |
| `OWNER_RULES.md` | What the owner must never do, and the duties only he can do. |
| `.github/workflows/tick.yml` | The tick job. |
| `.github/workflows/ci.yml` | Offline tests on every pull request (check name `lint`). |
| `test/` | Offline tests with fake Metaculus, GitHub and wake-up endpoints. |
| `SECURITY.md` | Where each key lives, what the agent can and cannot touch, how to rotate keys. |

## Running the tests

Node 22 or newer, nothing to install:

```
node --test "**/*.test.mjs"
node agent/tools/make-manifest.mjs --check   # the kit list is up to date
```

After changing anything in `agent/` or `lib/`, run
`node agent/tools/make-manifest.mjs` and commit `agent/MANIFEST.json` too
(the `lint` check fails otherwise).

## The state branch

The tick keeps its memory on a branch called `state` in this repository:

- `fired.json`: question id → first and last wake-up time, how many times,
  deadline (`pending: true` while a wake-up is being sent).
- `posted.json`: question id → status, time, the file's SHA-256 hash, which
  file (1 or the `.r2` replacement), HTTP result, attempts.
- `ops.json`: the tick's housekeeping: wake-ups sent today, the batch hold,
  the last clock check, the last keep-alive, the open alert issue's number.

It holds ids, hashes, status codes, counts and times only. Do not edit it by hand
unless the tick tells you a file is broken.

## Rules for people

The owner sets this up once and then leaves it alone. While a question is open
the owner must not read it, read the bot's forecast, ask about it, share his
view on it, re-run anything, or change the method. Changes to the method
happen only between runs, are judged on closed questions or the bot testing
area (`profile: test`), and are pull requests the owner merges. This is what
Metaculus's "no human in the loop" rule requires. The full list, and the
duties only the owner can do, are in `OWNER_RULES.md`.
