/**
 * Provider idempotency keys.
 *
 * The golden file is the authority: its hashed digests were produced with Python's hashlib and
 * base64.b32encode, independently of this implementation, so a matching result cross-checks the base32
 * encoder rather than restating it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { type EntityId, newId } from './ids.js';
import {
  PROVIDER_ENVIRONMENTS,
  type ProviderEnvironment,
  type ProviderKeyForm,
  deriveProviderIdempotencyKey,
  providerKeyHashInput,
} from './provider-key.js';
import type { ProviderName } from './values.js';

interface Vector {
  readonly id: string;
  readonly inputs: {
    readonly environment: ProviderEnvironment;
    readonly provider: string;
    readonly operationId: string;
    readonly maxKeyLength: number;
  };
  readonly expected: {
    readonly key?: string;
    readonly form?: ProviderKeyForm;
    readonly error?: string;
  };
}

// Read rather than imported: the repo has no `resolveJsonModule`, and every other fixture is loaded
// the same way (`readFileSync` + `JSON.parse`).
const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(here, '..', 'golden', 'provider-key.v1.json'), 'utf8'),
) as { vectors: Vector[] };

const vectors = golden.vectors;

function derive(vector: Vector) {
  return deriveProviderIdempotencyKey({
    environment: vector.inputs.environment,
    provider: vector.inputs.provider as ProviderName,
    operationId: vector.inputs.operationId as Parameters<
      typeof deriveProviderIdempotencyKey
    >[0]['operationId'],
    maxKeyLength: vector.inputs.maxKeyLength,
  });
}

describe('golden vectors', () => {
  it.each(vectors.map((vector) => [vector.id, vector] as const))('%s', (_id, vector) => {
    if (vector.expected.error !== undefined) {
      expect(() => derive(vector)).toThrow(DomainError);
      try {
        derive(vector);
      } catch (error) {
        const domainError = error as DomainError;
        expect(`${domainError.code}/${domainError.reason}`).toBe(
          `INTERNAL_ERROR/${vector.expected.error}`,
        );
      }
      return;
    }

    const derivation = derive(vector);
    expect(derivation.key).toBe(vector.expected.key);
    expect(derivation.form).toBe(vector.expected.form);
    expect(derivation.inputs).toEqual({
      environment: vector.inputs.environment,
      provider: vector.inputs.provider,
      operationId: vector.inputs.operationId,
    });
  });

  it('covers the six planning rows', () => {
    expect(vectors.map((vector) => vector.id)).toEqual([
      'plain-docs-example',
      'plain-boundary',
      'hashed-boundary',
      'plain-unreliable',
      'hashed-unreliable',
      'limit-too-small',
    ]);
  });

  it('the plain form equals the docs/04 capture-event example', () => {
    const vector = vectors.find((candidate) => candidate.id === 'plain-docs-example');
    expect(vector?.expected.key).toBe(
      'flowledger:test:fake-provider:op_01ARZ3NDEKTSV4RRFFQ69G5FAX',
    );
  });
});

describe('shape', () => {
  const op = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAX' as Parameters<
    typeof deriveProviderIdempotencyKey
  >[0]['operationId'];

  it('the hashed key is 58 characters', () => {
    const derivation = deriveProviderIdempotencyKey({
      environment: 'test',
      provider: 'fake-provider' as ProviderName,
      operationId: op,
      maxKeyLength: 58,
    });
    expect(derivation.key).toHaveLength(58);
    expect(derivation.form).toBe('HASHED_V1');
  });

  it('the hashed body uses the lowercase unpadded base32 alphabet only', () => {
    const derivation = deriveProviderIdempotencyKey({
      environment: 'test',
      provider: 'fake-provider' as ProviderName,
      operationId: op,
      maxKeyLength: 58,
    });
    const body = derivation.key.slice('fl:v1:'.length);
    expect(body).toMatch(/^[a-z2-7]{52}$/);
    expect(body).not.toContain('=');
  });

  it('the hash input is the documented pipe-joined triple', () => {
    expect(
      providerKeyHashInput({
        environment: 'test',
        provider: 'fake-provider' as ProviderName,
        operationId: op,
      }),
    ).toBe(`test|fake-provider|${op}`);
  });

  it('a limit exactly at the plain length stays plain', () => {
    const plainLength = `flowledger:test:fake-provider:${op}`.length;
    const derivation = deriveProviderIdempotencyKey({
      environment: 'test',
      provider: 'fake-provider' as ProviderName,
      operationId: op,
      maxKeyLength: plainLength,
    });
    expect(derivation.form).toBe('PLAIN');
  });

  it('a limit below the hashed length throws instead of truncating', () => {
    expect(() =>
      deriveProviderIdempotencyKey({
        environment: 'test',
        provider: 'fake-provider' as ProviderName,
        operationId: op,
        maxKeyLength: 57,
      }),
    ).toThrow(DomainError);
  });
});

describe('properties', () => {
  it('is deterministic across calls', () => {
    const id = newId('op');
    const first = deriveProviderIdempotencyKey({
      environment: 'test',
      provider: 'fake-provider' as ProviderName,
      operationId: id,
      maxKeyLength: 255,
    });
    const second = deriveProviderIdempotencyKey({
      environment: 'test',
      provider: 'fake-provider' as ProviderName,
      operationId: id,
      maxKeyLength: 255,
    });
    expect(second.key).toBe(first.key);
    expect(second.form).toBe('PLAIN');
  });

  it('distinct operation ids give distinct keys in both forms', () => {
    const plain = new Set<string>();
    const hashed = new Set<string>();
    const generated: EntityId<'op'>[] = [];

    for (let index = 0; index < 1_000; index += 1) {
      const id = newId('op');
      generated.push(id);
      plain.add(
        deriveProviderIdempotencyKey({
          environment: 'test',
          provider: 'fake-provider' as ProviderName,
          operationId: id,
          maxKeyLength: 255,
        }).key,
      );
      hashed.add(
        deriveProviderIdempotencyKey({
          environment: 'test',
          provider: 'fake-provider' as ProviderName,
          operationId: id,
          maxKeyLength: 58,
        }).key,
      );
    }

    expect(new Set(generated).size).toBe(1_000);
    expect(plain.size).toBe(1_000);
    expect(hashed.size).toBe(1_000);
  });

  it('the key is a pure function of the three inputs', () => {
    // Same three inputs, different maxKeyLength, chosen so both follow the PLAIN path: the key must be
    // identical. Nothing about the call — time, attempt, sequence — can leak into it.
    const id = newId('op');
    const a = deriveProviderIdempotencyKey({
      environment: 'local',
      provider: 'fake-provider' as ProviderName,
      operationId: id,
      maxKeyLength: 255,
    });
    const b = deriveProviderIdempotencyKey({
      environment: 'local',
      provider: 'fake-provider' as ProviderName,
      operationId: id,
      maxKeyLength: 300,
    });
    expect(a.key).toBe(b.key);
  });

  it('environment and provider both affect the hashed key', () => {
    const id = newId('op');
    const keys = new Set<string>();
    for (const environment of PROVIDER_ENVIRONMENTS) {
      keys.add(
        deriveProviderIdempotencyKey({
          environment,
          provider: 'fake-provider' as ProviderName,
          operationId: id,
          maxKeyLength: 58,
        }).key,
      );
    }
    expect(keys.size).toBe(PROVIDER_ENVIRONMENTS.length);

    const byProvider = new Set<string>();
    for (const provider of ['fake-provider', 'unreliable-provider']) {
      byProvider.add(
        deriveProviderIdempotencyKey({
          environment: 'test',
          provider: provider as ProviderName,
          operationId: id,
          maxKeyLength: 58,
        }).key,
      );
    }
    expect(byProvider.size).toBe(2);
  });

  it('the plain key contains no counter or timestamp beyond its inputs', () => {
    const id = newId('op');
    const derivation = deriveProviderIdempotencyKey({
      environment: 'test',
      provider: 'fake-provider' as ProviderName,
      operationId: id,
      maxKeyLength: 255,
    });
    expect(derivation.key).toBe(`flowledger:test:fake-provider:${id}`);
  });
});
