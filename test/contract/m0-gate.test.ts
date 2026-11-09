/**
 * The M0 exit gate, proved end-to-end rather than per task (docs/10 §M0).
 *
 * Each case here re-establishes a guarantee from the lane that owns it, at the boundary where
 * the guarantee actually matters: a malformed schema cannot reach a running consumer, an
 * invalid example cannot survive the contract job, a project cannot silently run zero tests, and
 * no application can depend on an environment variable that is not documented.
 *
 * `passWithNoTests` is enabled in the shared Vitest config so a lane can exist before it has
 * tests (R-07). That makes "the project ran" and "the project ran nothing" indistinguishable
 * from an exit code, so the first case asks Vitest what it would run instead of trusting it.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkRegistry,
  createAjv,
  generatedSchemasByPath,
  openApiComponentsSchema,
  openApiExtensionKeywords,
  validateMessage,
} from '@flowledger/contracts';
import { registry } from '@flowledger/contracts';
import { validMessages } from './fixtures/messages.js';

type JsonObject = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fl-m0-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe('M0 gate', () => {
  // Listing spawns a `vitest` process and loads the project config, so the default 5 s timeout makes
  // this a machine-speed measurement rather than an assertion about the config. It passed locally at
  // ~3.6 s and timed out on the CI runner.
  it.each(['unit', 'contracts', 'integration'])(
    'the %s project runs at least one test file',
    { timeout: 60_000 },
    (project) => {
      // `vitest list --json` reports what would run; an exit code cannot, because
      // passWithNoTests makes an empty run succeed.
      const output = execFileSync('pnpm', ['vitest', 'list', '--project', project, '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const listed = JSON.parse(output) as { file?: string }[];
      const files = new Set(listed.map((entry) => entry.file).filter(Boolean));

      expect(files.size, `${project} project would run no test files`).toBeGreaterThan(0);
    },
  );

  it('the contract job fails on a malformed schema', () => {
    // A copy of the real schema tree with one unknown keyword added. `strictSchema` turns that
    // into a compile error, which is how the contract job fails on a hand-edited schema.
    const copy = join(temporaryDirectory(), 'schemas');
    cpSync(join(repoRoot, 'schemas'), copy, { recursive: true });

    const moneyPath = join(copy, 'common', 'money.v1.schema.json');
    const money = JSON.parse(readFileSync(moneyPath, 'utf8')) as JsonObject;
    money.typo = true;
    writeFileSync(moneyPath, JSON.stringify(money, null, 2));

    const malformed = JSON.parse(readFileSync(moneyPath, 'utf8')) as JsonObject;
    const ajv = createAjv();

    expect(() => ajv.compile(malformed)).toThrow(/typo/);
  });

  it('the contract job fails on an unknown message field', () => {
    const result = validateMessage({ ...validMessages['payment.created.v1'], extra: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('SCHEMA');
    expect(result.issues.map((issue) => issue.rule)).toContain('additionalProperties');
  });

  it('the contract job fails on an invalid OpenAPI example', () => {
    // A compact copy of the P00-T09 walker: the example nodes in the components schema are
    // validated against the component they sit on.
    const ajv = createAjv();
    for (const keyword of openApiExtensionKeywords) ajv.addKeyword(keyword);
    ajv.addSchema(openApiComponentsSchema);

    const defs = structuredClone(openApiComponentsSchema.$defs) as Record<string, JsonObject>;
    const mutated = structuredClone(defs);
    (mutated.PaymentId as JsonObject).examples = ['pay_BAD'];

    const failures: string[] = [];
    for (const [name, schema] of Object.entries(mutated)) {
      const examples = (schema as JsonObject).examples;
      if (!Array.isArray(examples)) continue;
      const rest: JsonObject = { ...(schema as JsonObject) };
      delete rest.examples;
      const validate = ajv.compile({
        ...rest,
        $id: `urn:flowledger:m0-example:${name}`,
        // The shared definitions only: a component's own keywords are the schema being
        // compiled, not entries of $defs.
        $defs: defs,
      });
      examples.forEach((example, index) => {
        if (!validate(example)) failures.push(`${name}/examples/${index}`);
      });
    }

    expect(failures).toEqual(['PaymentId/examples/0']);
  });

  it('every registry type maps to an existing schema and catalog parity holds', () => {
    expect(checkRegistry(registry, generatedSchemasByPath())).toEqual([]);
  });

  it('no application needs an undocumented secret', () => {
    const envExample = readFileSync(join(repoRoot, 'infra', 'docker', '.env.example'), 'utf8');
    const documented = new Set(
      envExample
        .split('\n')
        .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined),
    );

    const sources = [
      ...walkSource(join(repoRoot, 'apps')),
      ...walkSource(join(repoRoot, 'packages', 'config', 'src')),
    ];
    expect(sources.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const name of referencedEnvNames(text)) {
        if (!documented.has(name)) offenders.push(`${relativeTo(file)}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

function relativeTo(file: string): string {
  return file.slice(repoRoot.length + 1);
}

function walkSource(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const child = join(root, entry);
    if (statSync(child).isDirectory()) found.push(...walkSource(child));
    else if (extname(child) === '.ts' && !child.endsWith('.test.ts')) found.push(child);
  }
  return found;
}

/**
 * Environment variable names a source file reads, in the four shapes the codebase uses:
 * `process.env.NAME`, `process.env['NAME']`, `readPort(env, 'NAME')`, `readFlag(env, 'NAME')`.
 * `readInteger` reads a port-style variable, so it is included for the same reason.
 */
function referencedEnvNames(text: string): string[] {
  const names: string[] = [];
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[\s*'([A-Z][A-Z0-9_]*)'\s*\]/g,
    /read(?:Port|Flag|Integer)\(\s*[A-Za-z_$][\w$]*\s*,\s*'([A-Z][A-Z0-9_]*)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== undefined) names.push(match[1]);
    }
  }
  return names;
}
