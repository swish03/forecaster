#!/usr/bin/env node
// Step 4 of a run: the main session checks each pass file right after it has
// saved the pass's reply, with the same rules aggregate.mjs uses. A missing
// or invalid pass is run once more before aggregating.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { PASS_FILE, checkPass, parsePassText } from './aggregate.mjs';
import { DataError, loadMethod, readJson, required, runCli } from './core/cli.mjs';

const HELP = `check-pass: check one saved pass file before aggregating.

Usage:
  node tools/check-pass.mjs --question <questions/ID.json> --pass <WORK/passes/pass-K.md>

The file must be named pass-<k>.md (or .json) and hold the pass's reply with
one fenced json block in the answer format for the question's type.
Prints { ok, file, problem? }.
Exit 0 = the pass is usable, 1 = missing or invalid (run that pass once more), 2 = wrong command.`;

export async function checkPassFile({ item, path, method }) {
  const file = basename(path);
  if (!PASS_FILE.test(file)) return { ok: false, file, problem: 'file name must be pass-<k>.md or pass-<k>.json' };
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { ok: false, file, problem: 'file missing: save the pass reply as this file' };
  }
  const result = checkPass(item, parsePassText(text, file), method);
  return result.ok ? { ok: true, file } : { ok: false, file, problem: result.reason };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: { question: { type: 'string' }, pass: { type: 'string' } },
  async main(values) {
    required(values, 'question', 'pass');
    const item = await readJson(values.question, 'question file');
    if (item === null || typeof item !== 'object') throw new DataError('question_not_object');
    const report = await checkPassFile({ item, path: values.pass, method: await loadMethod() });
    if (!report.ok) process.exitCode = 1;
    return report;
  },
});
