// The kit manifest must list every runtime file with its current hash.
// If this test fails, run: node agent/tools/make-manifest.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MANIFEST_PATH, ROOT, buildManifest, manifestText, runtimeFiles } from '../tools/make-manifest.mjs';

test('agent/MANIFEST.json is up to date (run make-manifest.mjs if not)', async () => {
  const onDisk = await readFile(`${ROOT}${MANIFEST_PATH}`, 'utf8');
  assert.equal(onDisk, manifestText(await buildManifest()), 'the manifest is stale: run node agent/tools/make-manifest.mjs');
});

test('the manifest holds the runbook, the method, every prompt, every tool and lib, and nothing else', async () => {
  const files = await runtimeFiles();
  for (const must of ['agent/RUNBOOK.md', 'agent/method.md', 'agent/method.json', 'agent/prompts/criteria-card.md',
    'agent/tools/intake.mjs', 'agent/tools/core/cli.mjs', 'agent/tools/write-forecast.mjs', 'lib/cdf.mjs', 'lib/schema.mjs']) {
    assert.ok(files.includes(must), `${must} is in the manifest`);
  }
  assert.ok(files.every((f) => f.startsWith('agent/') || f.startsWith('lib/')));
  assert.ok(!files.some((f) => f.includes('/test/') || f.endsWith('TASK_PROMPT.md') || f === MANIFEST_PATH));
  assert.ok(!files.some((f) => f.startsWith('poster/')), 'the posting pipeline is not part of the agent kit');
});

test('every relative import inside the kit points to a file that is in the kit', async () => {
  const files = new Set(await runtimeFiles());
  for (const f of files) {
    if (!f.endsWith('.mjs')) continue;
    const text = await readFile(`${ROOT}${f}`, 'utf8');
    for (const [, spec] of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const target = new URL(spec, `file:///${f}`).pathname.slice(1);
      assert.ok(files.has(target), `${f} imports ${spec}, which is missing from the kit`);
    }
  }
});
