# Answer format: numeric, discrete or date

The answer is a number (or a date). Give your full uncertainty as percentiles.

## First: the horizon and the series band

Before anything else, find these in the dossier and write them down at the
start of your reasoning:

1. **The horizon**: the number of days from the date of the last data point
   to the date whose value decides the question (the dossier's "Data series"
   section gives it). A longer horizon means a wider band.
2. **The series band for that horizon**: the 10th, 50th and 90th
   percentiles of past moves of the same length, applied to the latest value
   (the dossier lists them, with the 1st and 99th), and its width (90th minus
   10th).

**Start from the series band.** Your 10th and 90th percentiles begin at the
series band's 10th and 90th, and your 1st and 99th at its 1st and 99th.
Then move them for what the dossier says:

- **Shift** the whole band (not only the median) for dated evidence about the
  level: a futures or forward price, a scheduled release, a known event.
- **Widen** for anything that adds risk: a war, a crisis, a fresh regime
  change, a series that moved far in the last weeks, a short history.
- **Narrow** only with a stated, specific reason (for example a market's
  implied volatility for the same date that is clearly lower). Say how much
  and why. A band under 0.85 of the series band is widened back by the
  method anyway, so narrowing more than that changes nothing.

If the dossier has no data series, say so, and start from the base rate and
the latest value instead, with honest tails.

## Then: the question's fields

Read these fields in the question file (`range` and `unit`):

- `range_min` and `range_max`: the question's range. For a **date** question
  they are Unix seconds; give your answers as dates `YYYY-MM-DD` instead.
- `open_lower_bound` / `open_upper_bound`: `true` means the real answer may lie
  below the minimum (or above the maximum), and you may put percentiles there.
  `false` means the answer cannot go past that bound: keep every value inside.
- `zero_point`: if it is set, the question uses a log scale. Think in ratios
  (half, double), not in plain differences; the series band of a price is
  usually lopsided the same way (further up than down).
- `inbound_outcome_count` on a **discrete** question: the answer is one of a
  few whole numbers; the range runs half a step past the end values. Give
  percentiles that make sense for whole numbers.
- `unit`: say the unit in your reasoning, and check the order of magnitude
  against the range. A value 1,000 times too big or too small is a units
  mistake (thousands vs millions, percent vs fraction, cents vs dollars).

## The answer

Give these 13 percentiles: 1, 2.5, 5, 10, 20, 40, 50, 60, 80, 90, 95, 97.5, 99.
"The 10th percentile is X" means: a 10% chance the answer is below X.

- Values must not go down as the percentile goes up.
- **Tails matter.** The 1st and 99th percentiles are where surprises live;
  keep them at least as far out as the series band's own 1st and 99th unless
  you state why.
- Before you answer, compare your 10-90 width with the series band's width
  and write both numbers in one line.

Your final message ends with exactly one fenced json block, and nothing
after it. You return it as your reply; you never write a file (you have no
tools), and the main session saves your reply as your pass file:

```json
{"pass": <your pass number>, "framing": "<outside_view or inside_view>", "percentiles": {"1": v, "2.5": v, "5": v, "10": v, "20": v, "40": v, "50": v, "60": v, "80": v, "90": v, "95": v, "97.5": v, "99": v}, "reason": "<one line: the main reason>"}
```

Use plain numbers (no commas, no units inside the json), or `"YYYY-MM-DD"`
strings for a date question.
