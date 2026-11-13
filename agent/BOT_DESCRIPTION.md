# Bot description

For the end-of-season survey and for a possible code review with Metaculus.
Everything here describes the code in this repository; nothing is planned or
aspirational unless it says so.

## In one paragraph

The bot is fully automated. A job on GitHub Actions (the tick) checks the
tournaments. An outside timer starts it every 15 minutes, a push of a
finished forecast starts it at once, and GitHub's own schedule is a backup. When it finds open questions the bot has not
forecast, it wakes an AI agent (a scheduled Claude Code cloud task) and sends
it the question texts. The agent researches each question on the web, makes
five independent forecasts with a fixed method (see "Automatic retries and
shortcuts" for when there are fewer, or when they are not independent),
combines them with fixed rules,
checks the result, and saves one forecast file per question in a private
repository. The next run of the job checks the file again and posts the
forecast and its reasoning comment to Metaculus in one request. No human
reads, previews, changes or re-runs any forecast.

## The parts

| Part | Where | What it does |
|---|---|---|
| Tick | `poster/tick.mjs`, `.github/workflows/tick.yml` | Every 15 minutes and after each pushed forecast (`ops/CLOCK.md`): posts finished forecasts after re-checking them, records missed questions, lists new open questions, wakes the agent. It alone holds the Metaculus key. |
| Agent | a Claude Code cloud task with the prompt in `agent/TASK_PROMPT.md` | Fetches its files with the data repository's `bootstrap.mjs` (every file checked against `agent/MANIFEST.json`), then follows `agent/RUNBOOK.md`: criteria card, research, five passes, combine, comment, write the file. It holds no keys and cannot post. |
| Tools | `agent/tools/` (Node standard library only) | `intake` saves questions and plans the run; `markets` searches Polymarket, Kalshi and Manifold public read endpoints; `series` gives statistics of a data series; `check-card` and `check-pass` check the card and each pass before the next step; `option-market` turns markets into a per-option table for multiple choice; `aggregate` combines the passes; `make-cdf` builds a valid CDF; `write-forecast` checks and writes the file once (the comment must hold the aggregate's own lines); `check-run` confirms every question is covered; `closed-questions` copies only closed questions for the weekly review. |
| Prompts | `agent/prompts/` | Criteria card, research plan, outside-view and inside-view passes, answer formats (yes/no, multiple choice, numeric), comment format, weekly self-review. |
| Shared checks | `lib/` | The CDF rules, probability helpers and the forecast-file validator, used by both the agent's tools and the tick. |

## Model and research

- Model: whichever model the owner's consumer subscription runs in scheduled
  Claude Code cloud tasks (the exact version is shown in each task run). No
  paid API key and no donated credits are used.
- Research: the agent's built-in web search and page reading; public read-only
  market data from Polymarket, Kalshi and Manifold; public data sources named
  in the resolution criteria. The Metaculus community prediction is not used,
  and the agent never opens the Metaculus site or API.
- No AskNews or other paid search (not registered).

## The method

Described in plain words in `agent/method.md` (version and changelog there).
In short: criteria card first; fixed research plan; five independent no-tool
passes, alternating outside view and inside view; median (yes/no), median per
option with a 1% floor (multiple choice), pointwise median of the pass CDFs
(numeric, discrete, date), with numeric 10-90% bands kept at least 0.85 of
the data series' own band for the horizon; a fixed liquidity-weighted blend
toward one matched real-money market (yes/no) or a per-option market table
that covers every option (multiple choice); clamp to
2-98% (1-99% only when all five passes agree with a status quo that holds
and the question resolves within 72 hours, or with a deep matching market);
no extremizing. Group and conditional
questions are forecast part by part and posted in one request per post.

## How the rules are kept

- **No human in the loop.** The owner set the bot up once. He does not read
  open questions or the bot's forecasts on them, does not start runs for a
  question, does not share his views on live questions with the agent, and
  does not change anything in response to a live question.
- **No tuning on open questions.** The rules say: "A bot maker cannot preview
  how their bot forecasts on open or upcoming questions and then update their
  bot based on that preview." The bot is never changed because of what it
  forecast on questions that are still open or not yet launched. All learning
  uses closed questions. An optional weekly self-review task
  (`agent/REVIEW_TASK_PROMPT.md`) can score closed questions: a tool copies
  only questions closed more than 7 days ago into a separate folder, and the
  review reads only that folder; it writes proposals only into a
  `proposals/` folder and never edits the method. It is off until enough
  questions have closed; until then nothing reviews the bot. Method changes
  are pull requests the owner merges, each recorded with its date in the
  changelog of `agent/method.md`.
- **No re-runs.** The rules say: "a bot maker cannot decide that they don't
  like their bot's forecast and rerun the bot on that question". The bot never
  re-runs a question.
- **One forecast per question.** The agent writes each forecast file once and
  never rewrites it. If the tick refuses a file before posting it (it breaks
  a format rule), it may ask the agent once for a replacement file; only one
  file is ever posted. The tick posts a question only once: it keeps a
  ledger, claims each question in it before sending, and asks Metaculus for
  its own record before any later attempt.
- **A comment with every forecast.** The forecast and its private comment are
  sent together in one all-or-nothing request. The comment states the
  reasoning the bot really used and holds no personal data.
- **One prize bot.** This is the only primary bot of the owner.
- **No messages to staff** and no attempts to get around Cloudflare or other
  protection; the agent is told this in its prompt and runbook. Only the
  tick talks to Metaculus, through the API. The owner writes to Metaculus
  himself when needed.
- **Method changes** apply only to questions first sent after the change is
  merged, are judged on resolved or test questions, and are listed in the
  changelog. This is enforced: each wake-up names the commit of the kit
  (`kit_ref`) fixed at the question's first wake-up, the agent fetches
  exactly that commit, and the tick refuses a forecast file whose method
  version differs from the one recorded for that question.

## Automatic retries and shortcuts

Everything here is automatic and the same for every question. A reviewer
will see these in the public logs and the `state` branch.

- **Second wake-up.** If no forecast file exists 60 minutes after the first
  wake-up and at least 45 minutes are left, the tick wakes the agent once
  more for that question. This can run two sessions on one question at the
  same time; the forecast file written first wins and the other session
  finds the file and stops (the writer tool never overwrites a file). It is
  never a re-run of a finished forecast: it happens only when no forecast
  exists.
- **Replacement file.** If the tick refuses a file before posting it (it
  breaks a format rule, or it changed after the tick first saw it), it may
  ask once for a replacement (`forecasts/<id>.r2.json`), written from
  scratch. Only one file is ever posted. A replacement the tick did not ask
  for is refused.
- **Fast path.** When time is short, the agent does less research and three
  passes instead of five.
- **Fallback when sub-agents are not available.** The passes are then
  written one after another by one agent, so they are not independent. The
  log says so, and so does the posted comment ("passes written in sequence
  by one agent, not independent").
- **Wider clamp.** 1-99% instead of 2-98% only in the two cases above.
- **Daily wake-up budget.** After 12 wake-ups in a UTC day, a new question
  waits until it would have under 120 minutes left, and then every open
  question goes in one wake-up. After 14, no more wake-ups that day (the
  subscription caps its runs).
- **Batch hold.** New questions with more than 120 minutes left wait up to
  30 minutes, so several go out in one wake-up.
- **Group and conditional posts** wait until every part has a file, or until
  45 minutes before the deadline; then the parts that have files are posted.

## Running it live for a review

The owner can show the code here, then run the tick by hand
(Actions → tick → Run workflow, profile `test`). The test profile sends at
most one question of the bot testing area per tick and at most two wake-ups
a day, on its own counter, so a demo never uses the wake-ups of the prize
tournaments. The next tick posts the result.

## Major updates this season

See the changelog in `agent/method.md`.
