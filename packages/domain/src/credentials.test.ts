/**
 * Merchant API credentials.
 *
 * The golden vector is the anchor: it was computed once with `node:crypto` and is checked in, so a
 * change to the digest input (encoding, ordering, pepper handling) breaks the test rather than silently
 * invalidating every credential already issued.
 *
 * `verifyCredential` returning false is asserted for several distinct causes. They are separate cases
 * because the timing argument only holds if *every* false path does the same work — a shortcut added to
 * one of them is invisible to a test that only checks the boolean.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  type Peppers,
  credentialDigest,
  generateCredential,
  parseCredential,
  parsePeppers,
  verifyCredential,
} from './credentials.js';

const here = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_SOURCE = readFileSync(join(here, 'credentials.ts'), 'utf8');

/** Pepper version 1: the bytes 0x00..0x1f, base64url — synthetic and local-only. */
const PEPPER_V1 = Buffer.from([...Array(32).keys()]);
const PEPPER_V1_SPEC = `1:${PEPPER_V1.toString('base64url')}`;
const PEPPER_V2 = Buffer.alloc(32, 0xab);
const PEPPER_V2_SPEC = `2:${PEPPER_V2.toString('base64url')}`;

/** Checked in: HMAC-SHA-256 over the credential with pepper v1. */
const GOLDEN_CREDENTIAL = 'fl_test_0123456789AB_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GOLDEN_DIGEST_HEX = 'b44c76693fafbe566bd7ad0e4de7b6eba736c0c82e24bb84e080c4b87eb9638e';

const v1 = (): Peppers => parsePeppers(PEPPER_V1_SPEC).peppers;

describe('format', () => {
  it('generates credentials matching the documented pattern across 1000 samples', () => {
    const { peppers, currentVersion } = parsePeppers(PEPPER_V1_SPEC);
    const pattern = /^fl_test_[0-9A-HJKMNP-TV-Z]{12}_[A-Za-z0-9_-]{43}$/;

    for (let index = 0; index < 1_000; index += 1) {
      const credential = generateCredential({ peppers, currentVersion });
      expect(credential.raw).toMatch(pattern);
      expect(credential.raw).toHaveLength(64);
      expect(credential.digest).toHaveLength(32);
      expect(credential.digestVersion).toBe(1);
    }
  });

  it('never puts I, L, O or U in the locator', () => {
    const { peppers, currentVersion } = parsePeppers(PEPPER_V1_SPEC);
    const seen = new Set<string>();

    for (let index = 0; index < 500; index += 1) {
      const credential = generateCredential({ peppers, currentVersion });
      const locator = credential.keyPrefix;
      expect(locator).toHaveLength(12);
      for (const character of locator) {
        expect('ILOU').not.toContain(character);
        seen.add(character);
      }
    }
    // The generator must actually exercise the alphabet, not emit a constant.
    expect(seen.size).toBeGreaterThan(20);
  });

  it('gives every credential a distinct locator', () => {
    const { peppers, currentVersion } = parsePeppers(PEPPER_V1_SPEC);
    const locators = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      locators.add(generateCredential({ peppers, currentVersion }).keyPrefix);
    }
    expect(locators.size).toBe(500);
  });

  it('stores the locator as keyPrefix', () => {
    const { peppers, currentVersion } = parsePeppers(PEPPER_V1_SPEC);
    const credential = generateCredential({ peppers, currentVersion });
    expect(credential.raw).toContain(`fl_test_${credential.keyPrefix}_`);
  });
});

describe('parseCredential', () => {
  it('accepts the golden credential', () => {
    expect(parseCredential(GOLDEN_CREDENTIAL)).toEqual({ keyPrefix: '0123456789AB' });
  });

  it.each([
    ['wrong prefix', 'fl_live_0123456789AB_' + 'A'.repeat(43)],
    ['11-char locator', 'fl_test_0123456789A_' + 'A'.repeat(43)],
    ['13-char locator', 'fl_test_0123456789ABC_' + 'A'.repeat(43)],
    ['42-char secret', 'fl_test_0123456789AB_' + 'A'.repeat(42)],
    ['44-char secret', 'fl_test_0123456789AB_' + 'A'.repeat(44)],
    ['lowercase locator', 'fl_test_0123456789ab_' + 'A'.repeat(43)],
    ['locator contains I', 'fl_test_0123456789AI_' + 'A'.repeat(43)],
    ['missing separator', 'fl_test0123456789AB_' + 'A'.repeat(43)],
    ['empty', ''],
    ['extra suffix', GOLDEN_CREDENTIAL + 'A'],
  ])('rejects %s', (_label, raw) => {
    expect(parseCredential(raw)).toBeNull();
  });
});

describe('digest', () => {
  it('matches the checked-in golden vector', () => {
    expect(credentialDigest(GOLDEN_CREDENTIAL, PEPPER_V1).toString('hex')).toBe(GOLDEN_DIGEST_HEX);
  });

  it('is stable for the same input and pepper', () => {
    expect(
      credentialDigest(GOLDEN_CREDENTIAL, PEPPER_V1).equals(
        credentialDigest(GOLDEN_CREDENTIAL, PEPPER_V1),
      ),
    ).toBe(true);
  });

  it('changes when the pepper changes', () => {
    expect(
      credentialDigest(GOLDEN_CREDENTIAL, PEPPER_V1).equals(
        credentialDigest(GOLDEN_CREDENTIAL, PEPPER_V2),
      ),
    ).toBe(false);
  });

  it('is an HMAC over the whole credential, not just the secret', () => {
    // Changing only the locator must change the digest; otherwise a credential could be re-labelled.
    const other = GOLDEN_CREDENTIAL.replace('0123456789AB', '0123456789AC');
    expect(
      credentialDigest(other, PEPPER_V1).equals(credentialDigest(GOLDEN_CREDENTIAL, PEPPER_V1)),
    ).toBe(false);
  });
});

describe('verifyCredential', () => {
  const { peppers, currentVersion } = parsePeppers(PEPPER_V1_SPEC);
  const credential = generateCredential({ peppers, currentVersion });

  it('accepts the credential it was generated from', () => {
    expect(
      verifyCredential(
        credential.raw,
        { digest: credential.digest, digestVersion: credential.digestVersion },
        peppers,
      ),
    ).toBe(true);
  });

  it('rejects one flipped secret character', () => {
    const flipped = credential.raw.slice(0, -1) + (credential.raw.endsWith('A') ? 'B' : 'A');
    expect(
      verifyCredential(
        flipped,
        { digest: credential.digest, digestVersion: credential.digestVersion },
        peppers,
      ),
    ).toBe(false);
  });

  it('rejects a wrong pepper version', () => {
    const { peppers: both } = parsePeppers(`${PEPPER_V1_SPEC},${PEPPER_V2_SPEC}`);
    // Same digest, but labelled as v2 while it was made with v1.
    expect(
      verifyCredential(credential.raw, { digest: credential.digest, digestVersion: 2 }, both),
    ).toBe(false);
  });

  it('rejects an unknown digest version', () => {
    expect(
      verifyCredential(credential.raw, { digest: credential.digest, digestVersion: 99 }, peppers),
    ).toBe(false);
  });

  it('rejects a null stored record', () => {
    expect(verifyCredential(credential.raw, null, peppers)).toBe(false);
  });

  it('rejects a digest that is not 32 bytes', () => {
    expect(
      verifyCredential(credential.raw, { digest: Buffer.alloc(31, 1), digestVersion: 1 }, peppers),
    ).toBe(false);
    expect(
      verifyCredential(credential.raw, { digest: Buffer.alloc(33, 1), digestVersion: 1 }, peppers),
    ).toBe(false);
  });

  it('uses timingSafeEqual rather than === on digests', () => {
    // A behavioural timing assertion would be flaky, so this reads the source: a constant-time compare
    // must be present, and no digest may be compared with === or compared as text.
    expect(CREDENTIALS_SOURCE).toContain('timingSafeEqual(');
    expect(CREDENTIALS_SOURCE).not.toMatch(/digest\s*===/);
    expect(CREDENTIALS_SOURCE).not.toMatch(/\.toString\('hex'\)\s*===/);
  });
});

describe('pepper rotation', () => {
  it('verifies an old credential after a new pepper is added, and issues new ones at the new version', () => {
    const first = parsePeppers(PEPPER_V1_SPEC);
    const old = generateCredential(first);
    expect(old.digestVersion).toBe(1);

    const rotated = parsePeppers(`${PEPPER_V1_SPEC},${PEPPER_V2_SPEC}`);
    expect(rotated.currentVersion).toBe(2);

    // The old credential still verifies against its own version.
    expect(
      verifyCredential(
        old.raw,
        { digest: old.digest, digestVersion: old.digestVersion },
        rotated.peppers,
      ),
    ).toBe(true);

    // New credentials use the highest version.
    const fresh = generateCredential(rotated);
    expect(fresh.digestVersion).toBe(2);
    expect(
      verifyCredential(
        fresh.raw,
        { digest: fresh.digest, digestVersion: fresh.digestVersion },
        rotated.peppers,
      ),
    ).toBe(true);

    // And the old credential does not verify under the new pepper alone.
    expect(
      verifyCredential(old.raw, { digest: old.digest, digestVersion: 1 }, rotated.peppers),
    ).toBe(true);
    const onlyV2 = parsePeppers(PEPPER_V2_SPEC);
    expect(
      verifyCredential(old.raw, { digest: old.digest, digestVersion: 1 }, onlyV2.peppers),
    ).toBe(false);
  });

  it('picks the highest version as current regardless of order in the spec', () => {
    expect(parsePeppers(`${PEPPER_V2_SPEC},${PEPPER_V1_SPEC}`).currentVersion).toBe(2);
  });
});

describe('parsePeppers', () => {
  it('accepts a single pepper', () => {
    const parsed = parsePeppers(PEPPER_V1_SPEC);
    expect(parsed.currentVersion).toBe(1);
    expect(parsed.peppers.get(1)?.equals(PEPPER_V1)).toBe(true);
  });

  it.each([
    ['version 0', `0:${PEPPER_V1.toString('base64url')}`],
    ['negative version', `-1:${PEPPER_V1.toString('base64url')}`],
    ['non-numeric version', `one:${PEPPER_V1.toString('base64url')}`],
    ['short pepper', `1:${Buffer.alloc(31, 1).toString('base64url')}`],
    ['no separator', 'not-a-spec'],
    ['empty spec', ''],
    ['non-base64url pepper', '1:not base64!'],
  ])('rejects %s', (_label, spec) => {
    expect(() => parsePeppers(spec)).toThrow('API_CREDENTIAL_PEPPERS invalid');
  });

  it('rejects duplicate versions', () => {
    expect(() => parsePeppers(`${PEPPER_V1_SPEC},${PEPPER_V1_SPEC}`)).toThrow(
      'API_CREDENTIAL_PEPPERS invalid',
    );
  });

  it('never echoes a pepper value in the error', () => {
    const secret = Buffer.alloc(31, 0x7f).toString('base64url');
    try {
      parsePeppers(`1:${secret}`);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('API_CREDENTIAL_PEPPERS invalid');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('127');
    }
  });
});

describe('generation requires the current pepper', () => {
  it('throws when currentVersion has no pepper', () => {
    const peppers = v1();
    expect(() => generateCredential({ peppers, currentVersion: 7 })).toThrow(
      'API_CREDENTIAL_PEPPERS has no pepper for the current version',
    );
  });
});
