/**
 * The detector is the contract every later phase relies on to prove a log line, an event, or a
 * fixture is clean, so both of its failure modes are tested: a real prohibited value must be
 * found, and an innocent value that merely looks numeric must not be.
 *
 * The false-positive cases matter as much as the true ones. A detector that flags the maximum
 * money amount, a ULID, or a SHA-256 digest would be switched off within a week, and the
 * scanner would stop being evidence of anything.
 */
import { describe, expect, it } from 'vitest';
import {
  PROHIBITED_FIXTURES,
  assertNoProhibitedData,
  findProhibitedData,
  type ProhibitedKind,
} from './prohibited-data.js';

function kindsIn(text: string): ProhibitedKind[] {
  return [...new Set(findProhibitedData(text).map((finding) => finding.kind))];
}

describe('prohibited data detection', () => {
  it.each([
    ['pan', 'PAN'],
    ['panFormatted', 'PAN'],
    ['cvvField', 'CARD_FIELD'],
    ['bearerCredential', 'BEARER_CREDENTIAL'],
    ['rawCredential', 'MERCHANT_CREDENTIAL'],
    ['providerSecret', 'PROVIDER_SECRET'],
    ['webhookSigningSecret', 'PROVIDER_SECRET'],
  ] as const)('detects %s as %s', (fixture, kind) => {
    expect(kindsIn(PROHIBITED_FIXTURES[fixture])).toContain(kind);
  });

  it('does not flag a 16-digit number that fails the Luhn check', () => {
    expect(findProhibitedData('4111111111111112')).toEqual([]);
  });

  it('does not flag the maximum money amount', () => {
    // 13 digits: indistinguishable from an amount, so A-08 excludes this length.
    expect(findProhibitedData('1000000000000')).toEqual([]);
  });

  it('flags a 19-digit Luhn-valid number', () => {
    // 4111111111111111417 is Luhn-valid and 19 digits (the longest run we accept).
    expect(kindsIn('4111111111111111417')).toEqual(['PAN']);
  });

  it('flags a hyphen-grouped PAN', () => {
    expect(kindsIn('4111-1111-1111-1111')).toEqual(['PAN']);
  });

  it('does not flag digits embedded in an alphanumeric token', () => {
    expect(findProhibitedData('order4111111111111111ref')).toEqual([]);
  });

  it('detects a CARD_FIELD key case-insensitively', () => {
    expect(kindsIn('{"CardNumber":"4111"}')).toEqual(['CARD_FIELD']);
    expect(kindsIn('account_number = 12345')).toEqual(['CARD_FIELD']);
    expect(kindsIn('SecurityCode: 999')).toEqual(['CARD_FIELD']);
  });

  it('does not flag the documented Authorization placeholder', () => {
    // docs/05 writes the header with a literal ellipsis, not a credential.
    expect(findProhibitedData('Authorization: Bearer ...')).toEqual([]);
  });

  it('does not flag identifiers, digests, or timestamps', () => {
    const innocent = [
      'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'op_01ARZ3NDEKTSV4RRFFQ69G5FAX',
      'mer_01ARZ3NDEKTSV4RRFFQ69G5FAZ',
      '0192f4e7-8b30-7c83-b462-c0d5fe8f132a',
      '8ad048fb808f257f1a6d7e0684728cc35648d9efc251977f8a4a457127fff893',
      '2026-11-05T18:44:31.123Z',
    ];
    for (const value of innocent) {
      expect(findProhibitedData(value), value).toEqual([]);
    }
  });

  it('reports the offset, not the matched text', () => {
    const text = `prefix ${PROHIBITED_FIXTURES.pan} suffix`;
    const [finding] = findProhibitedData(text);
    expect(finding).toEqual({ kind: 'PAN', index: 'prefix '.length });
  });

  it('assertNoProhibitedData names the label and kind but never the match', () => {
    let message: string | undefined;
    try {
      assertNoProhibitedData('payment log', `card ${PROHIBITED_FIXTURES.pan}`);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('payment log: prohibited data (PAN)');
    expect(message).not.toContain(PROHIBITED_FIXTURES.pan);
  });

  it('assertNoProhibitedData passes clean text', () => {
    expect(() => assertNoProhibitedData('clean', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV')).not.toThrow();
  });
});
