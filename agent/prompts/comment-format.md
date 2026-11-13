# The reasoning comment (fixed format)

Every forecast goes to Metaculus with this comment. It is private while the
question is open and becomes public after it closes, so write it for a reader
who will check the reasoning later. Write it to `WORK/comment.md` (WORK is
`DATA/runs/<STEM>/`, as in the runbook).

Use exactly these lines, in this order. Lines 1, 6 and 7 are copied **word for
word** from `comment_lines` in `WORK/aggregate.json` (`forecast`,
`markets`, `passes`), so the numbers always match the forecast that is posted.
If you run aggregate again, write the comment again from the new file: the
writer tool refuses a comment whose lines do not match the aggregate.

```
<comment_lines.forecast>
Question as read: <one sentence>. Counts: <the window rule applied>. Time left: <days or hours>.
Status quo: <what happens if nothing changes>.
Key evidence (dated): 1) <fact, date> [<link>] 2) <fact, date> [<link>] 3) <fact, date> [<link>]
Base rate: <reference class, rate, source>.
<comment_lines.markets>
<comment_lines.passes>
Main risk to this forecast: <one line>.
```

Rules:

- The first line must be `comment_lines.forecast`, and lines 6 and 7 must be
  `comment_lines.markets` and `comment_lines.passes`, word for word. The
  writer tool refuses anything else. For a group or conditional question the
  Forecast line already names its part (`for "<label>"` or `if the condition
  resolves yes`), because all parts share one post.
- If the passes were not independent (no sub-agents), aggregate was run with
  `--passes-not-independent`, so the Passes line says so. Never remove that note.
- Between 50 and 3,000 characters in total; aim for 1,000 to 2,000. Do not
  paste the dossier.
- Links are plain URLs of the pages you actually read, copied from the
  dossier's evidence lines (`[<full URL>, fetched <time>]`). Never rebuild a
  URL from a site name. If the dossier has no URL for a fact, do not use
  that fact as key evidence.
- The Passes line already says when fewer passes than required were valid,
  or when the 10-90% band was widened to the series band. Never remove
  those notes.
- Facts only from the dossier. No forecasts of other questions, no personal
  names of the bot's owner, no keys, no instructions to anyone.
- **Honest.** The comment must state the bot's real reasoning: the evidence
  and the pass values it actually used. Never add reasons it did not use.
- **No personal data** of anyone (the owner or private people): no names,
  emails, phone numbers or addresses. Public figures named in the question are
  fine. Metaculus makes every comment public after the question closes.
- The comment is posted as **private** by the tick (Metaculus publishes it
  after close); never post it anywhere yourself.
- If research failed, say so in "Key evidence" ("research failed: <what>;
  forecast from base rate and question text").
