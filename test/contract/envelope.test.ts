/**
 * `buildEnvelope` is the only way a producer creates an envelope, so its contract is narrow on
 * purpose: it validates, it copies, it freezes — and it invents nothing.
 *
 * The "no id generated" case matters most. A builder that supplied an envelope ID or a
 * timestamp would make every producer's output different on each run, defeat deterministic
 * tests, and create a second source of deduplication identity beside the one the caller
 * chose.
 */
import { describe, expect, it } from 'vitest';
import { EnvelopeValidationError, buildEnvelope, type EnvelopeInput } from '@flowledger/contracts';
import { registeredTypes } from '@flowledger/contracts';
import { validMessages } from './fixtures/messages.js';

type Message = Record<string, unknown>;

function input(message: Message): EnvelopeInput {
  return structuredClone(message) as unknown as EnvelopeInput;
}

function fixture(type: string): Message {
  return structuredClone(validMessages[type as keyof typeof validMessages]) as Message;
}

describe('buildEnvelope', () => {
  it.each([...registeredTypes])('%s fixture builds', (type) => {
    const source = fixture(type);
    const built = buildEnvelope(input(source));

    expect(built).toEqual(source);
    expect(Object.isFrozen(built)).toBe(true);
  });

  it('a schema-invalid input throws SCHEMA', () => {
    const broken = { ...fixture('payment.created.v1'), schemaVersion: 9 };

    let caught: unknown;
    try {
      buildEnvelope(input(broken));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvelopeValidationError);
    expect((caught as EnvelopeValidationError).failure).toBe('SCHEMA');
    expect((caught as EnvelopeValidationError).issues.length).toBeGreaterThan(0);
  });

  it('a schema-valid but semantically inconsistent input throws SEMANTIC', () => {
    const broken = fixture('payment.operation.execute.v1');
    broken.aggregateVersion = 6; // expectedPaymentVersion stays 5

    let caught: unknown;
    try {
      buildEnvelope(input(broken));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvelopeValidationError);
    expect((caught as EnvelopeValidationError).failure).toBe('SEMANTIC');
    expect((caught as EnvelopeValidationError).issues.map((issue) => issue.rule)).toContain(
      'EXECUTE_AGGREGATE_VERSION_EQUALS_EXPECTED_PAYMENT_VERSION',
    );
  });

  it('the returned envelope is a copy, not the caller’s object', () => {
    const source = fixture('payment.created.v1');
    const built = buildEnvelope(input(source));

    source.aggregateVersion = 99;

    expect(built.aggregateVersion).toBe(1);
    expect(() => {
      (built as unknown as Message).aggregateVersion = 99;
    }).toThrow();
  });

  it('no envelope id is generated when the caller omits one', () => {
    const withoutId = fixture('payment.created.v1');
    delete withoutId.id;

    let caught: unknown;
    try {
      buildEnvelope(input(withoutId));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvelopeValidationError);
    expect((caught as EnvelopeValidationError).failure).toBe('SCHEMA');
    // Ajv reports a missing required property on the containing object.
    expect(
      (caught as EnvelopeValidationError).issues.some(
        (issue) => issue.rule === 'required' && issue.message.includes('id'),
      ),
    ).toBe(true);
  });

  it('an omitted traceparent is absent from the result, not null', () => {
    const withoutTrace = fixture('payment.created.v1');
    delete withoutTrace.traceparent;

    const built = buildEnvelope(input(withoutTrace)) as unknown as Message;

    expect('traceparent' in built).toBe(false);
  });
});
