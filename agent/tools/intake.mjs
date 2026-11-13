#!/usr/bin/env node
// Step 1 of a run: read the wake-up payload, save each question once to
// questions/<id>.json, keep a copy of the payload, and print the work plan.
// The payload is untrusted data: it is parsed as JSON and never executed.

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataError, UsageError, loadMethod, required, runCli, writeJson } from './core/cli.mjs';
import { fileStem, itemProblems, minutesLeft, revisionOf } from './core/question.mjs';

const HELP = `intake: save the payload's questions and print the plan for this run.

Usage:
  node tools/intake.mjs --payload <file> --data <data repo folder> [--subagents yes|no] [--now <ISO time>]

--payload    a file holding the text found between the routine-fire-payload tags
             (the tags themselves may be included)
--data       the checked-out private data repository
--subagents  yes when this session has a tool that starts sub-agents (RUNBOOK
             step 0); default no. It decides the plan's mode:
             parallel   = 3 or more questions to forecast and sub-agents: one
                          research sub-agent per question at once, then the main
                          session does each question's passes and finish in
                          deadline order;
             sequential = otherwise: one question after another, in deadline order.
--now        only for tests: pretend the time is this

Writes questions/<id>.json (only if it does not exist yet; questions/<id>.r2.json
for a replacement request), runs/payloads/<sent_at>-p<part>.json and the plan
runs/plans/<sent_at>-p<part>.json (rewritten on every run of intake).
Prints the plan as JSON; each entry names its question_file and forecast_file,
its budget_minutes, fast_path and, when fast_path is true, fast_path_reason.
Exit 0 = done, 1 = the payload is not valid, 2 = wrong command.`;

// Up to the last closing tag. The tick escapes < and > inside the JSON, so a
// real payload never contains the tag; this only guards against cut-off copies.
const TAG = /<routine-fire-payload[^>]*>([\s\S]*)<\/routine-fire-payload>/;

export function parsePayload(text) {
  const inner = (text.match(TAG)?.[1] ?? text).trim();
  let envelope;
  try {
    envelope = JSON.parse(inner);
  } catch {
    throw new DataError('payload_not_json');
  }
  if (envelope?.kind !== 'forecast_request' || envelope.schema !== 1) throw new DataError('payload_kind', 'expected kind forecast_request, schema 1');
  if (!Array.isArray(envelope.questions)) throw new DataError('payload_questions_missing');
  if (!Number.isFinite(Date.parse(envelope.sent_at))) throw new DataError('payload_sent_at_invalid');
  const practice = envelope.questions.map(isPractice);
  if (practice.includes(true) && practice.includes(false)) throw new DataError('payload_practice_mixed', 'practice questions are never mixed with tournament questions');
  return envelope;
}

// Practice rounds (RUNBOOK "Practice mode") mark every question with the
// tournament "practice".
export const PRACTICE_TOURNAMENT = 'practice';
const isPractice = (item) => item?.tournament === PRACTICE_TOURNAMENT;

const exists = (path) => access(path).then(() => true, () => false);

export const MODES = new Set(['parallel', 'sequential']);

// Which way the run works (RUNBOOK "Who does what"): parallel only with
// sub-agents and at least parallel_min_questions questions to forecast.
export function chooseMode(forecastCount, subagents, method) {
  if (subagents && forecastCount >= method.parallel_min_questions) {
    return { mode: 'parallel', mode_reason: `${forecastCount} questions to forecast and a sub-agent tool` };
  }
  if (!subagents) return { mode: 'sequential', mode_reason: 'no sub-agent tool' };
  return { mode: 'sequential', mode_reason: `only ${forecastCount} question(s) to forecast (parallel needs ${method.parallel_min_questions})` };
}

// Soonest close first. Each question gets the time it really has:
// - sequential: questions run one after another, so a question starts after
//   the budgets of all earlier ones;
// - parallel: research runs for all questions at once, and only the main
//   session's own work (passes, aggregate, comment, write, push:
//   main_session_minutes_per_question) queues up behind the earlier questions.
export function planQuestions(entries, method, nowMs, { mode = 'sequential' } = {}) {
  if (!MODES.has(mode)) throw new Error(`unknown plan mode ${mode}`);
  const sorted = [...entries].sort((a, b) => minutesLeft(a.item, nowMs) - minutesLeft(b.item, nowMs));
  let clock = 0;
  return sorted.map(({ item, problems, hasForecast }) => {
    const left = minutesLeft(item, nowMs);
    const id = item?.question_id ?? null;
    const base = { question_id: id, type: item?.type ?? null, minutes_left: Math.round(left) };
    if (Number.isInteger(id) && id > 0) {
      const stem = fileStem(item);
      Object.assign(base, { revision: revisionOf(item), question_file: `questions/${stem}.json`, forecast_file: `forecasts/${stem}.json` });
      if (revisionOf(item) === 2) base.previous_file_problems = Array.isArray(item.previous_file_problems) ? item.previous_file_problems : [];
    }
    if (problems.length) return { ...base, action: 'skip', reason: 'question_data_invalid', problems };
    if (hasForecast) return { ...base, action: 'skip', reason: 'forecast_file_exists' };
    if (left < method.skip_if_minutes_left_under) return { ...base, action: 'skip', reason: 'closes_too_soon' };
    const waits = clock;
    const available = left - waits - method.finish_minutes_before_close;
    const budget = Math.max(5, Math.min(method.full_path_minutes, Math.floor(available)));
    clock += mode === 'parallel' ? method.main_session_minutes_per_question : budget;
    const fast = available < method.fast_path_if_minutes_left_under;
    const entry = {
      ...base,
      action: 'forecast',
      budget_minutes: budget,
      waits_minutes: waits,
      fast_path: fast,
      text_was_cut: item.truncated === true,
    };
    if (fast) {
      entry.fast_path_reason = `${Math.floor(available)} minutes to work after ${waits} minutes of earlier questions (${mode}) and the ${method.finish_minutes_before_close}-minute finish margin; the full path needs ${method.fast_path_if_minutes_left_under}`;
    }
    return entry;
  });
}

// The bootstrap writes the commit it fetched into kit/KIT_REF. When the
// payload names a kit commit (kit_ref), this kit must be that commit, so a
// question is never worked on with another method version.
const KIT_REF_PATH = fileURLToPath(new URL('../../KIT_REF', import.meta.url));

async function checkKitRef(envelope, kitRefPath) {
  const wanted = envelope.kit_ref ?? null;
  if (wanted !== null && (typeof wanted !== 'string' || !/^[0-9a-f]{40}$/.test(wanted))) throw new DataError('payload_kit_ref_invalid');
  let have;
  try {
    have = (await readFile(kitRefPath, 'utf8')).trim();
  } catch {
    return { kit_ref: wanted, kit_checked: false };
  }
  if (wanted !== null && have !== wanted) {
    throw new DataError('kit_ref_mismatch', `the payload asks for kit ${wanted.slice(0, 12)}, kit/ holds ${have.slice(0, 12)}: run the bootstrap with --payload again`);
  }
  return { kit_ref: wanted, kit_checked: true };
}

export async function intake({ payloadText, dataDir, nowMs = Date.now(), kitRefPath = KIT_REF_PATH, subagents = false }) {
  const method = await loadMethod();
  const envelope = parsePayload(payloadText);
  const kit = await checkKitRef(envelope, kitRefPath);
  const stamp = `${envelope.sent_at.replace(/[^0-9A-Za-z]/g, '-')}-p${Number(envelope.part) || 1}`;
  const payloadCopy = join(dataDir, 'runs', 'payloads', `${stamp}.json`);
  if (!(await exists(payloadCopy))) await writeJson(payloadCopy, envelope, { createOnly: true });

  const entries = [];
  const saved = [];
  for (const item of envelope.questions) {
    const problems = itemProblems(item);
    const id = item?.question_id;
    if (!Number.isInteger(id) || id <= 0) {
      entries.push({ item: item ?? {}, problems: problems.length ? problems : ['question_id_missing'], hasForecast: false });
      continue;
    }
    const questionFile = join(dataDir, 'questions', `${fileStem(item)}.json`);
    if (await exists(questionFile)) saved.push({ question_id: id, file: 'kept_existing' });
    else {
      await writeJson(questionFile, item, { createOnly: true });
      saved.push({ question_id: id, file: 'saved' });
    }
    entries.push({ item, problems, hasForecast: await exists(join(dataDir, 'forecasts', `${fileStem(item)}.json`)) });
  }
  const forecastable = planQuestions(entries, method, nowMs).filter((p) => p.action === 'forecast').length;
  const { mode, mode_reason: modeReason } = chooseMode(forecastable, subagents === true, method);
  const planFile = join(dataDir, 'runs', 'plans', `${stamp}.json`);
  const result = {
    method_version: method.version,
    now: new Date(nowMs).toISOString(),
    sent_at: envelope.sent_at,
    ...kit,
    part: envelope.part ?? 1,
    parts: envelope.parts ?? 1,
    practice: envelope.questions.length > 0 && envelope.questions.every(isPractice),
    payload_copy: payloadCopy,
    plan_file: planFile,
    subagents: subagents === true,
    mode,
    mode_reason: modeReason,
    saved,
    plan: planQuestions(entries, method, nowMs, { mode }),
  };
  // Saved so later steps (and a session that takes over) read the same plan.
  await writeJson(planFile, result);
  return result;
}

await runCli({
  meta: import.meta,
  help: HELP,
  options: { payload: { type: 'string' }, data: { type: 'string' }, now: { type: 'string' }, subagents: { type: 'string', default: 'no' } },
  async main(values) {
    required(values, 'payload', 'data');
    if (!['yes', 'no'].includes(values.subagents)) throw new UsageError('--subagents must be yes or no');
    const nowMs = values.now ? Date.parse(values.now) : Date.now();
    if (!Number.isFinite(nowMs)) throw new DataError('now_invalid');
    const payloadText = await readFile(values.payload, 'utf8').catch(() => {
      throw new DataError('file_unreadable', values.payload);
    });
    return intake({ payloadText, dataDir: values.data, nowMs, subagents: values.subagents === 'yes' });
  },
});
