#!/usr/bin/env node
// Last step of a run: every question in the payload must now have a valid
// forecast file, or a skip line with an allowed reason in logs/<date>.md.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateForecastFile } from '../../lib/schema.mjs';
import { DataError, UsageError, readJson, required, runCli } from './core/cli.mjs';
import { fileStem, toValidatorQuestion } from './core/question.mjs';
import { parsePayload } from './intake.mjs';

const HELP = `check-run: confirm every payload question has a valid forecast file or a logged reason.

Usage:
  node tools/check-run.mjs --payload <runs/payloads/....json> --data <data repo folder>
       [--question <question_id>] [--now <ISO time>]

--question  check only this question of the payload (right after its forecast
            file is written); without it, every question of the payload

A skip is recognised only as a log line of exactly this form, in any logs/*.md file:
  - <question_id>: skipped (<reason>)
Allowed reasons: closes_too_soon, closed_before_finish, question_data_invalid, existing_file_invalid

Prints a report. Exit 0 = every question is covered, 1 = at least one is not, 2 = wrong command.`;

export const SKIP_REASONS = new Set(['closes_too_soon', 'closed_before_finish', 'question_data_invalid', 'existing_file_invalid']);
const SKIP_LINE = /^- (\d{1,12}): skipped \(([a-z_]+)\)/;

export async function loggedSkips(dataDir) {
  const skips = new Map();
  let names = [];
  try {
    names = (await readdir(join(dataDir, 'logs'))).filter((n) => n.endsWith('.md'));
  } catch {
    return skips;
  }
  for (const name of names) {
    for (const line of (await readFile(join(dataDir, 'logs', name), 'utf8')).split('\n')) {
      const m = line.trim().match(SKIP_LINE);
      if (m && SKIP_REASONS.has(m[2])) skips.set(Number(m[1]), m[2]);
    }
  }
  return skips;
}

async function readOptionalJson(path) {
  try {
    return { value: await readJson(path) };
  } catch (error) {
    if (error instanceof DataError && error.code === 'file_unreadable') return { missing: true };
    return { broken: error.code ?? 'unreadable' };
  }
}

export async function checkRun({ envelope, dataDir, nowMs = Date.now(), questionId = null }) {
  const skips = await loggedSkips(dataDir);
  const rows = [];
  let items = envelope.questions;
  if (questionId !== null) {
    items = items.filter((item) => item?.question_id === questionId);
    if (!items.length) throw new DataError('question_not_in_payload', String(questionId));
  }
  for (const item of items) {
    const id = item?.question_id;
    if (!Number.isInteger(id) || id <= 0) {
      rows.push({ question_id: null, ok: true, status: 'question_data_invalid' });
      continue;
    }
    const saved = await readOptionalJson(join(dataDir, 'questions', `${fileStem(item)}.json`));
    const question = saved.value ?? item;
    const file = await readOptionalJson(join(dataDir, 'forecasts', `${fileStem(item)}.json`));
    if (file.value !== undefined || file.broken) {
      const problems = file.broken ? [file.broken] : validateForecastFile(file.value, toValidatorQuestion(question), { nowMs }).map((p) => p.code);
      if (!problems.length) {
        rows.push({ question_id: id, ok: true, status: 'forecast_valid' });
        continue;
      }
      const reason = skips.get(id);
      rows.push({ question_id: id, ok: reason === 'existing_file_invalid', status: 'forecast_invalid', problems, logged_reason: reason ?? null });
      continue;
    }
    const reason = skips.get(id);
    rows.push(reason ? { question_id: id, ok: true, status: 'skipped', logged_reason: reason } : { question_id: id, ok: false, status: 'no_forecast_and_no_logged_reason' });
  }
  return { ok: rows.every((r) => r.ok), scope: questionId === null ? 'payload' : 'question', questions: rows };
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: { payload: { type: 'string' }, data: { type: 'string' }, now: { type: 'string' }, question: { type: 'string' } },
  async main(values) {
    required(values, 'payload', 'data');
    const nowMs = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(nowMs)) throw new DataError('now_invalid');
    const text = await readFile(values.payload, 'utf8').catch(() => {
      throw new DataError('file_unreadable', values.payload);
    });
    let questionId = null;
    if (values.question !== undefined) {
      questionId = Number(values.question);
      if (!Number.isInteger(questionId) || questionId <= 0) throw new UsageError('--question must be a question id (a whole number)');
    }
    const report = await checkRun({ envelope: parsePayload(text), dataDir: values.data, nowMs, questionId });
    if (!report.ok) process.exitCode = 1;
    return report;
  },
});
