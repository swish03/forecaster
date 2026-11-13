import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { closedQuestions } from '../tools/closed-questions.mjs';
import { NOW, iso, minutes, runTool, tempDataRepo, writeJsonFile } from './helpers.mjs';

const DAY = minutes(24 * 60);

async function seed(dir) {
  // 11 closed 10 days ago; 12 closed 2 days ago (inside the margin); 13 is open.
  const questions = {
    11: { question_id: 11, deadline: iso(NOW - 10 * DAY), scheduled_close_time: iso(NOW - 10 * DAY) },
    12: { question_id: 12, deadline: iso(NOW - 2 * DAY), scheduled_close_time: iso(NOW - 2 * DAY) },
    13: { question_id: 13, deadline: iso(NOW + DAY), scheduled_close_time: iso(NOW + DAY) },
    // Saved with an early deadline, but its scheduled close is later: still treated as possibly open.
    14: { question_id: 14, deadline: iso(NOW - 10 * DAY), scheduled_close_time: iso(NOW - DAY) },
  };
  for (const [id, q] of Object.entries(questions)) {
    await writeJsonFile(join(dir, 'questions', `${id}.json`), q);
    await writeJsonFile(join(dir, 'forecasts', `${id}.json`), { question_id: Number(id), forecast: { probability_yes: 0.3 } });
    await mkdir(join(dir, 'runs', id), { recursive: true });
    await writeFile(join(dir, 'runs', id, 'card.md'), `card ${id}`);
    await writeFile(join(dir, 'runs', id, 'dossier.md'), `dossier ${id}`);
  }
  await writeFile(join(dir, 'logs', '2026-11-06.md'), [
    '## Run 2026-11-06T08:00:00Z',
    '- 11: forecast (binary, 30%, w=0, fast path no, flags none)',
    '- 13: forecast (binary, 30%, w=0, fast path no, flags none)',
    '- 111: forecast (binary, 70%, w=0, fast path no, flags none)',
    '- finished 2026-11-06T08:30:00Z: 3 questions',
  ].join('\n'));
}

test('closed-questions copies only questions closed more than 7 days ago, with their own log lines', async (t) => {
  const dir = await tempDataRepo(t);
  await seed(dir);
  const out = join(dir, 'review-input');
  const result = await closedQuestions({ dataDir: dir, outDir: out, nowMs: NOW });
  assert.deepEqual(result.closed, ['11']);
  assert.equal(result.open_left_out, 3);
  assert.deepEqual((await readdir(out)).sort(), ['11', 'index.json']);
  assert.deepEqual((await readdir(join(out, '11'))).sort(), ['card.md', 'dossier.md', 'forecast.json', 'log.md', 'question.json']);
  assert.equal(await readFile(join(out, '11', 'log.md'), 'utf8'), '- 11: forecast (binary, 30%, w=0, fast path no, flags none)\n');
  assert.ok(!existsSync(join(out, '13')), 'nothing of an open question is copied');
});

test('closed-questions CLI: exit 0 and a JSON summary', async (t) => {
  const dir = await tempDataRepo(t);
  await seed(dir);
  const r = await runTool('closed-questions.mjs', ['--data', dir, '--out', join(dir, 'review-input'), '--now', iso(NOW)]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).closed, ['11']);
});
