#!/usr/bin/env node
// Step 2 of a run: checks the criteria card before any research starts. The
// card must have every field of prompts/criteria-card.md and stay within the
// word limit in method.json (criteria_card_max_words).

import { readFile } from 'node:fs/promises';

import { DataError, loadMethod, required, runCli } from './core/cli.mjs';

const HELP = `check-card: check WORK/card.md before research.

Usage:
  node tools/check-card.mjs --card <WORK/card.md>

Only your own words count (not the heading, the field labels or the fixed last line).
Prints { ok, words, max_words, missing_fields }.
Exit 0 = the card is fine, 1 = too long or a field is missing (shorten or fix it, then check again), 2 = wrong command.`;

export const CARD_FIELDS = [
  'Resolvable event:', 'Resolution source:', 'Resolves on:', 'Which events count:', 'Time left:',
  'Unit and scale:', 'Status quo outcome:', 'Traps:',
];

export const countWords = (text) => String(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const FIXED_LINE = /^Assume the event has not already happened/;
const LABELS = [...CARD_FIELDS, 'What a "No" (or an out-of-range value) looks like:'];

// Only the card writer's own words count: the heading, the field labels and
// the fixed last line of the template do not.
export function ownWords(text) {
  return String(text).split('\n')
    .filter((line) => !/^\s*#/.test(line) && !FIXED_LINE.test(line.trim()) && !/^\s*```/.test(line))
    .map((line) => LABELS.reduce((l, label) => l.replace(label, ' '), line))
    .reduce((n, line) => n + countWords(line), 0);
}

export function checkCard(text, method) {
  const max = method.criteria_card_max_words;
  const words = ownWords(text);
  const missing = CARD_FIELDS.filter((f) => !text.includes(f));
  return { ok: words <= max && missing.length === 0, words, max_words: max, missing_fields: missing };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: { card: { type: 'string' } },
  async main(values) {
    required(values, 'card');
    const text = await readFile(values.card, 'utf8').catch(() => {
      throw new DataError('file_unreadable', values.card);
    });
    const report = checkCard(text, await loadMethod());
    if (!report.ok) process.exitCode = 1;
    return report;
  },
});
