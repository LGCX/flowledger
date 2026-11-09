import type { Ajv2020 } from 'ajv/dist/2020.js';
import { createAjv, createMessageAjv, schemaIdForPath } from './ajv.js';
import { jsonSchemas, registry, type MessageType } from './generated/schemas.js';
import { checkMerchantWebhookSemantics, checkSemantics } from './semantic.js';

export interface ValidationIssue {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

export type RegisteredEnvelope = {
  kind: 'COMMAND' | 'EVENT';
  type: MessageType;
  schemaVersion: number;
  [key: string]: unknown;
};

export type MessageValidationResult =
  | { ok: true; message: RegisteredEnvelope }
  | {
      ok: false;
      failure: 'UNREGISTERED_TYPE' | 'SCHEMA' | 'SEMANTIC';
      issues: readonly ValidationIssue[];
    };

export type MerchantWebhookResult =
  { ok: true } | { ok: false; failure: 'SCHEMA' | 'SEMANTIC'; issues: readonly ValidationIssue[] };

interface RegistryRow {
  readonly kind: string;
  readonly type: string;
  readonly schema: string;
}

type JsonSchema = Record<string, unknown>;

/** The generated schemas keyed by their registry path. */
export function generatedSchemasByPath(): Map<string, JsonSchema> {
  return new Map(
    (jsonSchemas as readonly { path: string; schema: JsonSchema }[]).map((entry) => [
      entry.path,
      entry.schema,
    ]),
  );
}

/**
 * Called before the message validator is built, so an inconsistent registry fails at
 * startup rather than on the first message of an affected type. Kept here rather than
 * inside `createMessageAjv` to avoid an import cycle between `ajv.ts` and `validate.ts`.
 */
export function assertRegistryConsistent(): void {
  const findings = checkRegistry(registry, generatedSchemasByPath());
  if (findings.length > 0) {
    throw new Error(`registry is inconsistent with the schemas:\n${findings.join('\n')}`);
  }
}

let messageAjv: Ajv2020 | undefined;

function messageValidator(): Ajv2020 {
  if (messageAjv === undefined) {
    assertRegistryConsistent();
    messageAjv = createMessageAjv();
  }
  return messageAjv;
}

/** Ajv `errors[]` mapped to issues: path, keyword, message — never the instance value. */
function toIssues(errors: Ajv2020['errors']): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    rule: error.keyword,
    message: error.message ?? 'invalid',
  }));
}

function schemaFailure(issues: ValidationIssue[]): MessageValidationResult {
  return { ok: false, failure: 'SCHEMA', issues };
}

/**
 * Validates one message against the schema its registry row names.
 *
 * An unregistered `(kind, type)` is reported distinctly from a schema failure: it is the
 * docs/04 §Schema evolution "unsupported version" case, which the consumer routes to the
 * DLQ rather than treating as corruption.
 *
 * The post-schema semantic-correlation stage belongs to P00-T11; until it lands this
 * returns `ok` once the schema passes.
 */
export function validateMessage(input: unknown): MessageValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return schemaFailure([{ path: '', rule: 'envelope', message: 'message must be an object' }]);
  }

  const { kind, type } = input as { kind?: unknown; type?: unknown };
  if (typeof kind !== 'string' || typeof type !== 'string') {
    return schemaFailure([
      { path: '', rule: 'envelope', message: 'message must have string "kind" and "type"' },
    ]);
  }

  const row = (registry.messages as readonly RegistryRow[]).find(
    (candidate) => candidate.kind === kind && candidate.type === type,
  );
  if (row === undefined) {
    return {
      ok: false,
      failure: 'UNREGISTERED_TYPE',
      issues: [
        {
          path: '',
          rule: 'registry',
          message: `no registered message type for kind "${kind}" and type "${type}"`,
        },
      ],
    };
  }

  const validate = messageValidator().getSchema(schemaIdForPath(row.schema));
  if (validate === undefined) {
    return schemaFailure([
      {
        path: '',
        rule: 'registry',
        message: `registered schema ${row.schema} was not compiled`,
      },
    ]);
  }
  if (!validate(input)) {
    return schemaFailure(toIssues(validate.errors));
  }

  // Schema-valid is not consistent: cross-field correlations are checked after the shape.
  const violations = checkSemantics(input as RegisteredEnvelope);
  if (violations.length > 0) {
    return {
      ok: false,
      failure: 'SEMANTIC',
      issues: violations.map((violation) => ({
        path: violation.path,
        rule: violation.rule,
        message: violation.message,
      })),
    };
  }

  return { ok: true, message: input as RegisteredEnvelope };
}

/** The merchant-facing webhook body is not a registered message type, so it is separate. */
export function validateMerchantWebhookPayload(input: unknown): MerchantWebhookResult {
  const validate = messageValidator().getSchema(
    schemaIdForPath('webhooks/merchant-event.v1.schema.json'),
  );
  if (validate === undefined) {
    return {
      ok: false,
      failure: 'SCHEMA',
      issues: [{ path: '', rule: 'registry', message: 'merchant event schema was not compiled' }],
    };
  }
  if (!validate(input)) return { ok: false, failure: 'SCHEMA', issues: toIssues(validate.errors) };

  const violations = checkMerchantWebhookSemantics(input as Record<string, unknown>);
  if (violations.length > 0) {
    return {
      ok: false,
      failure: 'SEMANTIC',
      issues: violations.map((violation) => ({
        path: violation.path,
        rule: violation.rule,
        message: violation.message,
      })),
    };
  }
  return { ok: true };
}

function propertyAt(node: unknown, ...keys: (string | number)[]): unknown {
  let current: unknown = node;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * The values a schema accepts for one of the envelope's identity fields. A single type
 * declares `const`; a closed family (one schema, several event types) declares `enum`.
 */
function acceptedValues(schema: JsonSchema, field: string): unknown[] | undefined {
  const declared = propertyAt(schema, 'allOf', 1, 'properties', field);
  const constant = propertyAt(declared, 'const');
  if (constant !== undefined) return [constant];
  const enumerated = propertyAt(declared, 'enum');
  return Array.isArray(enumerated) ? enumerated : undefined;
}

/** `.vN` suffix of a message type, as a number. */
function versionSuffix(type: string): number | undefined {
  const match = /\.v(\d+)$/.exec(type);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The registry rules JSON Schema cannot express (schemas/README §Registry manifest rules
 * 1–3 and 5). Rule 4, catalog parity, compares against prose and lives in
 * `test/contract/catalog-parity.test.ts`.
 *
 * Pure: takes the registry and a path-keyed schema map, so tests can mutate either.
 */
export function checkRegistry(
  candidate: { readonly messages: readonly RegistryRow[] },
  schemasByPath: ReadonlyMap<string, JsonSchema>,
  makeAjv: () => Ajv2020 = createAjv,
): string[] {
  const findings: string[] = [];
  const seen = new Map<string, string>();

  for (const row of candidate.messages) {
    const where = `${row.kind}/${row.type}`;

    const previous = seen.get(where);
    if (previous === undefined) seen.set(where, row.schema);
    else findings.push(`rule1: duplicate registry pair ${where} (${previous} and ${row.schema})`);

    if (!row.schema.startsWith('commands/') && !row.schema.startsWith('events/')) {
      findings.push(
        `rule2: ${where} schema path "${row.schema}" is not under commands/ or events/`,
      );
      continue;
    }

    const schema = schemasByPath.get(row.schema);
    if (schema === undefined) {
      findings.push(`rule2: ${where} references missing schema "${row.schema}"`);
      continue;
    }

    const kinds = acceptedValues(schema, 'kind');
    if (kinds === undefined || !kinds.includes(row.kind)) {
      findings.push(
        `rule3: ${where} schema "${row.schema}" declares kind ${JSON.stringify(kinds ?? null)} that does not match the registry`,
      );
    }

    const types = acceptedValues(schema, 'type');
    if (types === undefined || !types.includes(row.type)) {
      findings.push(
        `rule3: ${where} schema "${row.schema}" does not accept type "${row.type}" (declares ${JSON.stringify(types ?? null)})`,
      );
    }

    const suffix = versionSuffix(row.type);
    const versions = acceptedValues(schema, 'schemaVersion');
    if (suffix === undefined) {
      findings.push(`rule3: ${where} type has no .vN version suffix`);
    } else if (versions === undefined || !versions.includes(suffix)) {
      findings.push(
        `rule3: ${where} schemaVersion ${JSON.stringify(versions ?? null)} does not match the .v${suffix} suffix`,
      );
    }
  }

  // Sibling schemas must be registered before any of them is compiled, or a legitimate
  // relative `$ref` (../common/...) would look unresolved.
  const ajv = makeAjv();
  const compiled: Array<[string, JsonSchema]> = [];
  for (const [path, schema] of schemasByPath) {
    try {
      ajv.addSchema(schema);
      compiled.push([path, schema]);
    } catch (error) {
      findings.push(`rule5: schema "${path}" cannot be registered: ${(error as Error).message}`);
    }
  }
  for (const [path, schema] of compiled) {
    const id = typeof schema.$id === 'string' ? schema.$id : schemaIdForPath(path);
    try {
      if (ajv.getSchema(id) === undefined) throw new Error(`schema not compiled under ${id}`);
    } catch (error) {
      findings.push(`rule5: schema "${path}" has an unresolved $ref: ${(error as Error).message}`);
    }
  }

  return findings;
}
