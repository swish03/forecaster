#!/usr/bin/env node
// Copies the files of CLOSED questions only into one folder for the weekly
// self-review, so the review never opens forecasts/, runs/ or logs/ itself
// and never sees a question that is still open.
//
// A question counts as closed when the latest of its saved deadline and its
// scheduled close time is more than --min-days days ago. The margin covers a
// close that Metaculus moved later after the question was saved.

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DataError, readJson, required, runCli, writeJson } from './core/cli.mjs';

const HELP = `closed-questions: copy the files of closed questions for the weekly review.

Usage:
  node tools/closed-questions.mjs --data <data repo folder> --out <folder>
       [--min-days 7] [--now <ISO time>]

For every questions/<stem>.json whose deadline and scheduled close time are
both more than --min-days days in the past, it copies into --out/<stem>/:
question.json, forecast.json (if any), card.md, dossier.md, aggregate.json,
comment.md (if they exist), and log.md with that question's own log lines.
Nothing of an open question is copied. --out is emptied first.
Prints { closed: [...], open_left_out: <count> }.
Exit 0 = done, 1 = bad data, 2 = wrong command.`;

const STEM = /^([1-9]\d{0,11})(\.r2)?\.json$/;
const WORK_FILES = ['card.md', 'dossier.md', 'aggregate.json', 'comment.md'];
const DAY_MS = 86400000;

const exists = async (path) => readFile(path).then(() => true, () => false);

// The latest moment the question could still be open, or null if unknown.
function lastOpenMs(item) {
  const times = [item?.deadline, item?.scheduled_close_time].map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// Only lines of the form "- <stem>: ..." (or "- <id>: ...") belong to a question.
function logLinesFor(text, id) {
  const head = new RegExp(`^- ${id}(\\.r2)?:`);
  return text.split('\n').filter((line) => head.test(line));
}

export async function closedQuestions({ dataDir, outDir, minDays = 7, nowMs = Date.now() }) {
  if (!(minDays >= 1)) throw new DataError('min_days_invalid', 'at least 1 day');
  let names;
  try {
    names = await readdir(join(dataDir, 'questions'));
  } catch {
    throw new DataError('questions_unreadable', join(dataDir, 'questions'));
  }
  const logs = [];
  try {
    for (const name of (await readdir(join(dataDir, 'logs'))).filter((n) => n.endsWith('.md')).sort()) {
      logs.push(await readFile(join(dataDir, 'logs', name), 'utf8'));
    }
  } catch {
    // No logs folder yet.
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const closed = [];
  let openLeftOut = 0;
  for (const name of names.sort()) {
    const m = name.match(STEM);
    if (!m) continue;
    const stem = name.slice(0, -'.json'.length);
    const item = await readJson(join(dataDir, 'questions', name), name);
    const last = lastOpenMs(item);
    if (last === null || nowMs - last <= minDays * DAY_MS) {
      openLeftOut += 1;
      continue;
    }
    const dest = join(outDir, stem);
    await mkdir(dest, { recursive: true });
    await cp(join(dataDir, 'questions', name), join(dest, 'question.json'));
    const forecast = join(dataDir, 'forecasts', name);
    if (await exists(forecast)) await cp(forecast, join(dest, 'forecast.json'));
    for (const f of WORK_FILES) {
      const src = join(dataDir, 'runs', stem, f);
      if (await exists(src)) await cp(src, join(dest, f));
    }
    const lines = logs.flatMap((text) => logLinesFor(text, m[1]));
    await writeFile(join(dest, 'log.md'), lines.length ? `${lines.join('\n')}\n` : '');
    closed.push(stem);
  }
  await writeJson(join(outDir, 'index.json'), { made_at: new Date(nowMs).toISOString(), min_days: minDays, closed });
  return { closed, open_left_out: openLeftOut, out: outDir };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: { data: { type: 'string' }, out: { type: 'string' }, 'min-days': { type: 'string', default: '7' }, now: { type: 'string' } },
  async main(values) {
    required(values, 'data', 'out');
    const nowMs = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(nowMs)) throw new DataError('now_invalid');
    return closedQuestions({ dataDir: values.data, outDir: values.out, minDays: Number(values['min-days']), nowMs });
  },
});
