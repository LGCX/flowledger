/**
 * The OpenAPI document is the contract the merchant API is built from, so three things must
 * hold before any code depends on it (docs/10 §M0, docs/09 §Static checks):
 *
 *   1. It parses and every local `$ref` resolves.
 *   2. Every example the document carries validates against the schema it sits on — an
 *      example is the most-read part of a contract and the easiest to let rot.
 *   3. The problem codes in docs/05 equal `ProblemCode.enum`, and each is reachable from the
 *      `Problem<status>` schema for the status the table claims.
 *
 * The example walker reports JSON pointers into the source document, so a failure names the
 * line to fix rather than "an example is invalid".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import {
  createAjv,
  openApiComponentsSchema,
  openApiExtensionKeywords,
} from '@flowledger/contracts';

type JsonObject = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const openapiPath = join(repoRoot, 'openapi', 'openapi.yaml');

const componentsId = openApiComponentsSchema.$id;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refs inside the document point at `#/components/schemas/<Name>`; the generated components
 * schema stores the same definitions under `#/$defs/<Name>` (as its generator rewrites
 * them). A node is rewritten the same way before compiling so it resolves against the
 * components document instead of its own root.
 */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === '$ref' && typeof value === 'string'
        ? value.split('#/components/schemas/').join('#/$defs/')
        : rewriteRefs(value);
  }
  return out;
}

interface ExampleTarget {
  /** JSON pointer into the source document, ending at the example itself. */
  pointer: string;
  /** The schema the example must satisfy. */
  schema: JsonObject;
  example: unknown;
}

/**
 * Collects every example in a document. Two forms exist and they are not the same thing:
 * a JSON Schema `examples` is an array of instance values, while an OpenAPI media-type or
 * parameter `examples` is a map of Example Objects keyed by name, each holding `value`.
 */
function collectExamples(node: unknown, pointer = '', out: ExampleTarget[] = []): ExampleTarget[] {
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectExamples(child, `${pointer}/${index}`, out));
    return out;
  }
  if (!isObject(node)) return out;

  if (Array.isArray(node.examples)) {
    const { examples, ...schema } = node;
    examples.forEach((example, index) => {
      out.push({ pointer: `${pointer}/examples/${index}`, schema, example });
    });
    for (const [key, value] of Object.entries(schema)) {
      collectExamples(value, `${pointer}/${key}`, out);
    }
    return out;
  }

  if (isObject(node.examples)) {
    for (const [name, entry] of Object.entries(node.examples)) {
      if (isObject(entry) && 'value' in entry) {
        out.push({
          pointer: `${pointer}/examples/${name}/value`,
          schema: isObject(node.schema) ? node.schema : {},
          example: entry.value,
        });
      }
    }
  }

  if ('example' in node && node.example !== undefined) {
    const { example, ...rest } = node;
    out.push({
      pointer: `${pointer}/example`,
      schema: isObject(node.schema) ? node.schema : rest,
      example,
    });
    for (const [key, value] of Object.entries(rest)) {
      collectExamples(value, `${pointer}/${key}`, out);
    }
    return out;
  }

  for (const [key, value] of Object.entries(node)) {
    collectExamples(value, `${pointer}/${key}`, out);
  }
  return out;
}

function createDocumentAjv() {
  const ajv = createAjv();
  // Extension keywords are annotations; without registering them, strict mode refuses to
  // compile any schema that carries one.
  for (const keyword of openApiExtensionKeywords) ajv.addKeyword(keyword);
  ajv.addSchema(openApiComponentsSchema);
  return ajv;
}

/** Validates every example in `document`, returning one message per failure. */
function exampleFailures(document: JsonObject): { targets: ExampleTarget[]; failures: string[] } {
  const ajv = createDocumentAjv();
  const componentDefs = (isObject(document.components) ? document.components.schemas : {}) as
    JsonObject | undefined;
  const sharedDefs = rewriteRefs(componentDefs ?? {}) as JsonObject;

  const targets = collectExamples(document);
  const failures: string[] = [];

  targets.forEach((target, index) => {
    const rewritten = rewriteRefs(target.schema) as JsonObject;
    // A distinct $id per example keeps the compiler cache separate while the copied $defs
    // give the node's rewritten `#/$defs/...` refs something to resolve against.
    const validate = ajv.compile({
      ...rewritten,
      $id: `urn:flowledger:openapi-example:${index}`,
      $defs: { ...sharedDefs, ...(rewritten.$defs as JsonObject | undefined) },
    });
    if (!validate(target.example)) {
      failures.push(`${target.pointer}: ${ajv.errorsText(validate.errors)}`);
    }
  });

  return { targets, failures };
}

async function readDocument(): Promise<JsonObject> {
  return (await SwaggerParser.parse(openapiPath)) as unknown as JsonObject;
}

interface ProblemCodeRow {
  status: number;
  code: string;
}

/** Rows of the `| HTTP | Code | Meaning |` table under docs/05 §Canonical error format. */
function problemCodeTable(): ProblemCodeRow[] {
  const source = readFileSync(join(repoRoot, 'docs', '05-API_AND_IDEMPOTENCY_CONTRACT.md'), 'utf8');
  const start = source.indexOf('## Canonical error format');
  const end = source.indexOf('\n## ', start + 5);
  const section = source.slice(start, end === -1 ? undefined : end);

  const rows: ProblemCodeRow[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((cell) => cell.trim().replace(/`/g, ''));
    const [, status, code] = cells;
    if (status === undefined || code === undefined) continue;
    if (!/^\d{3}$/.test(status) || !/^[A-Z][A-Z0-9_]*$/.test(code)) continue;
    rows.push({ status: Number(status), code });
  }
  return rows;
}

/** `code` values a `Problem<status>` schema permits, from `allOf[1].properties.code`. */
function codesByStatus(document: JsonObject): Map<number, Set<string>> {
  const schemas = (isObject(document.components) ? document.components.schemas : {}) as JsonObject;
  const byStatus = new Map<number, Set<string>>();

  for (const [name, schema] of Object.entries(schemas)) {
    if (!/^Problem\d{3}/.test(name) || name.endsWith('Response')) continue;
    if (!isObject(schema) || !Array.isArray(schema.allOf)) continue;
    const detail = schema.allOf.find(
      (part): part is JsonObject => isObject(part) && isObject(part.properties),
    );
    if (detail === undefined) continue;

    const properties = detail.properties as JsonObject;
    const status = isObject(properties.status) ? properties.status.const : undefined;
    const code = properties.code;
    if (typeof status !== 'number' || !isObject(code)) continue;

    const allowed = new Set<string>();
    if (typeof code.const === 'string') allowed.add(code.const);
    if (Array.isArray(code.enum)) {
      for (const value of code.enum) if (typeof value === 'string') allowed.add(value);
    }
    if (allowed.size === 0) continue;

    const existing = byStatus.get(status) ?? new Set<string>();
    for (const value of allowed) existing.add(value);
    byStatus.set(status, existing);
  }
  return byStatus;
}

describe('openapi document', () => {
  it('parses, validates and resolves every local reference', async () => {
    const api = await SwaggerParser.validate(openapiPath);
    expect(api.openapi).toMatch(/^3\.1/);
    expect(Object.keys((api.paths ?? {}) as JsonObject).length).toBeGreaterThan(0);
  });

  it('every component schema compiles under strict mode', () => {
    const ajv = createDocumentAjv();
    const defs = openApiComponentsSchema.$defs as JsonObject;

    for (const name of Object.keys(defs)) {
      expect(() => ajv.compile({ $ref: `${componentsId}#/$defs/${name}` }), name).not.toThrow();
    }
  });

  it('every example in the document validates', async () => {
    const document = await readDocument();
    const { targets, failures } = exampleFailures(document);

    expect(targets.length, 'the document is expected to carry examples').toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  it('an invalid component example is reported at its JSON pointer', async () => {
    const document = await readDocument();
    const schemas = (document.components as JsonObject).schemas as JsonObject;
    (schemas.PaymentId as JsonObject).examples = ['pay_BAD'];

    const { failures } = exampleFailures(document);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.split(':')[0]).toBe('/components/schemas/PaymentId/examples/0');
  });

  it('an unregistered extension keyword fails compilation', () => {
    const ajv = createAjv();
    const defs = openApiComponentsSchema.$defs as JsonObject;

    expect(() =>
      ajv.compile({
        $ref: `${componentsId}#/$defs/Payment`,
        $defs: { ...defs, Marked: { type: 'string', 'x-unregistered': true } },
      }),
    ).toThrow();
  });

  it('problem codes in docs/05 equal the OpenAPI enum', async () => {
    const document = await readDocument();
    const schemas = (document.components as JsonObject).schemas as JsonObject;
    const enumValues = ((schemas.ProblemCode as JsonObject).enum ?? []) as string[];

    const tableCodes = [...new Set(problemCodeTable().map((row) => row.code))].sort();
    expect(tableCodes).toEqual([...enumValues].sort());
  });

  it('each documented code is reachable from its status schema', async () => {
    const document = await readDocument();
    const byStatus = codesByStatus(document);
    const rows = problemCodeTable();

    expect(rows.length).toBeGreaterThan(0);
    const unreachable = rows
      .filter((row) => !(byStatus.get(row.status)?.has(row.code) ?? false))
      .map((row) => `${row.status} ${row.code}`);

    expect(unreachable).toEqual([]);
  });

  it('the problem table is not silently empty', () => {
    expect(problemCodeTable()).toHaveLength(27);
  });
});
