# Answer format: multiple choice

This question has a fixed list of options (in the question file under
`options`). Give a probability to every option.

- Use the option names **exactly** as written in the question file, character
  for character: the same capitals, spaces, punctuation and accents. Copy them;
  do not retype or shorten them. An answer with a changed name is thrown away.
- Every option must appear, including ones you think are very unlikely. Give
  those a small number, not zero.
- The numbers should add up to 1.
- If the options are ranges of a number (for example "0-2", "3-5", "6 or
  more"), think about the whole distribution first, then read off the
  probability of each range. Check that the ranges cover every case.
- **Markets.** If the dossier has a per-option market table (one
  multi-outcome market, or a set of yes/no markets on the same event, mapped
  to the options), treat it as strong, dated evidence: say where you differ
  from it and why. Do not copy it. A fixed rule later blends a matched,
  liquid table with the passes, by its volume, so your job is your own view.
  If the dossier says the table covers only some options, or its prices do
  not add up to about 1, it is background only.

Your final message ends with exactly one fenced json block, and nothing
after it. You return it as your reply; you never write a file (you have no
tools), and the main session saves your reply as your pass file:

```json
{"pass": <your pass number>, "framing": "<outside_view or inside_view>", "probs": {"<option 1 exactly>": 0.40, "<option 2 exactly>": 0.35, "<option 3 exactly>": 0.25}, "reason": "<one line: the main reason>"}
```
