// Writes agent/MANIFEST.json: every file the agent needs at run time, with its
// size and SHA-256. The data repository's bootstrap.mjs downloads exactly
// these files from raw.githubusercontent.com and checks every hash, because
// the cloud task cannot attach or call the API of this public repository.
//
//   node agent/tools/make-manifest.mjs           write the manifest
//   node agent/tools/make-manifest.mjs --check   exit 1 if it is out of date
//
// Run it after changing any file under agent/ or lib/, and commit the result.

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MANIFEST_PATH = 'agent/MANIFEST.json';

// What the agent reads or runs. Tests, the task prompts (pasted by the owner)
// and the bot description are not needed at run time.
const SINGLE_FILES = ['agent/RUNBOOK.md', 'agent/method.md', 'agent/method.json'];
const FOLDERS = [
  { dir: 'agent/prompts', recursive: false },
  { dir: 'agent/tools', recursive: true },
  { dir: 'lib', recursive: true },
];
const SAFE_PATH = /^(agent|lib)\/[A-Za-z0-9._/-]+$/;

async function listFolder(root, dir, recursive) {
  const out = [];
  const entries = await readdir(`${root}${dir}`, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (recursive) out.push(...(await listFolder(root, path, true)));
    } else if (e.isFile()) out.push(path);
  }
  return out;
}

export async function runtimeFiles(root = ROOT) {
  const files = [...SINGLE_FILES];
  for (const f of FOLDERS) files.push(...(await listFolder(root, f.dir, f.recursive)));
  const sorted = [...new Set(files)].sort();
  for (const p of sorted) {
    if (!SAFE_PATH.test(p) || p.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error(`file name not allowed in the manifest: ${p}`);
    }
  }
  return sorted;
}

export async function buildManifest(root = ROOT) {
  const files = [];
  for (const path of await runtimeFiles(root)) {
    const bytes = await readFile(`${root}${path}`);
    files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { schema: 1, repository: 'forecaster', note: 'Made by agent/tools/make-manifest.mjs. Do not edit by hand.', files };
}

export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log('Usage: node agent/tools/make-manifest.mjs [--check]\nWrites agent/MANIFEST.json, or with --check exits 1 if it is out of date.');
    return 0;
  }
  const text = manifestText(await buildManifest());
  const target = `${ROOT}${MANIFEST_PATH}`;
  if (values.check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== text) {
      console.log(JSON.stringify({ ok: false, problem: 'manifest_stale', fix: 'node agent/tools/make-manifest.mjs' }));
      return 1;
    }
    console.log(JSON.stringify({ ok: true, files: JSON.parse(text).files.length }));
    return 0;
  }
  await writeFile(target, text);
  console.log(JSON.stringify({ ok: true, wrote: relative(ROOT, target).split(sep).join('/'), files: JSON.parse(text).files.length }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  });
}
