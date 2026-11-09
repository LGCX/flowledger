/**
 * Identity repository: merchants and API credentials.
 *
 * Every function takes a client the caller already opened inside `withTransaction`. They do not open
 * their own transactions, because authentication needs the credential lookup, the merchant read, and the
 * `last_used_at` update (P04) to be one unit — and a repository that committed on its own would make
 * that impossible.
 *
 * `lookupCredential` sets `app.credential_key_prefix` before reading. That is what the RLS policy
 * consults to expose exactly one row before tenant context exists. It then sets `app.merchant_id` from
 * the row it found, so the rest of the transaction runs in tenant scope.
 */
import type pg from 'pg';

export type MerchantStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type CredentialStatus = 'ACTIVE' | 'REVOKED';

export interface CredentialRow {
  readonly id: string;
  readonly merchantId: string;
  readonly keyPrefix: string;
  readonly credentialDigest: Buffer;
  readonly digestVersion: number;
  readonly scopes: string[];
  readonly status: CredentialStatus;
  readonly expiresAt: Date | null;
  readonly merchantStatus: MerchantStatus;
}

interface CredentialRowShape {
  id: string;
  merchant_id: string;
  key_prefix: string;
  credential_digest: Buffer;
  digest_version: number;
  scopes: string[];
  status: CredentialStatus;
  expires_at: Date | null;
}

/**
 * Finds the ACTIVE, unexpired credential for a locator and the owning merchant's status.
 *
 * Returns null for expired and revoked credentials rather than returning them with a flag: a caller
 * that has to remember to check is a caller that will forget, and the contract says authentication
 * rejects them.
 */
export async function lookupCredential(
  client: pg.ClientBase,
  keyPrefix: string,
): Promise<CredentialRow | null> {
  await client.query("SELECT set_config('app.credential_key_prefix', $1, true)", [keyPrefix]);

  // Two steps, not a join: the merchant policy requires `app.merchant_id`, which is only known after
  // the credential row is found. A join here would return nothing and look like a missing credential.
  const { rows } = await client.query<CredentialRowShape>(
    `SELECT id, merchant_id, key_prefix, credential_digest, digest_version,
            scopes, status, expires_at
       FROM identity.merchant_api_credentials
      WHERE key_prefix = $1
        AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
      LIMIT 1`,
    [keyPrefix],
  );

  const row = rows[0];
  if (row === undefined) return null;

  // The transaction is now in tenant scope for everything that follows.
  await client.query("SELECT set_config('app.merchant_id', $1, true)", [row.merchant_id]);

  const merchant = await client.query<{ status: MerchantStatus }>(
    'SELECT status FROM identity.merchants WHERE id = $1',
    [row.merchant_id],
  );

  return {
    id: row.id,
    merchantId: row.merchant_id,
    keyPrefix: row.key_prefix,
    credentialDigest: row.credential_digest,
    digestVersion: row.digest_version,
    scopes: row.scopes,
    status: row.status,
    expiresAt: row.expires_at,
    merchantStatus: merchant.rows[0]?.status ?? 'CLOSED',
  };
}

export interface IssueCredentialInput {
  readonly id: string;
  readonly merchantId: string;
  readonly keyPrefix: string;
  readonly digest: Buffer;
  readonly digestVersion: number;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
}

/** Issues a credential. The row starts ACTIVE with no revocation; the guard enforces that. */
export async function issueCredential(
  client: pg.ClientBase,
  input: IssueCredentialInput,
): Promise<void> {
  await client.query(
    `INSERT INTO identity.merchant_api_credentials
       (id, merchant_id, key_prefix, credential_digest, digest_version, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7)`,
    [
      input.id,
      input.merchantId,
      input.keyPrefix,
      input.digest,
      input.digestVersion,
      [...input.scopes],
      input.expiresAt,
    ],
  );
}

/** Revokes a credential. Returns false when it was already revoked (or never existed). */
export async function revokeCredential(client: pg.ClientBase, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE identity.merchant_api_credentials
        SET status = 'REVOKED', revoked_at = clock_timestamp()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export interface MerchantRow {
  readonly id: string;
  readonly displayName: string;
  readonly status: MerchantStatus;
  readonly defaultCurrency: string;
}

export async function findMerchant(
  client: pg.ClientBase,
  merchantId: string,
): Promise<MerchantRow | null> {
  const { rows } = await client.query<{
    id: string;
    display_name: string;
    status: MerchantStatus;
    default_currency: string;
  }>(
    `SELECT id, display_name, status, default_currency
       FROM identity.merchants WHERE id = $1`,
    [merchantId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    defaultCurrency: row.default_currency,
  };
}
