#!/usr/bin/env node
// Assembles forecasts/<id>.json from the saved question, the aggregate output
// and the comment, checks it with the same validator the poster uses, and
// writes it once. An existing forecast file is never rewritten.

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateForecastFile } from '../../lib/schema.mjs';
import { DataError, loadMethod, readJson, required, runCli, writeJson } from './core/cli.mjs';
import { fileStem, minutesLeft, toValidatorQuestion } from './core/question.mjs';

const HELP = `write-forecast: build, check and write forecasts/<id>.json (once, never again).
For a replacement request (revision 2 in the question file) it writes
forecasts/<id>.r2.json instead; the first file is never touched.

Usage:
  node tools/write-forecast.mjs --question <questions/ID.json> --aggregate <aggregate.json> \\
       --comment <comment.md> --data <data repo folder> [--now <ISO time>]

Refuses (exit 1) when the forecast file already exists, when the question has
closed, or when any check fails; the problem codes are printed.
Exit 0 = written, 1 = refused, 2 = wrong command.`;

// The poster refuses files above this size (poster/config.json posting.max_file_bytes).
const MAX_FILE_BYTES = 200000;
const exists = (path) => access(path).then(() => true, () => false);

export function assembleForecast({ item, aggregate, comment, method, nowMs }) {
  if (aggregate?.question_id !== item.question_id) throw new DataError('aggregate_for_other_question');
  if (aggregate.method_version !== method.version) throw new DataError('method_version_mismatch', `aggregate ${aggregate.method_version}, method ${method.version}`);
  const text = String(comment ?? '').trim();
  // The comment must state what is really posted: its first line is the
  // aggregate's Forecast line, and the Markets and Passes lines appear word
  // for word. A comment written for an earlier aggregate is refused.
  const lines = aggregate.comment_lines ?? {};
  if (typeof lines.forecast !== 'string' || text.split('\n')[0].trim() !== lines.forecast.trim()) {
    throw new DataError('comment_format', 'the first line must be comment_lines.forecast from this aggregate.json, word for word');
  }
  const missing = ['markets', 'passes'].filter((k) => typeof lines[k] !== 'string' || !text.includes(lines[k].trim()));
  if (missing.length) throw new DataError('comment_format', `the comment must contain comment_lines.${missing.join(' and comment_lines.')} from this aggregate.json, word for word`);
  if (!text.includes('fully automated')) throw new DataError('comment_format', 'the Forecast line says "fully automated"');
  return {
    schema: 1,
    question_id: item.question_id,
    post_id: item.post_id,
    tournament: item.tournament,
    type: item.type,
    title: String(item.title ?? '').slice(0, 1000),
    created_at: new Date(nowMs).toISOString(),
    method_version: method.version,
    forecast: aggregate.forecast,
    comment: text,
    passes: aggregate.passes,
    signals: aggregate.signals,
    checks: aggregate.checks,
  };
}

export async function writeForecast({ item, aggregate, comment, dataDir, method, nowMs = Date.now() }) {
  if (!Number.isInteger(item?.question_id)) throw new DataError('question_id_missing');
  const path = join(dataDir, 'forecasts', `${fileStem(item)}.json`);
  if (await exists(path)) throw new DataError('file_exists', `${path} already exists and is never rewritten`);
  if (minutesLeft(item, nowMs) < 1) throw new DataError('question_closed', 'the question has closed or closes within a minute');

  const file = assembleForecast({ item, aggregate, comment, method, nowMs });
  const problems = validateForecastFile(file, toValidatorQuestion(item), { nowMs });
  if (problems.length) throw new DataError('forecast_invalid', problems.map((p) => `${p.code}${p.detail ? ` [${p.detail}]` : ''}`).join('; '));
  if (JSON.stringify(file, null, 2).length > MAX_FILE_BYTES) throw new DataError('file_too_large');
  await writeJson(path, file, { createOnly: true });
  return { written: path, question_id: item.question_id, type: item.type };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: {
    question: { type: 'string' }, aggregate: { type: 'string' }, comment: { type: 'string' },
    data: { type: 'string' }, now: { type: 'string' },
  },
  async main(values) {
    required(values, 'question', 'aggregate', 'comment', 'data');
    const nowMs = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(nowMs)) throw new DataError('now_invalid');
    const comment = await readFile(values.comment, 'utf8').catch(() => {
      throw new DataError('file_unreadable', values.comment);
    });
    return writeForecast({
      item: await readJson(values.question, 'question file'),
      aggregate: await readJson(values.aggregate, 'aggregate file'),
      comment,
      dataDir: values.data,
      method: await loadMethod(),
      nowMs,
    });
  },
});
