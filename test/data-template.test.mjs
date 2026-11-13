// ops/data-template.json: what the tick expects in forecaster-data
// (data_repo_changed), and the bootstrap hash the task prompt quotes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildDataTemplate, render } from '../poster/make-data-template.mjs';
import { compareGuardedFiles } from '../poster/ops.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TEMPLATE = fileURLToPath(new URL('../../forecaster-data-template/', import.meta.url));
const expected = JSON.parse(read('ops/data-template.json'));

test('ops/data-template.json guards bootstrap.mjs, CLAUDE.md and the notify workflow', () => {
  assert.equal(expected.schema, 1);
  assert.deepEqual(Object.keys(expected.files).sort(), ['.github/workflows/notify.yml', 'CLAUDE.md', 'bootstrap.mjs']);
  assert.ok(Object.values(expected.files).every((sha) => /^[0-9a-f]{40}$/.test(sha)));
  assert.match(expected.bootstrap_sha256, /^[0-9a-f]{64}$/);
});

test('the task prompt quotes the same bootstrap SHA-256, so the agent checks the file before it runs it', () => {
  const prompt = read('agent/TASK_PROMPT.md');
  assert.ok(prompt.includes(expected.bootstrap_sha256));
  assert.ok(!prompt.includes('BOOTSTRAP_SHA256'));
  assert.match(prompt, /shasum -a 256 bootstrap\.mjs/);
});

test('ops/data-template.json matches forecaster-data-template (run make-data-template.mjs if not)', { skip: !existsSync(TEMPLATE) && 'no forecaster-data-template next to this repository' }, async () => {
  assert.equal(render(await buildDataTemplate(TEMPLATE)), read('ops/data-template.json'));
});

test('compareGuardedFiles lists changed, missing and extra paths', () => {
  const want = { a: '1', b: '2' };
  assert.deepEqual(compareGuardedFiles(want, { a: '1', b: '2' }), []);
  assert.deepEqual(compareGuardedFiles(want, { a: '1', b: '3', c: '4' }), ['b', 'c']);
  assert.deepEqual(compareGuardedFiles(want, { a: '1' }), ['b']);
});
