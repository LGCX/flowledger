/**
 * SQLSTATE → domain error mapping (unit).
 *
 * The detail payload is parsed, not stringified: callers need `detail.available`, not
 * `'{"available":"5"}'`. A malformed detail is treated as empty rather than as a failure, because a
 * broken DETAIL must not turn a domain error into an unhandled exception at the boundary.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES, DomainError, mapPgError } from './errors.js';

function pgError(code: string, message: string, detail?: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, 0, 'error');
  Object.assign(error, { code, detail });
  return error;
}

describe('mapPgError', () => {
  it('maps a known P0001 code and parses its detail', () => {
    const mapped = mapPgError(pgError('P0001', 'MONETARY_GUARD_FAILED', '{"available":"5"}'));

    expect(mapped).toBeInstanceOf(DomainError);
    const domainError = mapped as DomainError;
    expect(domainError.code).toBe('MONETARY_GUARD_FAILED');
    expect(domainError.detail).toEqual({ available: '5' });
  });

  it('treats a missing detail as an empty object', () => {
    const mapped = mapPgError(pgError('P0001', 'INVALID_PAYMENT_STATE'));
    expect((mapped as DomainError).detail).toEqual({});
  });

  it('treats malformed detail JSON as an empty object', () => {
    const mapped = mapPgError(pgError('P0001', 'INVALID_PAYMENT_STATE', 'not json'));
    expect((mapped as DomainError).detail).toEqual({});
  });

  it('returns an unknown P0001 message unchanged', () => {
    const original = pgError('P0001', 'SOMETHING_NOT_IN_THE_LIST', '{}');
    expect(mapPgError(original)).toBe(original);
  });

  it.each(['23505', '23514', '40001', '40P01', '42P01'])('returns a %s error unchanged', (code) => {
    const original = pgError(code, 'some message', '{}');
    expect(mapPgError(original)).toBe(original);
  });

  it('returns a non-Error value unchanged', () => {
    const value = { code: 'P0001', message: 'MONETARY_GUARD_FAILED' };
    expect(mapPgError(value)).toBe(value);
  });

  it('lists every mappable code once', () => {
    expect(new Set(DOMAIN_ERROR_CODES).size).toBe(DOMAIN_ERROR_CODES.length);
  });
});
