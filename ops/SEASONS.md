# Seasons and tournaments

What is known on 12 Nov 2026. Re-check the Metaculus pages before each
season: dates and prize pools can change.

## The calendar known today

| Tournament | Slug (id) | Dates | Prize pool | In the bot? |
|---|---|---|---|---|
| Fall 2026 FutureEval | `fall-futureeval-2026` (33121) | Started 28 Sep 2026. Forecasting ends 6 Jan 2027. Closes 5 Mar 2027. New questions stop a few weeks before 1 Jan 2027. | US$50,000 | Yes (`live`) |
| MiniBench | `minibench`, plus the two latest dated rounds `minibench-YYYY-MM-DD` | A new round every second Monday. The round of 2 Nov 2026 runs to 20 Nov; the next starts Mon 16 Nov 2026. | US$1,000 per round | Yes (`live`) |
| Bot testing area | `bot-testing-area` (32977) | Always open, not scored | none | Yes (`test`) |
| Market Pulse 26Q4 | `market-pulse-26q4` (33131) | 7 Oct to 31 Dec 2026 | US$7,500 | **No**: it needs forecasts updated again and again, which this bot does not do |
| Spring 2027 FutureEval | not published yet (`spring-futureeval-2027` answered 404 on 12 Nov 2026) | Expected early January 2027 (seasons start every January, May and September) | "~$50k" on the participate page, **not confirmed** | Not yet |

Prizes (MiniBench too) are paid with the season prizes, after every question
of the season has resolved and the season survey is done. Fall 2026 money is
realistically April 2027. No prize under US$50 is paid.

## Week 1 check (owner, once)

This finds out what Metaculus answers for a tournament slug it does not
know. Only a tick on `main` gets the keys, so:

1. With a pull request, add a made-up optional slug to
   `profiles.live.tournaments`, for example
   `{ "slug": "no-such-tournament-xyz", "optional": true }`, and merge it.
2. Run Actions → tick → Run workflow with `dry_run` ticked.
3. Read the log. No line about that slug means Metaculus answered 404, 400
   or an empty list. A line `tournament no-such-tournament-xyz: listing
   failed (... HTTP <code>)` shows any other code.
4. Remove the made-up line again with a second pull request.
5. Write what you saw here: `unknown slug answers: ______ (date ______)`.
   If it was another code, tell the developer, so `optional` can accept it.

MiniBench dated rounds: the tick guesses the two latest round slugs from a
strict 14-day cycle starting 21 Sep 2026. If Metaculus skips a round (for
example around 28 Dec), the guesses are wrong but harmless (they are
optional); the plain `minibench` slug still finds the running round, and
`no_live_questions` would show a real gap.

## Each season (owner)

- Fill in the **bot survey** for the season. It is required to get prizes.
- Read the new season's rules page. Check that a fully autonomous bot is
  still allowed and that nothing changed about comments or one forecast per
  question.

## How to add a new tournament (for example in January)

Only the owner changes this repository, with a pull request that he merges.
The cloud agent cannot do it (this repository is not attached to it).

1. Find the slug: open the tournament's page on metaculus.com. The slug is
   the last part of the address, for example
   `metaculus.com/tournament/spring-futureeval-2027/` → `spring-futureeval-2027`.
   If the page shows the numeric id, note it too.
2. Open `poster/config.json` and add a line to `profiles.live.tournaments`:
   ```json
   { "slug": "spring-futureeval-2027", "optional": true }
   ```
   `"optional": true` means the slug is only **probed**: if Metaculus does not
   know it yet (HTTP 404 or 400), the tick treats it as empty and does not
   fail. So you may add an expected slug a few days early. Which of the two
   codes Metaculus really sends for an unknown slug is not documented; see
   "Week 1 check" below.
3. Once the tournament is live and its questions show up, change the line to
   the confirmed form with its id, without `optional`:
   ```json
   { "slug": "spring-futureeval-2027", "id": 33300 }
   ```
   (33300 is only an example: use the real id). Without `optional`, a slug
   that Metaculus answers with 404 opens the alert issue (`metaculus_setup`).
   But Metaculus may also answer a wrong slug with an empty list, which looks
   like "no questions today". That is why there is a second safety net:
   when the tick finds **no** open, unforecast question in any live
   tournament for **3 days**, it opens the alert issue (`no_live_questions`).
   A forgotten January step or a wrong slug is then noticed within 3 days,
   not at the end of the season.
4. When a season has ended (its forecasting end date has passed), remove its
   line.
5. Make the change on a new branch, open a pull request, wait for the green
   `lint` check, and merge it. The next tick uses the new list.
6. Run Actions → tick → Run workflow with `dry_run` ticked and check the log
   lists the new tournament without errors.

Never add or change a tournament because of what the bot forecast on an open
question. Changing which tournaments the bot enters is fine; changing how it
forecasts follows the rules in `agent/method.md`.
