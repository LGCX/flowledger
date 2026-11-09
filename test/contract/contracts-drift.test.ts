import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiComponentsSchema, registeredTypes } from '../../packages/contracts/src/index.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const GENERATED = join(repoRoot, 'packages/contracts/src/generated');
const GENERATE = join(repoRoot, 'scripts/contracts-generate.mjs');
const CHECK = join(repoRoot, 'scripts/contracts-check.mjs');

const TEMP_TIMEOUT = 120_000;

function run(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

function readAll(dir: string, names: string[]): Map<string, string> {
  return new Map(names.map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

const GENERATED_FILES = ['messages.ts', 'openapi-components.ts', 'openapi.ts', 'schemas.ts'];

describe('contract code generation', () => {
  it(
    'generator is deterministic',
    () => {
      const a = mkdtempSync(join(tmpdir(), 'flowledger-gen-a-'));
      const b = mkdtempSync(join(tmpdir(), 'flowledger-gen-b-'));
      try {
        expect(run(GENERATE, ['--out', a]).status).toBe(0);
        expect(run(GENERATE, ['--out', b]).status).toBe(0);

        const first = readAll(a, GENERATED_FILES);
        const second = readAll(b, GENERATED_FILES);
        for (const name of GENERATED_FILES) {
          expect(second.get(name), `${name} must be byte-identical`).toBe(first.get(name));
        }
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    },
    TEMP_TIMEOUT,
  );

  it(
    'committed output matches fresh output',
    () => {
      const result = run(CHECK, []);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
    TEMP_TIMEOUT,
  );

  it(
    'check detects an edited generated file',
    () => {
      const copy = mkdtempSync(join(tmpdir(), 'flowledger-committed-'));
      try {
        cpSync(GENERATED, copy, { recursive: true });
        appendFileSync(join(copy, 'schemas.ts'), '\n// hand edit\n');

        const result = run(CHECK, ['--committed', copy]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('out of date');
        expect(result.stderr).toContain('schemas.ts');
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
    TEMP_TIMEOUT,
  );

  it(
    'check detects a missing file',
    () => {
      const copy = mkdtempSync(join(tmpdir(), 'flowledger-committed-'));
      try {
        cpSync(GENERATED, copy, { recursive: true });
        rmSync(join(copy, 'openapi.ts'));

        const result = run(CHECK, ['--committed', copy]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('missing');
        expect(result.stderr).toContain('openapi.ts');
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    },
    TEMP_TIMEOUT,
  );

  it(
    'editing a schema copy produces a diff',
    () => {
      const schemas = mkdtempSync(join(tmpdir(), 'flowledger-schemas-'));
      const out = mkdtempSync(join(tmpdir(), 'flowledger-out-'));
      try {
        cpSync(join(repoRoot, 'schemas'), schemas, { recursive: true });

        const target = join(schemas, 'events/payment-created.v1.schema.json');
        const edited = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
        edited['description'] = 'Edited by the drift test.';
        writeFileSync(target, `${JSON.stringify(edited, null, 2)}\n`);

        // Generating from the edited copy must not reproduce the committed bytes.
        expect(run(GENERATE, ['--out', out, '--schemas-dir', schemas]).status).toBe(0);
        const drifted = readFileSync(join(out, 'schemas.ts'), 'utf8');
        const committed = readFileSync(join(GENERATED, 'schemas.ts'), 'utf8');
        expect(drifted).not.toBe(committed);
        expect(drifted).toContain('Edited by the drift test.');
      } finally {
        rmSync(schemas, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
      }
    },
    TEMP_TIMEOUT,
  );

  it('registeredTypes equals registry order', () => {
    const registry = JSON.parse(
      readFileSync(join(repoRoot, 'schemas/registry.v1.json'), 'utf8'),
    ) as { messages: Array<{ type: string }> };

    expect(registeredTypes).toHaveLength(26);
    expect([...registeredTypes]).toEqual(registry.messages.map((message) => message.type));
  });

  it('openApiComponentsSchema contains no #/components/schemas/ refs', () => {
    expect(JSON.stringify(openApiComponentsSchema)).not.toContain('#/components/schemas/');
    expect(Object.keys(openApiComponentsSchema.$defs).length).toBeGreaterThan(0);
  });
});
