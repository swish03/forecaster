# Weekly self-review (read only towards every forecast)

This prompt is for the optional weekly task in `agent/REVIEW_TASK_PROMPT.md`.
It scores past forecasts and may write a proposal. It never forecasts, never re-runs a question, never changes
a file in `forecasts/` or `questions/`, never contacts Metaculus or its site,
never edits the method, and never changes the public repository. The only
files it may create are `reviews/<YYYY-MM-DD>.md` and
`proposals/<YYYY-MM-DD>.md` in the private data repository.

**The tournament's rule, in its own words.** The bot tournament rules say:
"A bot maker cannot preview how their bot forecasts on open or upcoming
questions and then update their bot based on that preview." And: "a bot maker
cannot decide that they don't like their bot's forecast and rerun the bot on
that question". So this review uses **closed questions only**. It never reads,
counts or mentions a forecast, dossier or log line of a question that is still
open or not yet launched, and no proposal may be based on one.

A proposal is only a proposal. The method changes only when the owner merges
a pull request in the public repository; each such change is recorded with
its date in the changelog of `agent/method.md`.

Steps:

1. **Collect the closed questions with the tool, never by hand.** Run
   ```
   node KIT/agent/tools/closed-questions.mjs --data DATA --out DATA/review-input --min-days 7
   ```
   It copies the files of questions closed more than 7 days ago (question,
   forecast, card, dossier, aggregate, comment and that question's own log
   lines) into `DATA/review-input/<stem>/`. **Read only that folder.** Never
   open `forecasts/`, `questions/`, `runs/` or `logs/` yourself: they also
   hold questions that are still open. Git ignores `review-input/`. Keep a
   question only if its resolution date (from its `card.md`) has passed.
2. **Find each outcome** from the resolution source named in the criteria
   card, on the public web. Write the outcome, the date, the link, and how
   sure you are (`certain`, `likely`, `unclear`). Use `unclear` when the source
   is ambiguous or not yet updated, and leave that question out of the scores.
   These outcomes are self-checked, not Metaculus's official resolutions; say
   so at the top of the review.
3. **Score.**
   - Binary: Brier score `(p - outcome)^2` and log score `ln(p)` of the
     outcome that happened.
   - Multiple choice: log score of the probability given to the right option.
   - Numeric, discrete, date: read the CDF at the outcome (its position on the
     grid) and give the probability of landing within one grid step; flag any
     outcome outside the 5-95 band.
4. **Write `reviews/<date>.md`:**
   - counts, from the `log.md` files in `review-input/` only: forecast,
     skipped, fast path, passes dropped, flags raised;
   - calibration by probability bucket (0-10%, 10-30%, 30-70%, 70-90%,
     90-100%) and by question type;
   - the 10 worst questions: for each, read the comment and the dossier, find
     the fact that decided the outcome, and say whether research missed it,
     the criteria were misread, or it was plain bad luck;
   - how the market or community blend did against the plain median of the
     passes (score both).
5. **Write `proposals/<date>.md`** only if there is a clear, repeated
   problem. One change at a time, for example one prompt sentence, one
   research step or one guardrail number. For each proposal: the evidence
   (question ids), the exact change, and the expected effect. Remember the
   rules: changes apply only to questions that open after the change is
   merged; in season only bug fixes that stop missed or rejected forecasts;
   anything bigger waits for the break between seasons; Platt recalibration is
   considered only after 150 resolved yes/no questions.
   End every proposal with the line: `Evidence: closed questions only.`
6. Commit only these two files and push to `main` of the data repository
   (pull with `--rebase` and push again if the push is refused).

Never re-forecast, edit, delete or "correct" a forecast file, even if it looks
wrong. A forecast is final once written. Never edit `agent/method.md`,
`agent/method.json`, a prompt or a tool, not even a copy in `kit/`.
