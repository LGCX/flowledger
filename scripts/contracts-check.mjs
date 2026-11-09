#!/usr/bin/env node
// Fails when the committed generated contract modules differ from freshly generated
// output, i.e. when `schemas/**` or `openapi/openapi.yaml` changed without regenerating.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { generate } from './contracts-generate.mjs';

export const DEFAULT_COMMITTED = 'packages/contracts/src/generated';

function parseArgs(argv) {
  const options = {
    committed: DEFAULT_COMMITTED,
    schemasDir: 'schemas',
    openapi: 'openapi/openapi.yaml',
  };
  const flags = {
    '--committed': 'committed',
    '--schemas-dir': 'schemasDir',
    '--openapi': 'openapi',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags[argv[index]];
    if (key === undefined) continue;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function listFiles(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Returns one message per difference, empty when the tree is up to date. */
export async function check(options) {
  const fresh = mkdtempSync(join(tmpdir(), 'flowledger-contracts-'));
  try {
    await generate({ out: fresh, schemasDir: options.schemasDir, openapi: options.openapi });

    const problems = [];
    const freshFiles = listFiles(fresh);
    const committedFiles = listFiles(options.committed);

    for (const name of freshFiles) {
      if (!committedFiles.includes(name)) {
        problems.push(`missing: ${join(options.committed, name)}`);
        continue;
      }
      const expected = readFileSync(join(fresh, name), 'utf8');
      const actual = readFileSync(join(options.committed, name), 'utf8');
      if (expected !== actual) {
        problems.push(`out of date: ${join(options.committed, name)}`);
      }
    }
    for (const name of committedFiles) {
      if (!freshFiles.includes(name)) {
        problems.push(`unexpected: ${join(options.committed, name)}`);
      }
    }

    return problems;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const problems = await check(options);
  if (problems.length > 0) {
    process.stderr.write(`contract drift detected (${problems.length}):\n`);
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    process.stderr.write('run `pnpm contracts:generate` and commit the result\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `contracts up to date (${relative(process.cwd(), options.committed) || '.'})\n`,
    );
  }
}
