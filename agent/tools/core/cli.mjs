// Shared plumbing for the agent's command-line tools: arguments, JSON files,
// exit codes. Exit 0 = done, 1 = the data was invalid or the tool refused,
// 2 = the command itself was wrong (missing or unknown option).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export class DataError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DataError';
    this.code = code;
  }
}

export class UsageError extends Error {}

export async function readJson(path, label = path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new DataError('file_unreadable', `${label} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DataError('json_parse', label);
  }
}

// createOnly: refuse if the file exists (the 'wx' flag makes this atomic).
export async function writeJson(path, value, { createOnly = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: createOnly ? 'wx' : 'w' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new DataError('file_exists', `${path} already exists and is never rewritten`);
    throw error;
  }
}

function isMain(meta) {
  return Boolean(process.argv[1]) && meta.url === pathToFileURL(process.argv[1]).href;
}

// Runs a tool's main(values) with uniform --help, errors and exit codes.
export async function runCli({ meta, help, options, main }) {
  if (!isMain(meta)) return;
  let values;
  try {
    ({ values } = parseArgs({ options: { ...options, help: { type: 'boolean', default: false } }, strict: true }));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${help}\n`);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    process.stdout.write(`${help}\n`);
    return;
  }
  try {
    const result = await main(values);
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${help}\n`);
      process.exitCode = 2;
    } else if (error instanceof DataError) {
      process.stderr.write(`refused: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`error: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
  }
}

export function required(values, ...names) {
  const missing = names.filter((n) => values[n] === undefined || values[n] === '');
  if (missing.length) throw new UsageError(`missing option(s): ${missing.map((n) => `--${n}`).join(', ')}`);
}

export async function loadMethod() {
  return readJson(new URL('../../method.json', import.meta.url), 'agent/method.json');
}
