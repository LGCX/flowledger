/**
 * M1 domain/contract parity (P01-GATE).
 *
 * The domain package keeps its own closed vocabularies as runtime arrays so that lint rules, guards, and
 * adapters share one source. That is only safe while those arrays equal the machine contracts, so this
 * file compares both sides as sets — not as ordered lists, because order carries no meaning in a closed
 * enum and asserting it would fail on harmless reordering while missing a real divergence.
 *
 * Every assertion names both sides. A bare `expect(setA).toEqual(setB)` on a failure tells you two sets
 * differ without saying which value moved, which is the only thing worth knowing here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_OUTCOMES,
  DOMAIN_ERROR_CODES,
  ID_PREFIXES,
  MAX_AMOUNT_MINOR,
  NO_EFFECT_PROOF_KINDS,
  OPERATION_STATUSES,
  OPERATION_TYPES,
  POSTING_OPERATION_TYPES,
  PROVIDER_ERROR_CATEGORIES,
  RECONCILIATION_REASONS,
  RESOLUTION_SOURCES,
  RETRY_DIRECTIVES,
  SUMMARY_STATUSES,
} from '@flowledger/domain';
import { jsonSchemas, openApiComponentsSchema } from '@flowledger/contracts';

const repoRoot = join(__dirname, '..', '..');

interface JsonNode {
  readonly [key: string]: unknown;
}

/** Walks a JSON path, failing with the path rather than with `undefined is not an object`. */
function at(root: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = root;
  for (const step of path) {
    if (node === null || typeof node !== 'object') {
      throw new Error(`cannot read ${String(step)} of a non-object at ${path.join('.')}`);
    }
    node = (node as Record<string | number, unknown>)[step];
  }
  return node;
}

function enumAt(root: unknown, path: readonly (string | number)[], label: string): string[] {
  const value = at(root, path);
  if (!Array.isArray(value)) throw new Error(`${label} at ${path.join('.')} is not an array`);
  return value.map((entry) => String(entry));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function schemaByPath(suffix: string): JsonNode {
  const entry = jsonSchemas.find((candidate) => candidate.path.endsWith(suffix));
  if (entry === undefined) throw new Error(`schema not found: ${suffix}`);
  return entry.schema as JsonNode;
}

/** Asserts two vocabularies hold the same values, naming what differs on failure. */
function expectSameVocabulary(
  domain: readonly string[],
  contract: readonly string[],
  label: string,
): void {
  const missing = sorted(domain).filter((value) => !contract.includes(value));
  const extra = sorted(contract).filter((value) => !domain.includes(value));
  expect({ label, missingFromContract: missing, missingFromDomain: extra }).toEqual({
    label,
    missingFromContract: [],
    missingFromDomain: [],
  });
}

describe('domain error codes are acceptable problem codes', () => {
  it('every DomainErrorCode appears in the openapi ProblemCode enum', () => {
    const problemCodes = enumAt(
      openApiComponentsSchema,
      ['$defs', 'ProblemCode', 'enum'],
      'ProblemCode',
    );
    const unknown = sorted(DOMAIN_ERROR_CODES).filter((code) => !problemCodes.includes(code));
    expect({ unknownDomainCodes: unknown }).toEqual({ unknownDomainCodes: [] });
  });

  it('the domain vocabulary is smaller than the problem vocabulary', () => {
    const problemCodes = enumAt(
      openApiComponentsSchema,
      ['$defs', 'ProblemCode', 'enum'],
      'ProblemCode',
    );
    // HTTP-level problems (RATE_LIMITED, PAYLOAD_TOO_LARGE, ...) are not domain concepts, so this is a
    // proper subset rather than equality — asserted so a future "fix" toward equality is questioned.
    expect(DOMAIN_ERROR_CODES.length).toBeLessThan(problemCodes.length);
  });
});

describe('payment vocabularies match the openapi enums', () => {
  it('PaymentOperation.type', () => {
    expectSameVocabulary(
      OPERATION_TYPES,
      enumAt(
        openApiComponentsSchema,
        ['$defs', 'PaymentOperation', 'properties', 'type', 'enum'],
        'PaymentOperation.type',
      ),
      'OPERATION_TYPES',
    );
  });

  it('PaymentOperation.status', () => {
    expectSameVocabulary(
      OPERATION_STATUSES,
      enumAt(
        openApiComponentsSchema,
        ['$defs', 'PaymentOperation', 'properties', 'status', 'enum'],
        'PaymentOperation.status',
      ),
      'OPERATION_STATUSES',
    );
  });

  it('Payment.authorizationOutcome', () => {
    expectSameVocabulary(
      AUTHORIZATION_OUTCOMES,
      enumAt(
        openApiComponentsSchema,
        ['$defs', 'Payment', 'properties', 'authorizationOutcome', 'enum'],
        'Payment.authorizationOutcome',
      ),
      'AUTHORIZATION_OUTCOMES',
    );
  });

  it('Payment.summaryStatus', () => {
    expectSameVocabulary(
      SUMMARY_STATUSES,
      enumAt(
        openApiComponentsSchema,
        ['$defs', 'Payment', 'properties', 'summaryStatus', 'enum'],
        'Payment.summaryStatus',
      ),
      'SUMMARY_STATUSES',
    );
  });
});

describe('provider vocabularies match the schemas', () => {
  const evidenceSchema = (): JsonNode => schemaByPath('provider-result-evidence.v1.schema.json');

  it('normalizedError.category', () => {
    expectSameVocabulary(
      PROVIDER_ERROR_CATEGORIES,
      enumAt(
        evidenceSchema(),
        ['$defs', 'normalizedError', 'properties', 'category', 'enum'],
        'normalizedError.category',
      ),
      'PROVIDER_ERROR_CATEGORIES',
    );
  });

  it('normalizedError.retryDirective', () => {
    expectSameVocabulary(
      RETRY_DIRECTIVES,
      enumAt(
        evidenceSchema(),
        ['$defs', 'normalizedError', 'properties', 'retryDirective', 'enum'],
        'normalizedError.retryDirective',
      ),
      'RETRY_DIRECTIVES',
    );
  });

  it('noEffectProof kinds', () => {
    const kinds = (
      at(evidenceSchema(), ['$defs', 'noEffectProof', 'oneOf']) as readonly JsonNode[]
    ).map((variant) => {
      const kind = at(variant, ['properties', 'kind']);
      const enumValues = at(kind, ['enum']);
      if (Array.isArray(enumValues)) return String(enumValues[0]);
      return String(at(kind, ['const']));
    });

    expectSameVocabulary(NO_EFFECT_PROOF_KINDS, kinds, 'NO_EFFECT_PROOF_KINDS');
  });

  it('providerEvidence.source', () => {
    expectSameVocabulary(
      RESOLUTION_SOURCES,
      enumAt(
        evidenceSchema(),
        ['$defs', 'providerEvidence', 'properties', 'source', 'enum'],
        'providerEvidence.source',
      ),
      'RESOLUTION_SOURCES',
    );
  });

  it('reconciliation-required reason', () => {
    expectSameVocabulary(
      RECONCILIATION_REASONS,
      enumAt(
        schemaByPath('payment-operation-reconciliation-required.v1.schema.json'),
        ['$defs', 'data', 'properties', 'reason', 'enum'],
        'reconciliation.reason',
      ),
      'RECONCILIATION_REASONS',
    );
  });

  it('ledger-posted operationType', () => {
    expectSameVocabulary(
      POSTING_OPERATION_TYPES,
      enumAt(
        schemaByPath('ledger-transaction-posted.v1.schema.json'),
        ['$defs', 'data', 'properties', 'operationType', 'enum'],
        'ledger.operationType',
      ),
      'POSTING_OPERATION_TYPES',
    );
  });
});

describe('entity id prefixes match the schema definitions', () => {
  it('every prefixed $defs pattern is a domain prefix, and every domain prefix is in the schema', () => {
    const defs = at(schemaByPath('entity-ids.v1.schema.json'), ['$defs']) as Record<
      string,
      JsonNode
    >;

    const prefixed: string[] = [];
    for (const definition of Object.values(defs)) {
      const pattern = at(definition, ['pattern']);
      if (typeof pattern !== 'string') continue;
      const match = /^\^([a-z]+)_/.exec(pattern);
      if (match?.[1] !== undefined) prefixed.push(match[1]);
    }

    expectSameVocabulary(Object.values(ID_PREFIXES), prefixed, 'ID_PREFIXES');
  });

  it('the amount maximum equals the money schema bound', () => {
    const pattern = at(schemaByPath('money.v1.schema.json'), [
      'properties',
      'amountMinor',
      'pattern',
    ]);
    expect(typeof pattern).toBe('string');
    expect(String(pattern)).toContain(MAX_AMOUNT_MINOR.toString());
    expect(MAX_AMOUNT_MINOR).toBe(1_000_000_000_000n);
  });
});

describe('golden files are present and complete', () => {
  const goldens: readonly [string, number][] = [
    ['capture-fee.v1.json', 14],
    ['refund-fee.v1.json', 10],
    ['request-hash.v1.json', 8],
    ['posting-hash.v1.json', 7],
    ['provider-key.v1.json', 6],
  ];

  it.each(goldens)('%s parses and has at least %i rows', (file, minimum) => {
    const parsed = JSON.parse(
      readFileSync(join(repoRoot, 'packages', 'domain', 'golden', file), 'utf8'),
    ) as { vectors?: unknown[]; cases?: unknown[] };
    const rows = parsed.vectors ?? parsed.cases;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows?.length ?? 0).toBeGreaterThanOrEqual(minimum);
  });
});
