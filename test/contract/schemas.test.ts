import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAjv, createMessageAjv } from '../../packages/contracts/src/ajv.js';
import { jsonSchemas } from '../../packages/contracts/src/generated/schemas.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const schemasDir = join(repoRoot, 'schemas');

function allJsonFiles(dir = schemasDir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allJsonFiles(full));
    else if (entry.name.endsWith('.json')) found.push(full);
  }
  return found.sort();
}

describe('schemas', () => {
  it('every schemas/**/*.json parses', () => {
    const files = allJsonFiles();
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      expect(() => JSON.parse(readFileSync(file, 'utf8')), file).not.toThrow();
    }
  });

  it('every schema compiles under Draft 2020-12 strictSchema', () => {
    // Eager compilation of all of them: a bad $ref or unknown keyword throws here.
    expect(() => createMessageAjv()).not.toThrow();
    expect(jsonSchemas).toHaveLength(20);
  });

  it('uuid format asserted', () => {
    const validate = createAjv().compile({
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
    });
    expect(validate({ id: '2f1c9d3e-5b7a-4c8d-9e0f-1a2b3c4d5e6f' })).toBe(true);
    expect(validate({ id: 'not-a-uuid' })).toBe(false);
  });

  it('date-time format asserted', () => {
    const validate = createAjv().compile({
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      required: ['at'],
    });
    expect(validate({ at: '2026-01-02T03:04:05.678Z' })).toBe(true);
    expect(validate({ at: '2026-13-45' })).toBe(false);
  });

  it('unknown keyword is a configuration error', () => {
    expect(() => createAjv().compile({ type: 'object', typo: true })).toThrow();
  });

  it('remote $ref is rejected without network', () => {
    const ajv = createAjv();
    expect(() =>
      ajv.compile({
        type: 'object',
        properties: { remote: { $ref: 'https://example.com/x.json' } },
      }),
    ).toThrow(/can't resolve reference|MissingRef|missingRef|resolve/i);
  });

  it('registry manifest validates', () => {
    const validate = createMessageAjv().getSchema(
      'https://flowledger.dev/schemas/registry-manifest.v1.schema.json',
    );
    expect(validate).toBeTypeOf('function');

    const manifest = JSON.parse(readFileSync(join(schemasDir, 'registry.v1.json'), 'utf8'));
    expect(validate?.(manifest)).toBe(true);
  });

  it('registry manifest with extra property fails', () => {
    const validate = createMessageAjv().getSchema(
      'https://flowledger.dev/schemas/registry-manifest.v1.schema.json',
    );
    const manifest = JSON.parse(readFileSync(join(schemasDir, 'registry.v1.json'), 'utf8'));
    const mutated = { ...manifest, unexpected: true };

    expect(validate?.(mutated)).toBe(false);
  });
});
