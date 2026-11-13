# poster: the trusted pipeline

`tick.mjs` is the program the `tick` workflow runs. Everything here uses the
Node standard library only and reads keys from environment variables.

## Files

| File | Job |
|---|---|
| `tick.mjs` | The main program: post, record missed questions, discover, wake the agent, housekeeping. |
| `metaculus.mjs` | Metaculus client: who am I, list open questions, read one post, post the forecasts of one post with their comments in one request. |
| `data-repo.mjs` | Reads the private data repo through the GitHub API: list the `forecasts/` folder, fetch one file, and list the blob ids of `bootstrap.mjs`, `CLAUDE.md` and `.github/workflows/` (the guard). Never clones or runs anything from it. |
| `state.mjs` | Reads and writes `fired.json` and `posted.json` on the `state` branch, safely when two writers race. |
| `fire.mjs` | Wakes the cloud agent; splits many questions into several texts under the size limit. |
| `ops.mjs` | The one alert issue, the weekly keep-alive, the token expiry table, the data repo guard and the daily environment check. |
| `make-data-template.mjs` | Writes `ops/data-template.json` (what the guard expects) from `forecaster-data-template`. |
| `measure-schedule.mjs` | How often the tick really runs (also a command for the owner). |
| `github.mjs` | Tiny GitHub REST helper used by the two files above. |
| `config.json` | Base URLs, wake-up headers, tournaments per profile (plus the dated MiniBench rounds), timing and firing rules, posting limits, alert, clock and keep-alive settings. |

## Running it

```
node poster/tick.mjs --help                     # the options and exit codes
node poster/tick.mjs --dry-run                  # print what would happen, write nothing
node poster/tick.mjs --dry-run --profile test   # the same for the bot testing area
node poster/measure-schedule.mjs --repo OWNER_GITHUB_USER/forecaster   # gaps between tick runs, last 48 h
```

A **live** run (no `--dry-run`) starts only inside GitHub Actions, where the
`tick` concurrency group keeps runs apart. To run it live anywhere else, first
disable the `tick` workflow, then set `TICK_ALLOW_LOCAL=yes`. Normally use
Actions → tick → Run workflow instead.

Environment variables (the workflow sets them from the `metaculus` environment):

| Name | Used for |
|---|---|
| `METACULUS_TOKEN` | Metaculus bot account key |
| `DATA_REPO_TOKEN` | Read-only key for the private data repo |
| `DATA_REPO` | `owner/name` of the private data repo (an Actions variable, not a secret) |
| `GITHUB_TOKEN` | The workflow's own token, to write the `state` branch |
| `GITHUB_REPOSITORY` | Set by Actions: `owner/name` of this repo |
| `ROUTINE_FIRE_URL`, `ROUTINE_FIRE_TOKEN` | Wake-up address and key of the cloud agent (not needed for `--dry-run`) |
| `TICK_PROFILE` | Optional default for `--profile` |
| `GITHUB_ACTIONS` | Set by Actions; live runs need it (or `TICK_ALLOW_LOCAL=yes`) |
| `GITHUB_RUN_ID`, `GITHUB_SERVER_URL` | Set by Actions; used only for the run link in the alert issue |

## Waking the agent (`config.firing`)

- One wake-up holds every question to send (split into several texts only
  if they are too long). Each question is woken at most twice: a second time
  only if no file appeared after 60 minutes and at least 45 minutes remain,
  or once for a replacement file.
- **Batch hold:** when every new question has more than
  `batch_hold_if_minutes_left_over` (120) minutes left, the tick waits up to
  `batch_hold_minutes` (30) so several questions go out in one wake-up.
  Second wake-ups and replacements are never held.
- **Daily budget:** `daily_fire_budget` (12) wake-ups per UTC day, counted in
  `ops.json` (`fires`). Once it is reached, a **first** wake-up waits until a
  question would otherwise have under `over_budget_fire_if_minutes_left_under`
  (120) minutes left, and then every open question goes in that one wake-up.
  Second wake-ups and replacement requests are never held by the budget.
  After the budget, each new question gets one late wake-up only (about two
  hours before its deadline), with no room for a second one.
- **Hard cap:** `daily_fire_hard_cap` (14): no wake-up at all after that many
  in a UTC day, because the subscription's own daily run cap (Max: 15, from
  the launch post, not verified) would refuse it. The alert issue then shows
  `wake_hard_cap`. If you also run the optional heartbeat task, it uses runs
  of the same cap.
- **Kit per question:** every wake-up names `kit_ref`, the commit whose
  runbook, method and tools the agent must use. A question keeps the kit of
  its first wake-up (`fired.json` → `kit_ref`, `method_version`), so a later
  method change never touches a question that was already sent.
- **Test profile:** `profiles.test.firing` narrows the rules: one question
  per tick, at most two wake-ups a day, on its own counter (`fires_test`),
  never counted in the live budget and never an alert.

The wake-up request (checked on 12 Nov 2026 against
platform.claude.com/docs/en/api/claude-code/routines-fire and
code.claude.com/docs/en/routines): `POST` to the task's Fire URL
`https://api.anthropic.com/v1/claude_code/routines/trig_.../fire`, headers
`Authorization: Bearer <token>`, `anthropic-version` (`routine_api_version`
in `config.json`; the endpoint accepts every version from 2023-06-01 on),
`anthropic-beta: experimental-cc-routine-2026-04-01` (`routine_beta`), and
the body `{"text": "..."}`. **Owner:** compare these with the curl example
shown in the task's API trigger dialog (claude.ai/code/routines → the task →
Edit → API trigger). If the dialog shows a newer beta or version string,
change `config.json` in a pull request.

## Alerts (`config.alerts`)

The tick opens or updates **one** issue in this repository titled
"Forecaster needs attention" when any of these holds:

| Code | Meaning |
|---|---|
| `metaculus_setup` | Metaculus answered 401 or 404 (wrong key or address). |
| `wake_setup` | The wake-up call answered 400, 401 or 403 (wrong token, the task is paused, or perhaps the plan's daily run cap). |
| `wake_rate_limited` | The wake-up call answered 429. |
| `wake_hard_cap` | `daily_fire_hard_cap` was reached; nothing more is sent today. |
| `unsent_file` | A forecast file appeared for a question the tick never sent. It is never posted; the question is then sent as a replacement request, so only a new `<id>.r2.json` counts. |
| `data_repo_changed` | `bootstrap.mjs`, `CLAUDE.md` or a workflow in the data repo differs from `ops/data-template.json`. |
| `environment_unprotected` | The `metaculus` environment does not limit its keys to `main` (checked daily). |
| `no_live_questions` | No open, unforecast question in any live tournament for 3 days (a season ended, or a slug is wrong). |
| `data_repo_unreadable` | The data repository could not be read. |
| `missed_questions` | Two or more questions closed without a forecast in 24 hours (missed, found too late, or late). |
| `fire_budget_reached` | The daily wake-up budget was used up. |
| `clock_slow` | The daily clock check found a median gap over 30 minutes between tick runs. |
| `token_expiring` | A date in `ops/EXPIRY.md` is 21 days away or less, or GitHub's own answer says `DATA_REPO_TOKEN` expires that soon. |

The issue holds codes, status codes, question ids, token names and dates
only. A new comment is added only when the problems change. After 24 hours
without problems the tick comments and closes it. If the owner closes it by
hand, it stays closed until the problems change. Dry runs never touch it.

## Exit codes

- `0`: all fine.
- `1`: this run found something: a forecast file was refused, a post or a
  wake-up failed, a question was missed or found too late, a question's data
  is incomplete, or an API was down. Also when the run's commit is no longer
  the newest on `main` (`stale code`: it did nothing). Only the run that
  finds a problem is red: GitHub emails the owner about every red run, and
  about 100 runs a day would bury the one email that matters. Problems of
  the last `posting.alert_window_hours` (24 h) stay listed in each log
  ("earlier problems") and lost questions stay in the alert issue.
- `2`: setup problem: a variable is missing, the profile is unknown, a live
  run was started outside Actions, or the run is a **re-run** or not on
  `main` (`stale code`: it posted, sent and wrote nothing).

## Status words in posted.json

Waiting (a later tick looks again, and always asks Metaculus first):

| Status | Meaning |
|---|---|
| `in_flight` | Claimed just before sending. If a tick stops here, the next one asks Metaculus first. |
| `unknown` | Sent, but the answer was unclear (timeout or server error). Tried again only after `unknown_retry_after_minutes` (10) and only if Metaculus shows nothing saved, up to `max_post_attempts` (3) sends in all. |
| `held` | A checked file of a group or conditional post, waiting for its siblings (until 45 minutes before the deadline). |
| `retry` | Not saved: HTTP 429, the request never left, or a setup problem (401/404, which also stops posting for that tick). Does not use up an attempt. |
| `forbidden` | HTTP 403. Tried once more; a second 403 makes it `rejected`. |

Final:

| Status | Meaning |
|---|---|
| `posted` | Forecast and comment saved by Metaculus. |
| `unconfirmed` | Still unclear after the last attempt. Never tried again. |
| `rejected` | Metaculus said no (HTTP 400 or 405, or 403 twice). Never tried again. |
| `invalid` | The file broke a rule; the problem codes are listed. Codes that tell something about the numbers (for example `binary_out_of_range`) are shown as `forecast_value_rule`, because this branch is public. Other codes include `file_changed` (the file changed after the tick first saw it), `comment_forecast_mismatch`, `tournament_mismatch`, `method_version_mismatch` and `not_requested` (an `.r2` file the tick never asked for). For the first file, the tick asks the agent once for a replacement, `forecasts/<id>.r2.json` (if 45 minutes are left and the question was woken only once). |
| `late` | The deadline had passed (or was within a minute) when the file was checked, or just before it was sent. |
| `not_sent` | A file appeared before the tick ever sent this question. That file never counts. If the question shows up later, it is sent as a replacement request, and only `forecasts/<id>.r2.json` is accepted. |
| `already_forecast` | Metaculus already holds a forecast from this bot. |
| `missed` | Sent to the agent, but it closed with no file. |
| `skipped_unforecast` | First seen with under 40 minutes left, so it was not sent; it will close unforecast. |

## What the forecast file must look like

One file per question at `forecasts/<question_id>.json` in the data repo
(no leading zeros; other names are ignored). The only other name accepted is
the replacement `forecasts/<question_id>.r2.json`, and only after the first
file was refused:

```json
{
  "schema": 1,
  "question_id": 12345,
  "post_id": 23456,
  "tournament": "fall-futureeval-2026",
  "type": "binary",
  "title": "…",
  "created_at": "2026-11-16T10:00:00Z",
  "method_version": "1.3",
  "forecast": { "probability_yes": 0.23 },
  "comment": "Forecast: 23% (bot v1.3, fully automated, no human input) …",
  "passes": [{ "value": 0.2, "reason": "outside view" }],
  "signals": { "market": null, "community": null, "base_rate": "…" },
  "checks": { "validated": true, "clamped": false, "blend_weight": 0, "passes_required": 5, "passes_valid": 5, "flags": [] }
}
```

- Multiple choice: `"forecast": { "probabilities": { "<exact option>": 0.4, … } }`,
  every option present, character for character, each at least 0.001, sum 1.
- Numeric, discrete, date: `"forecast": { "cdf": [ … ] }` with exactly
  `inbound_outcome_count + 1` values (201 for numeric and date), following the
  CDF rules in `lib/cdf.mjs`.
- Binary: between 0.01 and 0.99.
- Comment: 50 to 3,000 characters.
- No extra top-level fields.
- Group and conditional posts: one file per question. The tick waits until
  every open question of the post has a file (or until
  `group_hold_until_minutes_left`, 45 minutes, before the deadline) and then
  posts them all in one request, each with its own private comment.
