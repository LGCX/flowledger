import { describe, expect, it } from 'vitest';
import {
  checkRegistry,
  generatedSchemasByPath,
  validateMessage,
} from '../../packages/contracts/src/validate.js';
import { registry } from '../../packages/contracts/src/generated/schemas.js';

type JsonSchema = Record<string, unknown>;
interface Row {
  kind: string;
  type: string;
  schema: string;
}

const REAL_ROWS = registry.messages as unknown as Row[];

function rows(): Row[] {
  return structuredClone(REAL_ROWS);
}

function schemas(): Map<string, JsonSchema> {
  const map = new Map<string, JsonSchema>();
  for (const [path, schema] of generatedSchemasByPath()) {
    map.set(path, structuredClone(schema) as JsonSchema);
  }
  return map;
}

/** `allOf[1].properties.<field>.const` of a schema in the map. */
function setDeclared(
  map: Map<string, JsonSchema>,
  path: string,
  field: string,
  value: unknown,
): void {
  const schema = map.get(path) as Record<string, unknown>;
  const allOf = schema['allOf'] as Array<Record<string, unknown>>;
  const properties = (allOf[1] as Record<string, unknown>)['properties'] as Record<
    string,
    Record<string, unknown>
  >;
  properties[field] = { const: value };
}

const COMMAND = 'commands/payment-operation-execute.v1.schema.json';
const EVENT = 'events/payment-created.v1.schema.json';

describe('registry rules', () => {
  it('real registry has zero findings', () => {
    expect(checkRegistry({ messages: rows() }, schemas())).toEqual([]);
  });

  it('rule1 duplicate (kind,type) detected', () => {
    // Two different rows, same pair, different schema path: `uniqueItems` would pass.
    const mutated = rows();
    const original = mutated.find((row) => row.type === 'payment.created.v1') as Row;
    mutated.push({ kind: original.kind, type: original.type, schema: COMMAND });

    const findings = checkRegistry({ messages: mutated }, schemas());
    expect(findings.some((finding) => finding.startsWith('rule1:'))).toBe(true);
    expect(findings.join('\n')).toContain('payment.created.v1');
  });

  it('rule2 missing schema path detected', () => {
    const mutated = rows();
    (mutated[0] as Row).schema = 'events/does-not-exist.v1.schema.json';

    const findings = checkRegistry({ messages: mutated }, schemas());
    expect(findings.some((finding) => finding.startsWith('rule2:'))).toBe(true);
    expect(findings.join('\n')).toContain('does-not-exist');
  });

  it('rule2 path outside commands/events detected', () => {
    const mutated = rows();
    (mutated[0] as Row).schema = 'common/money.v1.schema.json';

    const findings = checkRegistry({ messages: mutated }, schemas());
    expect(findings.some((finding) => finding.startsWith('rule2:'))).toBe(true);
    expect(findings.join('\n')).toContain('not under commands/ or events/');
  });

  it('rule3 kind mismatch detected', () => {
    const mutated = schemas();
    setDeclared(mutated, COMMAND, 'kind', 'EVENT');

    const findings = checkRegistry({ messages: rows() }, mutated);
    expect(findings.some((finding) => finding.startsWith('rule3:'))).toBe(true);
    expect(findings.join('\n')).toContain('kind');
  });

  it('rule3 type not in schema enum detected', () => {
    const mutated = schemas();
    setDeclared(mutated, EVENT, 'type', 'payment.created.v99');

    const findings = checkRegistry({ messages: rows() }, mutated);
    expect(findings.some((finding) => finding.startsWith('rule3:'))).toBe(true);
    expect(findings.join('\n')).toContain('payment.created.v1');
  });

  it('rule3 schemaVersion/suffix mismatch detected', () => {
    const mutated = schemas();
    setDeclared(mutated, EVENT, 'schemaVersion', 2);

    const findings = checkRegistry({ messages: rows() }, mutated);
    expect(findings.some((finding) => finding.startsWith('rule3:'))).toBe(true);
    expect(findings.join('\n')).toContain('schemaVersion');
  });

  it('rule5 unresolved $ref detected', () => {
    const mutated = schemas();
    mutated.set('commands/broken.v1.schema.json', {
      $id: 'https://flowledger.dev/schemas/commands/broken.v1.schema.json',
      type: 'object',
      properties: { x: { $ref: 'nowhere.v1.schema.json' } },
    });

    const findings = checkRegistry({ messages: rows() }, mutated);
    expect(findings.some((finding) => finding.startsWith('rule5:'))).toBe(true);
  });
});

describe('validateMessage', () => {
  it('unregistered type → UNREGISTERED_TYPE', () => {
    const result = validateMessage({
      kind: 'EVENT',
      type: 'payment.created.v2',
      schemaVersion: 2,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe('UNREGISTERED_TYPE');
    expect(result.issues[0]?.message).toContain('payment.created.v2');
  });

  it('non-object → SCHEMA', () => {
    for (const value of [42, 'text', null, [], undefined]) {
      const result = validateMessage(value);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure).toBe('SCHEMA');
      expect(result.issues[0]?.rule).toBe('envelope');
    }
  });

  it('object without kind/type → SCHEMA', () => {
    const result = validateMessage({ schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe('SCHEMA');
    expect(result.issues[0]?.rule).toBe('envelope');
  });

  it('issues never carry instance data', () => {
    const result = validateMessage({ kind: 'EVENT', type: 'payment.created.v1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    for (const issue of result.issues) {
      expect(Object.keys(issue).sort()).toEqual(['message', 'path', 'rule']);
    }
  });
});
