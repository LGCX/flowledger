/**
 * Merchant API credentials (docs/05 §Authentication, docs/07 §identity.merchant_api_credentials).
 *
 * The credential string is `fl_test_<locator>_<secret>`. The locator is *not* a secret — it is the
 * lookup key, and it is what a log, a support ticket, or a rate-limit table may carry. The secret is
 * only ever compared as a digest, so a database dump does not yield usable credentials.
 *
 * The digest is peppered, and the pepper never enters PostgreSQL: the HMAC happens here, in the
 * application, so a database compromise alone cannot verify guesses offline without the pepper too.
 *
 * `digestVersion` records which pepper produced a stored digest. Rotation therefore only needs the new
 * pepper added to the spec: old credentials keep verifying against their own version until they are
 * reissued, and new ones use the highest version.
 *
 * Errors never contain a credential or a pepper value. These strings are the one secret an API caller
 * hands us, and a thrown error is the likeliest place for it to reach a log.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Peppers = ReadonlyMap<number, Buffer>;

/** 60 random bits as 12 Crockford base32 characters. */
const LOCATOR_LENGTH = 12;
const LOCATOR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43; // unpadded base64url of 32 bytes
const CREDENTIAL_PATTERN = new RegExp(
  `^fl_test_([${LOCATOR_ALPHABET}]{${String(LOCATOR_LENGTH)}})_([A-Za-z0-9_-]{${String(SECRET_LENGTH)}})$`,
);

export interface ParsedCredential {
  readonly keyPrefix: string;
}

export interface GeneratedCredential {
  readonly raw: string;
  readonly keyPrefix: string;
  readonly digest: Buffer;
  readonly digestVersion: number;
}

function base32(bitCount: number): string {
  // Read exactly the bits needed; 60 bits fit in 8 bytes with 4 bits left over.
  const bytes = randomBytes(Math.ceil(bitCount / 8));
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < Math.floor(bitCount / 5)) {
      output += LOCATOR_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

export function credentialDigest(raw: string, pepper: Buffer): Buffer {
  return createHmac('sha256', pepper).update(raw, 'ascii').digest();
}

/** Returns the locator for a syntactically valid credential, or null. Never throws on bad input. */
export function parseCredential(raw: string): ParsedCredential | null {
  const match = CREDENTIAL_PATTERN.exec(raw);
  if (match === null) return null;
  const locator = match[1];
  if (locator === undefined) return null;
  return { keyPrefix: locator };
}

export function generateCredential(peppers: {
  peppers: Peppers;
  currentVersion: number;
}): GeneratedCredential {
  const pepper = peppers.peppers.get(peppers.currentVersion);
  if (pepper === undefined) {
    throw new Error('API_CREDENTIAL_PEPPERS has no pepper for the current version');
  }

  const raw = `fl_test_${base32(60)}_${randomBytes(SECRET_BYTES).toString('base64url')}`;
  const parsed = parseCredential(raw);
  if (parsed === null) {
    // Only reachable if the generator and the parser disagree, which would otherwise surface much
    // later as every authentication failing.
    throw new Error('generated credential does not match the documented format');
  }

  return {
    raw,
    keyPrefix: parsed.keyPrefix,
    digest: credentialDigest(raw, pepper),
    digestVersion: peppers.currentVersion,
  };
}

/**
 * Verifies a presented credential against a stored digest.
 *
 * Every path that returns false still computes one HMAC, so an unknown locator and a wrong secret cost
 * the same. Without that, response time alone tells an attacker which locators exist.
 */
export function verifyCredential(
  raw: string,
  stored: { digest: Buffer; digestVersion: number } | null,
  peppers: Peppers,
): boolean {
  const current = peppers.size === 0 ? undefined : [...peppers.keys()].sort((a, b) => b - a)[0];
  const fallbackPepper = current === undefined ? undefined : peppers.get(current);

  if (stored === null) {
    if (fallbackPepper !== undefined) credentialDigest(raw, fallbackPepper);
    return false;
  }

  if (stored.digest.length !== 32) {
    if (fallbackPepper !== undefined) credentialDigest(raw, fallbackPepper);
    return false;
  }

  const pepper = peppers.get(stored.digestVersion);
  if (pepper === undefined) {
    // The pepper was retired. The credential cannot be verified and must be reissued.
    if (fallbackPepper !== undefined) credentialDigest(raw, fallbackPepper);
    return false;
  }

  return timingSafeEqual(credentialDigest(raw, pepper), stored.digest);
}

export function parsePeppers(spec: string): { peppers: Peppers; currentVersion: number } {
  const peppers = new Map<number, Buffer>();
  let currentVersion = 0;

  for (const entry of spec.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) throw new Error('API_CREDENTIAL_PEPPERS invalid');

    const versionText = trimmed.slice(0, separator);
    const encoded = trimmed.slice(separator + 1);
    if (!/^[1-9][0-9]*$/.test(versionText)) throw new Error('API_CREDENTIAL_PEPPERS invalid');

    const version = Number.parseInt(versionText, 10);
    if (peppers.has(version)) throw new Error('API_CREDENTIAL_PEPPERS invalid');

    let decoded: Buffer;
    try {
      decoded = Buffer.from(encoded, 'base64url');
    } catch {
      throw new Error('API_CREDENTIAL_PEPPERS invalid');
    }
    // base64url decoding is lenient; re-encoding must round-trip or the input was not base64url.
    if (decoded.toString('base64url') !== encoded)
      throw new Error('API_CREDENTIAL_PEPPERS invalid');
    if (decoded.length < 32) throw new Error('API_CREDENTIAL_PEPPERS invalid');

    peppers.set(version, decoded);
    if (version > currentVersion) currentVersion = version;
  }

  if (peppers.size === 0) throw new Error('API_CREDENTIAL_PEPPERS invalid');
  return { peppers, currentVersion };
}
