# Rules for the owner

The bot runs by itself. Your part is short: a few things you must never do,
a few duties only you can do, and two account settings.

## Never do these

The tournament rules say: "A bot maker cannot preview how their bot forecasts
on open or upcoming questions and then update their bot based on that
preview." and "a bot maker cannot decide that they don't like their bot's
forecast and rerun the bot on that question". So:

1. **Never look** at an open question's files or the bot's forecast on it.
   That means:
   - the folders `forecasts/`, `questions/`, `runs/`, `logs/` and
     `review-input/` in `forecaster-data`, and its commit history;
   - **the runs of the cloud tasks.** Every run of the `forecast` task (and
     of `heartbeat` and `review`) shows up as a session in your claude.ai
     code session list, with the full research, every pass and the
     forecast. Never open those sessions or their transcripts. Switch off
     notices for these tasks (claude.ai → the task → notifications off; and
     in the phone app's notification settings), so no notice shows you a
     forecast;
   - the Metaculus page of an open question the bot is in, if it could show
     you the bot's forecast.
   To check that things work, use only the public tick logs, the alert issue
   and the `state` branch: they show ids and codes, never forecasts.
2. **Never change the bot** (method, prompts, tools, settings) because of a
   question that is still open or not yet launched.
3. **Never re-run** a question, and never start the forecast task by hand for
   a question.
4. **Never tell the agent your own view** on a live question, in any chat or
   file. Do not talk about live questions with Claude at all.
5. **Never copy or paste a forecast** into Metaculus yourself.
6. **Never create a market or a question elsewhere** to help the bot.
7. **Never make a second Metaculus account** or a second prize bot. Your
   first bot is your one primary bot.
8. **Never make `forecaster-data` public** and never share its files.
9. **Never put a key into any file**, chat or issue. Keys go only into the
   places listed in `SECURITY.md`.

Method changes are allowed between runs, judged on closed questions only, as
a pull request you merge yourself. Each one gets a dated line in the
changelog of `agent/method.md`.

## The same rules bind any AI helper you use

The tournament's no-human-in-the-loop rule also binds an AI assistant that
helps you run this venture (for example a Claude session that maintains the
code). Give it these rules, and keep to them yourself:

- It must never list, open or read the sessions, events or transcripts of
  the `forecast`, `heartbeat` or `review` tasks.
- It must never read `forecasts/`, `questions/`, `runs/`, `logs/` or
  `review-input/` in `forecaster-data` for a question that has not closed.
  Simplest: it never reads `forecaster-data` at all, except
  `bootstrap.mjs`, `CLAUDE.md`, `.github/` and `test/`.
- It changes the kit (method, prompts, tools) only from evidence about closed
  questions, through a pull request that you merge.
- It never talks to Metaculus staff and never posts anything.

## Duties only you can do

| When | Duty |
|---|---|
| Once | Make the Metaculus account with an email you read every day, then the bot account (the real one: your first bot is the primary bot). |
| Once | Fill in the short **participation form** (3 required questions). |
| Every season | Fill in the **bot survey**. It is required to get prizes. |
| If asked | Be on a **code-review call** with Metaculus: show the code and run the bot live on a new question (Actions → tick → Run workflow, profile `test`). Never give anyone your Claude login or any token. |
| To be paid | Prove your **identity**, sign the **W-8BEN** (you are not a US resident; use your PAN as the foreign tax number), and give your **bank details** through Ramp (keep your bank's SWIFT code ready). |
| To be paid | **Answer the prize email within its deadline** (at most 180 days, often less). A missed deadline loses the prize. |
| When GitHub emails you | Read the "Forecaster needs attention" issue and do what it says (renew a token, switch the task back on, set up the clock). |
| When Google emails you | The Apps Script clock failed (the email names `startTick` or `checkTicks`). Open forecaster → Actions → tick, and see `ops/CLOCK.md`. |
| Once | GitHub → Settings → Notifications: keep email on for **Issues** of repositories you watch, and **Watch** `forecaster`. A failed tick run also emails you; only the run that found a new problem fails, so these emails stay few. Do not filter them away. |
| Once | `forecaster` and `forecaster-data` → Settings → General → tick **Automatically delete head branches**, so no old pull-request branch is left lying around. |
| When a token is renewed | Write the new date in `ops/EXPIRY.md`. |
| In January | Add the new season's tournament as `ops/SEASONS.md` says. |

Only you write to Metaculus staff (email or Discord). The agent never does.

## Two account settings for your Claude subscription

1. **Use the subscription only through the vendor's own scheduled tasks**
   (the `forecast` task, and the optional `heartbeat` task). Never place its
   login or any token from it in another tool, script, proxy or service, and
   never share it with anyone (Metaculus staff included).
2. **Switch off model training**: claude.ai → Settings → Privacy → turn off
   the setting that lets your chats be used to train models.

Also: keep one Claude account only. If you hit a usage limit, let the runs
wait; never work around a limit.
