# The clocks that start the tick

The tick only does something when something starts it. A question stays open
about **3 hours**. If no tick runs in that time, the question is lost.

GitHub's own schedule is **not enough**. Measurements on young public
repositories (12 Nov 2026) showed schedules set to "every 10 to 30 minutes"
really running only every **4 to 7 hours**. So the tick has three clocks.

| Clock | What it is | How often | Cost |
|---|---|---|---|
| **A. Primary** | A Google Apps Script time trigger that asks GitHub to start the tick | Every 15 minutes | Free |
| **B. Fast post path** | `notify.yml` in `forecaster-data`: when the agent pushes a forecast file, it starts a tick at once | After each pushed file | Free |
| **C. Backup** | GitHub's own schedule in `tick.yml` (`4,24,44 * * * *`) | When GitHub feels like it | Free |

Clock A finds new questions and wakes the agent. Clock B gets finished
forecasts posted within minutes. Clock C is only a backup.

Optional instead of clock A: the tiny hourly cloud task in
`agent/HEARTBEAT_TASK_PROMPT.md`. It pushes one small file every hour, which
starts a tick through clock B. It uses your subscription 24 times a day, so
prefer clock A.

## Two tokens for the plumbing

Make **two** fine-grained GitHub tokens. Each can do one small thing only.

1. github.com → your picture → Settings → Developer settings → Personal
   access tokens → **Fine-grained tokens** → Generate new token.
2. **Token 1, `forecaster dispatch`** (starts ticks):
   - Expiration: the **longest** offered (not the 30-day default). Write the
     date in `ops/EXPIRY.md`.
   - Repository access: **Only select repositories** → `forecaster` only.
   - Permissions: **Actions: Read and write**. Nothing else ("Metadata:
     Read-only" is added by GitHub itself).
   - Paste it into these two places (and nowhere else):
     - `forecaster-data` → Settings → Secrets and variables → Actions →
       New repository secret **`TICK_DISPATCH_TOKEN`**;
     - the Apps Script property **`TICK_DISPATCH_TOKEN`** (below).
3. **Token 2, `forecaster data read`** (lets the tick read forecasts):
   - Expiration: the longest offered. Write the date in `ops/EXPIRY.md`.
   - Repository access: **Only select repositories** → `forecaster-data` only.
   - Permissions: **Contents: Read-only**. Nothing else.
   - Paste it into one place only: `forecaster` → Settings → Environments →
     `metaculus` → secret **`DATA_REPO_TOKEN`**.

Why two: the dispatch token sits in Google and in `forecaster-data`, so it
must not be able to read the private forecasts. `SECURITY.md` explains
what each token can and cannot do. The tick also reads the expiry date of
the data token from GitHub's own answers and warns you 21 days ahead.

## Set up clock A (Google Apps Script), about 10 minutes

1. Open script.google.com with your Google account → **New project**. Name
   it `forecaster clock`.
2. Delete the sample code. Paste the whole content of
   `ops/clock/apps_script_clock.gs` from this repository. Save.
3. Left menu → **Project Settings** (the gear) → **Script Properties** → Add:
   - `TICK_DISPATCH_TOKEN` = the dispatch token (token 1);
   - `FORECASTER_REPO` = `OWNER_GITHUB_USER/forecaster` (your user name).
   Save. The token is stored here, never in the code.
4. Back in the editor, pick the function **`installClock`** in the menu at
   the top and click **Run**. It makes two triggers: `startTick` every 15
   minutes and `checkTicks` every hour. Google asks for permission (to "connect to an
   external service" and "run when you are not present"). Allow it.
5. Pick **`startTick`** and click **Run** once. The log at the bottom must
   say `tick dispatch: HTTP 204`. In GitHub (forecaster → Actions → tick) a
   new run appears within a minute.
6. Left menu → **Triggers** (the clock icon): two triggers, `startTick`
   every 15 minutes and `checkTicks` every hour. For **each** one, open its
   menu (the three dots) → Edit trigger → **Failure notification settings** →
   "Notify me immediately" (or daily). Save. Done.

Both functions **fail on purpose** when something is wrong: `startTick` when
GitHub does not answer 204, `checkTicks` when no tick finished well in the
last 2 hours. Google then emails you. This is the one warning that still
works when no tick runs at all (the alert issue needs a tick to open it).

If the log shows another status (the run then fails and Google emails you):
`401` = the token value is wrong or expired; `403` or `404` = the token lacks
"Actions: Read and write" on `forecaster`, or `FORECASTER_REPO` is
misspelled; `422` = the `main` branch or `tick.yml` is missing, or the tick
workflow is switched off (Actions → tick → Enable workflow).

## Set up clock B (notify.yml), about 3 minutes

`forecaster-data` already contains `.github/workflows/notify.yml`. Add the
secret `TICK_DISPATCH_TOKEN` there (token 1 above). That is all. If the secret
is missing, the workflow ends green with a notice and does nothing.

If your public repository is not named `forecaster` under the same user, set
the variable `FORECASTER_REPO` (Settings → Secrets and variables → Actions →
Variables) to `owner/name`.

## Clock C (GitHub's schedule)

Nothing to set up. It is in `tick.yml`. Once a week the tick calls GitHub's
"enable workflow" endpoint for itself, so GitHub never switches the schedule
off after 60 days without activity.

## Check that the clocks work

After 48 hours, run (on any computer with Node, no key needed):

```
node poster/measure-schedule.mjs --repo OWNER_GITHUB_USER/forecaster
```

It prints the median, 90th percentile and longest gap between tick runs, for
all runs and for each trigger (`schedule`, `workflow_dispatch`). Cancelled
and skipped runs did no work and are not counted. With clock A the median
should be about 15 minutes. Exit code 1 means the median gap is
over 30 minutes: the clock is too slow.

The tick also does this check by itself once a day. When the clock is too
slow, it opens the "Forecaster needs attention" issue (code `clock_slow`).
