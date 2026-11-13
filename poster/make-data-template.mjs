// Writes ops/data-template.json: the git blob ids of the files in
// forecaster-data that steer the agent or hold workflows (bootstrap.mjs,
// CLAUDE.md, .github/workflows/*), plus bootstrap.mjs's SHA-256.
// The tick compares the live data repository with it on every run and opens
// the alert issue (data_repo_changed) when they differ, because the agent can
// push to that repository. agent/TASK_PROMPT.md quotes the SHA-256, so the
// agent checks bootstrap.mjs before it runs it.
//
//   node poster/make-data-template.mjs --template ../forecaster-data-template          write
//   node poster/make-data-template.mjs --template ../forecaster-data-template --check  exit 1 if out of date
//
// Run it (and update the hash in agent/TASK_PROMPT.md) after any change to
// those files, and commit the result.

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DATA_TEMPLATE_PATH = 'ops/data-template.json';
const ROOT_FILES = ['bootstrap.mjs', 'CLAUDE.md'];

export const gitBlobSha = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function buildDataTemplate(templateDir) {
  const files = {};
  for (const name of ROOT_FILES) files[name] = gitBlobSha(await readFile(join(templateDir, name)));
  const wfDir = join(templateDir, '.github', 'workflows');
  for (const name of (await readdir(wfDir)).sort()) files[`.github/workflows/${name}`] = gitBlobSha(await readFile(join(wfDir, name)));
  return {
    schema: 1,
    note: 'Made by poster/make-data-template.mjs from forecaster-data-template. Do not edit by hand.',
    files,
    bootstrap_sha256: sha256(await readFile(join(templateDir, 'bootstrap.mjs'))),
  };
}

export const render = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function main() {
  const { values } = parseArgs({ options: { template: { type: 'string' }, check: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help || !values.template) {
    console.log('Usage: node poster/make-data-template.mjs --template <forecaster-data-template folder> [--check]');
    return values.help ? 0 : 2;
  }
  const text = render(await buildDataTemplate(values.template));
  const target = join(ROOT, DATA_TEMPLATE_PATH);
  if (values.check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    const ok = current === text;
    console.log(JSON.stringify({ ok, fix: ok ? undefined : 'run node poster/make-data-template.mjs --template <folder> and commit the result' }));
    return ok ? 0 : 1;
  }
  await writeFile(target, text);
  console.log(JSON.stringify({ ok: true, written: DATA_TEMPLATE_PATH }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`make-data-template: ${error.message}`);
    process.exitCode = 1;
  });
}
