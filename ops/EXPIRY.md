# When keys expire

Every key the bot uses is listed here. Write each expiry date in the
**Expires** column as `YYYY-MM-DD` when you make or renew the key. Leave the
cell empty if the key has no expiry date.

The tick reads this table on every run. When a date is **21 days away or
less** (or already past), it opens the "Forecaster needs attention" issue, so
GitHub emails you. Change this file with a pull request, like any other file.

| Token | Where it lives | What it can do | Expires (YYYY-MM-DD) | How to renew |
|---|---|---|---|---|
| METACULUS_TOKEN | `forecaster` → Settings → Environments → `metaculus` → secrets | Act as the Metaculus bot account: read questions, post forecasts and comments. |  | metaculus.com → Settings → My Forecasting Bots → the bot → new key. Paste it over the secret. |
| ROUTINE_FIRE_TOKEN | Same environment (next to `ROUTINE_FIRE_URL`) | Start the cloud task `forecast`. Nothing else: it cannot read anything. |  | claude.ai/code/routines → the task → Edit → API trigger → Regenerate. Paste it over the secret. The old token stops at once. |
| DATA_REPO_TOKEN (`forecaster data read`) | Only in `forecaster` → Settings → Environments → `metaculus` → secrets | Read the files of `forecaster-data` (Contents: read, that repository only). | 2027-11-13 | github.com → Settings → Developer settings → Fine-grained tokens → the token → Regenerate (same repository, same permission, longest expiry). Paste it over the secret, then write the new date here. The tick also warns 21 days ahead by itself, from GitHub's answers. |
| TICK_DISPATCH_TOKEN (`forecaster dispatch`) | Two places, same value: `forecaster-data` → Settings → Secrets and variables → Actions; the `TICK_DISPATCH_TOKEN` script property of the Apps Script clock | Start and read runs of the tick (Actions: read and write, `forecaster` only). Nothing else. | 2027-11-13 | The same page → the token → Regenerate (same repository, same permission, longest expiry). Paste the new value into both places, then write the new date here. When it expires, the Apps Script clock fails and Google emails you. |
| GITHUB_TOKEN | Made by GitHub for each tick run | Write the `state` branch, the alert issue, re-enable the tick, read its runs. | never | Nothing to do: GitHub makes a new one for every run. |

## Notes

- GitHub also emails you about a week before a fine-grained token expires.
- Never choose the 30-day default for the two GitHub tokens. Choose the longest
  expiry GitHub offers and write the date above.
- After renewing a key, run the tick by hand once with `dry_run` ticked
  (Actions → tick → Run workflow) and check that it is green.
