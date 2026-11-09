/**
 * The merchant fixture every later database test uses.
 *
 * It writes directly as the table owner rather than through a protected function. That is deliberate and
 * allowed by docs/10 §Financial safety: this is a *fixture* that sets up a tenant before any business
 * flow exists, not application code reaching around a guard. Everything a business flow needs — a
 * credential, a provider account, a route, a fee policy — is created in its valid form so a test that
 * fails does so for its own reason rather than for missing setup.
 *
 * The fee policy defaults (290 bp, 30 fixed, minimum 50) match the dev seed and the P07 fixture, so the
 * same policy shape is exercised everywhere. 50 is deliberately *not* the floor: 31 is the smallest
 * minimum this shape can declare, and 50 is what operators actually use.
 */
import { createHash, randomBytes } from 'node:crypto';

import type pg from 'pg';

import { newId, parsePeppers, generateCredential } from '@flowledger/domain';

/**
 * One synthetic pepper, version 1: 32 bytes of a fixed pattern so a failing case reproduces. This is a
 * local-only value; a real deployment supplies `API_CREDENTIAL_PEPPERS` from its secret store.
 */
export const TEST_PEPPERS = `1:${Buffer.alloc(32, 0x2a).toString('base64url')}`;

export interface TestMerchantOptions {
  readonly basisPoints?: number;
  readonly fixedAmountMinor?: bigint;
  readonly minimumCaptureAmountMinor?: bigint;
  readonly scopes?: readonly string[];
}

export interface TestMerchant {
  readonly merchantId: string;
  readonly credentialId: string;
  readonly rawCredential: string;
  readonly keyPrefix: string;
  readonly providerAccountId: string;
  readonly providerCode: 'fake-provider';
  readonly environment: 'SIMULATOR';
  readonly providerAccountVersion: 1;
  readonly feePolicyId: string;
  readonly feePolicyVersion: 1;
  /** The fee policy's inputs, so operation fixtures can snapshot exactly what the policy row says. */
  readonly feeBasisPoints: number;
  readonly feeFixedAmountMinor: bigint;
  readonly routeProviderCode: 'fake-provider';
}

/** Capability hash for the fake provider: a stable digest of its declared capability set name. */
function capabilitiesHash(providerCode: string): Buffer {
  return createHash('sha256').update(providerCode, 'utf8').digest();
}

export async function createTestMerchant(
  ownerPool: pg.Pool,
  options: TestMerchantOptions = {},
): Promise<TestMerchant> {
  const merchantId = newId('mer');
  const credentialId = newId('mcr');
  const providerAccountId = newId('pacc');
  const providerCredentialId = newId('pac');
  const feePolicyId = newId('fee');

  const { peppers, currentVersion } = parsePeppers(TEST_PEPPERS);
  // A generated locator is 12 Crockford characters; a collision would need 60 bits of bad luck, and a
  // retry here would hide a generator bug rather than fix one.
  const credential = generateCredential({ peppers, currentVersion });

  const basisPoints = options.basisPoints ?? 290;
  const fixedAmountMinor = options.fixedAmountMinor ?? 30n;
  const minimumCaptureAmountMinor = options.minimumCaptureAmountMinor ?? 50n;
  const scopes = options.scopes ?? ['payments:read', 'payments:write'];

  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO identity.merchants (id, display_name, status, default_currency)
       VALUES ($1, $2, 'ACTIVE', 'USD')`,
      [merchantId, `Test merchant ${merchantId.slice(-4)}`],
    );

    await client.query(
      `INSERT INTO identity.merchant_api_credentials
         (id, merchant_id, key_prefix, credential_digest, digest_version, scopes)
       VALUES ($1, $2, $3, $4, $5, $6::text[])`,
      [
        credentialId,
        merchantId,
        credential.keyPrefix,
        credential.digest,
        credential.digestVersion,
        [...scopes],
      ],
    );

    await client.query(
      `INSERT INTO providers.provider_accounts
         (id, merchant_id, provider_code, external_account_reference, environment, status)
       VALUES ($1, $2, 'fake-provider', $3, 'SIMULATOR', 'ACTIVE')`,
      [providerAccountId, merchantId, `acct_${providerAccountId.slice(-8)}`],
    );

    await client.query(
      `INSERT INTO providers.provider_account_versions
         (provider_account_id, version, configuration, capabilities_hash)
       VALUES ($1, 1, '{}'::jsonb, $2)`,
      [providerAccountId, capabilitiesHash('fake-provider')],
    );

    await client.query(
      `INSERT INTO providers.provider_account_credentials
         (id, merchant_id, provider_account_id, version, secret_reference, status)
       VALUES ($1, $2, $3, 1, 'local-secret://test', 'ACTIVE')`,
      [providerCredentialId, merchantId, providerAccountId],
    );

    await client.query(
      `INSERT INTO providers.merchant_routes
         (merchant_id, provider_code, environment, provider_account_id, is_default, status)
       VALUES ($1, 'fake-provider', 'SIMULATOR', $2, true, 'ACTIVE')`,
      [merchantId, providerAccountId],
    );

    await client.query(
      `INSERT INTO payments.fee_policies
         (id, merchant_id, version, basis_points, fixed_amount_minor, minimum_capture_amount_minor)
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [feePolicyId, merchantId, basisPoints, fixedAmountMinor, minimumCaptureAmountMinor],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    merchantId,
    credentialId,
    rawCredential: credential.raw,
    keyPrefix: credential.keyPrefix,
    providerAccountId,
    providerCode: 'fake-provider',
    environment: 'SIMULATOR',
    providerAccountVersion: 1,
    feePolicyId,
    feePolicyVersion: 1,
    feeBasisPoints: basisPoints,
    feeFixedAmountMinor: fixedAmountMinor,
    routeProviderCode: 'fake-provider',
  };
}

/** A random hex string for values that must merely be unique, such as an external account reference. */
export function uniqueSuffix(): string {
  return randomBytes(6).toString('hex');
}
