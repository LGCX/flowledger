/**
 * The fixture suite: every registered type validates, and every high-risk defect is
 * rejected for the reason it names.
 *
 * schemas/README §Local validation items 5–6 ask for one positive and multiple negative
 * fixtures per registered type, so this file also guards the fixture set itself — a type
 * added to the registry without fixtures fails here instead of silently going untested.
 */
import { describe, expect, it } from 'vitest';
import { validateMessage } from '@flowledger/contracts';
import { registeredTypes } from '@flowledger/contracts';
import { validMessages } from './fixtures/messages.js';
import { negativeCases } from './fixtures/mutations.js';

type Message = Record<string, unknown>;

const TYPES = [...registeredTypes] as readonly string[];

function clone(message: Message): Message {
  return structuredClone(message);
}

function fixtureFor(type: string): Message {
  const fixture = (validMessages as Record<string, Message>)[type];
  if (fixture === undefined) throw new Error(`no positive fixture for ${type}`);
  return clone(fixture);
}

/** Types a case applies to; `'all'` means every registered type. */
function targetsOf(entry: { appliesTo: readonly string[] | 'all' }): string[] {
  return entry.appliesTo === 'all' ? [...TYPES] : [...entry.appliesTo];
}

describe('message fixtures', () => {
  it('covers exactly the registered types', () => {
    expect(Object.keys(validMessages).sort()).toEqual([...TYPES].sort());
  });

  it.each(TYPES)('%s has a schema-valid positive fixture', (type) => {
    const result = validateMessage(fixtureFor(type));
    expect(result.ok, JSON.stringify(!result.ok ? result.issues : [])).toBe(true);
  });

  it.each(
    negativeCases.flatMap((entry) =>
      targetsOf(entry).map((type) => [entry.name, type, entry] as const),
    ),
  )('%s is rejected on %s with the expected keyword', (name, type, entry) => {
    const mutated = entry.mutate(fixtureFor(type));
    const result = validateMessage(mutated);

    expect(result.ok, `${name} on ${type} was accepted`).toBe(false);
    if (result.ok) return;
    expect(result.failure, `${name} on ${type} failed for the wrong stage`).toBe('SCHEMA');

    const prefix = entry.expect.instancePathPrefix ?? '';
    const matching = result.issues.filter(
      (issue) => issue.rule === entry.expect.keyword && issue.path.startsWith(prefix),
    );
    expect(
      matching,
      `${name} on ${type}: expected "${entry.expect.keyword}" at ${JSON.stringify(prefix)}, got ${JSON.stringify(
        result.issues.map((issue) => `${issue.rule}@${issue.path}`),
      )}`,
    ).not.toHaveLength(0);
  });

  it('every registered type has at least five applicable negative cases', () => {
    const counts = new Map<string, number>(TYPES.map((type) => [type, 0]));
    for (const entry of negativeCases) {
      for (const type of targetsOf(entry)) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }

    const short = [...counts.entries()].filter(([, count]) => count < 5);
    expect(short).toEqual([]);
  });

  it('every negative case applies to at least one registered type', () => {
    for (const entry of negativeCases) {
      expect(targetsOf(entry).length, entry.name).toBeGreaterThan(0);
    }
  });

  it('the negative suite covers the README defect classes', () => {
    const names = new Set(negativeCases.map((entry) => entry.name));
    for (const required of [
      'unknown-envelope-field',
      'unknown-data-field',
      'invalid-uuid-id',
      'invalid-date-time',
      'overflow-ulid',
      'wrong-entity-prefix',
      'zero-operation-amount',
      'amount-above-max',
      'mismatched-outcome',
      'missing-evidence',
      'failed-without-proof',
      'rejected-without-error',
    ]) {
      expect(names.has(required), required).toBe(true);
    }
  });
});
