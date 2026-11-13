# The forecasting method

**Version 1.3** (the exact numbers are in `method.json`; the tools read them
from there, so this page and the code cannot drift apart).

This page explains in plain words what the bot does with each question. The
research behind every choice is in the venture's research notes on the
Metaculus method (what prize-winning bots do, with sources).

## The idea in one paragraph

Most of a bot's score comes from three things: reading the question exactly
right, finding the facts that decide it, and not making silly mistakes. So the
bot first writes down what exactly counts, then researches, then asks five
independent "forecasters" (the same AI model, with no tools and no view of
each other's answers) for a number, takes the middle one, nudges it toward a
liquid betting market on the very same question if there is one, and keeps it
away from 0% and 100%.

## Step by step

1. **Save the question** exactly as received. Skip it only if fewer than 30
   minutes are left before its deadline (the earliest of its close and
   scoring times) or it already has a forecast. Every forecast is pushed at
   least 25 minutes before the deadline, so the posting job (started by the
   push itself and by a 15-minute clock) has at
   least two chances to post it.
2. **Criteria card** before any searching: the exact event, the source, the
   date, which events count, the unit, the status quo, and the rule "assume it
   has not already happened unless the criteria say a past event counts".
3. **Research** in a fixed order: the resolution source and its history,
   scheduled events, the base rate, prediction markets (Polymarket, Kalshi,
   Manifold), and a final check for the three most important missing facts.
   Every fact in the dossier carries the URL it came from. Research runs on
   a cheaper model tier when the sub-agent tool offers one
   (`model_tiers` in `method.json`); the passes and the main session use the
   task's own tier.
   The agent never opens the Metaculus site or API (only the tick does), so
   the Metaculus community prediction is not used.
4. **Five independent passes** (three on the fast path). Each pass is a
   sub-agent with no tools, started by the main session. It sees the
   question, the criteria card and the dossier (not the signals file), and
   returns its answer as its final message; the main session saves that
   reply as the pass file and checks it at once (`check-pass.mjs`), running
   a missing or broken pass once more. Passes 1, 3 and 5 start from the
   outside view (how often do things like this happen?); passes 2 and 4 start
   from the inside view (what is happening now, what is scheduled?). Numeric
   passes start from the data series' own band for the horizon. Each pass
   gives:
   - yes/no: one probability;
   - multiple choice: a probability for every option;
   - numbers and dates: 13 percentiles (1, 2.5, 5, 10, 20, 40, 50, 60, 80, 90,
     95, 97.5, 99).
5. **Combine** (tool `aggregate.mjs`):
   - yes/no: the median of the passes;
   - multiple choice: the median per option, then every option at least 1%,
     then scaled to add up to 100%;
   - numbers and dates: each pass becomes a curve (a CDF) and the bot takes the
     middle curve point by point. It never averages the percentile numbers
     themselves, which is known to lose points in the tails.
   - Passes with a units mistake (a median more than 3 range-widths outside
     the question's range, or a spread under 1/1000 of the range) or with
     wrong option names are thrown away. For a question on a log scale,
     "range-width" is measured along that log scale, the same way the CDF is.
   - The comment states the median and the 10-90% band of the curve that is
     actually posted. If that median is far from the passes' median, or the
     per-bin limit had to flatten a very confident curve, a warning flag is
     set.
   - Fewer than 3 usable passes: the missing ones are re-run once.
   - Fewer usable passes than the method requires (5, or 3 on the fast
     path): the forecast is still made, and the flag
     `fewer_passes_than_required` goes into the forecast file's checks and
     the comment.
   - **Series guard** (numbers and whole-number counts): when the research
     found a data series, and the curve's 10-90% band is narrower than 0.85
     of the series' own 10-90% band over the same horizon
     (`series_band_min_share`), the whole curve is widened around its median
     (along the question's own linear or log scale), and this is flagged and
     stated in the comment. The factor is the largest safe one that is not
     above the factor needed for that width nor `series_band_max_factor`
     (3), found by bisection. A factor is safe when the curve passes the CDF
     check, its 10th and 90th percentiles stay inside the question range,
     the median moves by less than one bin, and on each side at most
     `series_band_max_outside_growth` (0.05) extra probability lands
     outside an open bound or in the edge region of a closed bound. The edge
     region is the 2 outermost bins of each closed bound: values stretched
     past a closed bound are folded into those bins, so that is where mass
     would pile up. Reaching the width is flagged `band_widened_to_series`;
     a smaller safe factor is flagged `band_widened_partly` with
     `band_widen_capped_by_<reason>` (`bounds`, `max_factor`,
     `outside_mass_lower`/`_upper`, `edge_mass_lower`/`_upper`); only
     when no factor above 1.01 is safe is the unwidened curve kept
     (`band_guard_skipped_<reason>`). A series band that is not a positive
     number is ignored, with a flag.
   - Passes are counted by pass number: two files for one number count once,
     and numbers outside 1 to the required count are ignored; both are
     flagged.
6. **Blend toward a signal** (yes/no and multiple choice only). If a real-money
   market asks the very same question, or the Metaculus community has enough
   forecasters, the bot moves part of the way toward it:

   | Signal | Weight |
   |---|---|
   | Market volume under $10,000 | 0 |
   | $10,000 to $50,000 | 0.15 |
   | $50,000 to $250,000 | 0.30 |
   | Over $250,000 and a bid-ask spread of 4 points or less | 0.50 |
   | Over $250,000 with a wider or unknown spread | 0.30 |
   | Metaculus community, 30 to 99 forecasters | 0.25 |
   | Metaculus community, 100 or more forecasters | 0.40 |

   For yes/no the blend is done in log-odds:
   `final = (1 − w)·logit(median) + w·logit(signal)`.
   For multiple choice it is done option by option, then re-scaled, and only
   with a per-option market table that covers every option: one
   multi-outcome market, or a set of yes/no markets on the same event, mapped
   to the options by the research step and priced by a tool from the market
   data (never typed). The table gets the same volume weights (a set of
   markets counts its smallest market's volume), the 1% floor and
   re-scaling. A table that covers only some options, maps two options to
   one market, or whose prices do not add up to 1 within 8 points, is not
   blended, and a flag names the reason. A table without the tool's marker
   and a matching hash of its option names and prices (typed or edited by
   hand) is not blended either, and is flagged.
   A matched market with weight above 0 is used first; the community only
   when no such market exists. **The community signal is switched off**
   (`community_enabled: false` in `method.json`) and stays off: the Metaculus
   Terms of Use forbid reading the site by automated means, and the agent
   never contacts Metaculus. Its weight is 0. Manifold is play money, so it never gets weight.
   Markets that are only "related" never get weight.
7. **Clamp** yes/no forecasts to 2%-98%. The wider 1%-99% is allowed only when
   all five passes are already beyond 2% or 98% on the same side **and**
   either the question resolves within 72 hours with the status quo holding,
   or a deep market (weight 0.50) agrees (5% or less, or 95% or more).
   The bot never "extremizes" (pushes forecasts further from 50%).
8. **Checks that only warn** (they go into the log and the weekly review, and
   never cause a second forecast): the median is more than 25 points from the
   signal; the passes disagree by more than 40 points; a forecast above 90% on
   a question whose status quo is No; a numeric 10-90% band (before the series
   guard) narrower than half the usual move of the data series over the same
   time; fewer passes than required; a multiple-choice market table that
   could not be blended.
9. **Build the CDF** for numbers and dates following Metaculus's own rules
   (shared code in `lib/cdf.mjs`): the right number of points for the
   question, strictly rising, the required minimum and maximum steps, the
   right values at open and closed bounds.
10. **Comment.** A fixed format: the forecast, the question as read, the
    status quo, three dated pieces of evidence with links, the base rate, the
    market or community used and its weight, the five pass values, and the
    main risk.
11. **Write once.** The forecast file is checked with the same validator the
    posting job uses, then written. It is never changed again.

## Rules about changing the method

The tournament rules say, word for word: "A bot maker cannot preview how
their bot forecasts on open or upcoming questions and then update their bot
based on that preview." and "a bot maker cannot decide that they don't like
their bot's forecast and rerun the bot on that question".

- **Learning uses closed questions only.** Nothing is changed because of what
  the bot forecast on a question that is still open or not yet launched.
- **The agent never edits the method.** The weekly self-review writes
  proposals into `proposals/` in the private data repository, and that is
  all. A change happens only as a pull request in this repository that the
  owner merges, and each one is recorded with its date in the changelog
  below (Metaculus asks prize winners to describe significant updates).
- **No re-runs.** A question is never forecast again.
- The owner never shares his own views on live questions with the agent.
- A change applies only to questions first sent to the agent after the change
  is merged (in practice: questions that open later). No
  forecast already made is ever redone. This is enforced, not only promised:
  the tick records the commit of its kit (`kit_ref`) and the method version
  at a question's first wake-up; every later wake-up of that question (a
  second wake-up or a replacement request) uses the same kit, the agent's
  tools refuse another kit, and the tick refuses a forecast file with another
  method version.
- During a season only bug fixes that stop missed or rejected forecasts. Bigger
  changes wait for the break between seasons, one change at a time.
- Changes are judged on resolved questions or the unscored bot testing area,
  never on open tournament questions.
- Every change bumps the version above and gets a line in the changelog.
- Recalibration from the bot's own history is considered only after 150
  resolved yes/no questions, and kept only if it helps on the later half.

## Honest odds (what to expect)

From the public Metaculus leaderboards of the last three seasons, checked on
12 Nov 2026. These are estimates with wide ranges, not promises.

- **How prizes are split.** Each paid bot gets
  50,000 × (its score²) ÷ (the sum of all paid bots' score²). Squared scores
  pile the money up at the top. A share under US$50 (about Rs 4,800) is not
  paid at all.
- **Coverage matters most.** Outside bots that forecast at least 95% of the
  questions were paid 15 of 18, 12 of 18 and 23 of 27 times in the last
  three seasons. Bots at 60-80% coverage were paid only 7 of 13, 4 of 11 and
  2 of 15. Never missing a question is worth more than any method tweak. This
  is why the clocks (`ops/CLOCK.md`) and alerts matter.
- **One season at 95% coverage or more:** about a 50-65% chance of any prize.
  The median prize is about US$350-450 (Rs 34,000-43,000), the mean about
  US$520-620; the expected value is about US$260-390 per season. A top-10
  place (over US$2,000) is only a 1-4% chance.
- **One season at about 70% coverage:** about a 30-45% chance; median about
  US$250, expected about US$140-210.
- **MiniBench:** about a 10-15% chance per round at full coverage, about
  US$90 if paid.
- **Year one in total:** expected about US$670-1,000 (Rs 64,000-96,000) at
  95% coverage, US$310-470 at 70%. The chance of earning **nothing at all**
  in the first 12 months is about 25-35% even at 95% coverage, and 35-45% at
  70%.
- **Money comes late.** A season pays only after every question has resolved
  and the survey is done. Fall 2026 money is realistically April 2027.
- **The 2027 prize pools are not confirmed.** The participate page says
  "~$50k · 3x/year", but no Spring 2027 tournament was published on
  12 Nov 2026. Re-check in early January.
- **The field keeps growing.** Outside bots went from 73 to 115 to 203 in the
  last three seasons, and Fall 2026 already lists 397, while paid places stay
  around 30-41. Stronger models lift the whole field and the cut line too, so
  only a real edge over other agent bots earns money.
- Possible US tax withholding on a prize to a non-US person (up to 30%) is
  not confirmed by any Metaculus page; plan for it.

## Changelog

- **1.3** (13 Nov 2026, after a practice round on six made-up questions,
  before any live forecast; it applies only to questions first sent with a
  kit of this version or later):
  - Missing passes: aggregate knows how many passes the method requires (5,
    or 3 on the fast path, `fast_path_passes`) and flags a shortfall in the
    forecast file's checks and the comment's Passes line; the main session
    checks each pass file right after the pass returns (`check-pass.mjs`)
    and runs a missing or broken pass once more.
  - How a pass delivers its answer is fixed: a pass has no tools and returns
    its answer as its final message; only the main session saves it, and
    only the main session starts passes. A pass never sees the signals file.
  - Time: the plan has two modes, parallel (3 or more questions and
    sub-agents: research at once, only the main session's own work queues)
    and sequential (one question after another). Each question gets its
    real budget in its mode, the fast path states its reason, and the plan
    is saved to `runs/plans/`. check-run can check one question.
  - Series guard for numeric and discrete questions: a 10-90% band narrower
    than 0.85 of the series band for the horizon is widened around its
    median and flagged. The numeric answer format starts each pass from the
    series band and the horizon.
  - Multiple choice can be blended with a per-option market table (one
    multi-outcome market or a set of yes/no markets on the same event),
    built by `option-market.mjs` from the market data, with the yes/no
    volume weights, the floor and re-scaling; a partial table or a bad sum
    is not blended and is flagged.
  - After an independent check of these fixes (same day, still 1.3):
    - The series guard's search is bounded: bisection for the smallest
      factor from 1 to `series_band_max_factor` (3); a 10th or 90th
      percentile outside the range is an upper limit, not "too narrow".
      After widening, the curve must pass the CDF check, add at most
      `series_band_max_outside_growth` (0.05) mass outside each open bound
      and keep the median within one bin; otherwise the unwidened curve is
      kept with a `band_guard_skipped_<reason>` flag. A series band given
      as a string or a non-positive number is ignored with a flag.
    - After a second check: the same 0.05 limit now also holds for closed
      bounds, measured as the extra mass in the 2 outermost bins of each
      closed bound (it had piled up there by up to 0.18). The limits are part
      of the search: the guard uses the largest factor for which every check
      holds (`band_widened_partly` when that is short of the target)
      instead of dropping the whole widening; it is skipped only when no
      factor above 1.01 is safe. The checks record the factor, the needed
      factor, the widths before and after and the mass change per side.
    - Passes are counted by pass number: two files for one number count
      once, numbers outside 1 to the required count are ignored, both with
      a flag, so a shortfall cannot be hidden.
    - A multiple-choice market table is blended only when it carries
      option-market's marker and a hash of its option names and prices that
      aggregate re-checks; a hand-typed table is flagged
      (`option_market_not_from_tool`). The tool's refusal reasons reach the
      flags by name (`option_market_partial`, `option_market_bad_sum`,
      `option_market_duplicate_market` when two options map to one market).
      A set of yes/no markets uses its smallest market's volume for the
      blend weight, not the sum.
    - RUNBOOK: a pass is run at most twice in total (the first run and one
      re-run).
  - Cheaper research: `model_tiers` in `method.json` (research on a cheaper
    tier, passes and the main session on the task's tier); the tier is in
    the log line.
  - Smaller fixes: the status quo in the signals is refreshed after
    research; every dossier fact carries its URL; the card's word limit is
    checked before research (`check-card.mjs`); notes on data sources (live
    last points, a one-day lag on index series, sites that refuse plain
    clients, data gaps); a clear limit on market queries; a documented
    practice mode (intake refuses practice and tournament questions mixed);
    the validation command is named in the runbook.

- **1.2** (12 Nov 2026, before any live forecast; it applies only to
  questions first sent with a kit of this version or later, because every
  question keeps the kit of its first wake-up):
  - `series.mjs` turns a horizon in days into steps with the average spacing
    of the history, not the median gap. For business-day data (prices, FRED
    daily series) the old way made the horizon about 45% too long and the
    history band about a third too wide. The research plan now says exactly
    which days the horizon counts (last observation to the measured day) and
    that data series are downloaded with code, never retyped.
  - Multiple-choice questions are never blended with a market (the market
    tool cannot give one price per option name; before, this was possible
    only with numbers typed by hand). A yes/no event split over several
    sibling markets gets no market weight either.
  - The comment's Forecast line names the part of a group or conditional
    post, and the Passes line says "not independent" when one agent wrote
    the passes in turn. The writer tool refuses a comment that does not hold
    this aggregate's three lines word for word.
  - The yes/no answer format has its own prompt file (`prompts/binary.md`),
    so each pass sees exactly one answer format.
  - Process only (no numbers): the main session starts all sub-agents
    (research sub-agents per question, then the pass sub-agents); one time
    rule (the plan's budget and fast path); the kit is fetched at the commit
    named by the wake-up (`kit_ref`).

- **1.1, notes only** (12 Nov 2026, before any live forecast; no number or
  rule of forecasting changed, so the version stays 1.1): the agent gets its
  files through `bootstrap.mjs` and `agent/MANIFEST.json` instead of a git
  clone; the agent never reads the Metaculus site (the community signal stays
  off for good); the rules about changing the method are quoted from the
  tournament rules, and self-review proposals go to `proposals/`; several
  questions are worked on in parallel, one sub-agent per question; the odds
  section was added.
- **1.1** (12 Nov 2026, before any live forecast): skip under 30 minutes
  (was 20) and push at least 25 minutes before the deadline (was 10), so
  posting has time; time counts down to the earliest close or scoring time;
  a matched market is used before the community (as in the research notes);
  the community signal is switched off until the rules are checked; numeric
  unit checks and the closed-bound handling work along the question's own
  (log or linear) scale; the comment states the posted curve's median;
  CDF steps keep a small margin above the minimum; replacement files
  (`forecasts/<id>.r2.json`) only when the posting job asks for one.
- **1.0** (12 Nov 2026): first version. Criteria card, fixed research plan,
  five no-tool passes with alternating outside/inside framing, median
  aggregation, pointwise CDF median, liquidity-weighted blend, 2-98% clamp,
  1% multiple-choice floor.
