/**
 * Payment fixtures (owner role).
 *
 * Named `fixture*` on purpose: these write as the table owner, which is what makes them a *fixture*
 * rather than application code reaching around a guard (docs/10 §Financial safety). Real mutations go
 * through the protected functions; a test that needs a row in an arbitrary state gets it here.
 */
import { createHash } from 'node:crypto';

import type pg from 'pg';

import { newId } from '@flowledger/domain';

import type { TestMerchant } from './merchant.js';

export interface FixturePaymentOptions {
  readonly id?: string;
  readonly requestedAmountMinor?: bigint;
  readonly merchantReference?: string | null;
}

export async function fixtureInsertPayment(
  client: pg.ClientBase,
  merchant: TestMerchant,
  options: FixturePaymentOptions = {},
): Promise<string> {
  const id = options.id ?? newId('pay');

  await client.query(
    `INSERT INTO payments.payments
       (id, merchant_id, merchant_reference, payment_method_reference_ciphertext,
        payment_method_key_version, payment_method_reference_hash, provider_account_id,
        provider_account_version, fee_policy_id, fee_policy_version, requested_amount_minor,
        created_by_credential_id)
     VALUES ($1, $2, $3, $4, 'test-k1', $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      merchant.merchantId,
      options.merchantReference ?? null,
      Buffer.from([0x01]),
      createHash('sha256').update(id, 'utf8').digest(),
      merchant.providerAccountId,
      merchant.providerAccountVersion,
      merchant.feePolicyId,
      merchant.feePolicyVersion,
      (options.requestedAmountMinor ?? 10_000n).toString(),
      merchant.credentialId,
    ],
  );

  return id;
}

/**
 * Updates a payment as the owner, incrementing `version` for the caller.
 *
 * The guard requires `version = old + 1`, so every fixture update has to do this; centralising it here
 * keeps the tests about the column under test rather than about version bookkeeping.
 */
export async function fixtureUpdatePayment(
  client: pg.ClientBase,
  paymentId: string,
  set: Readonly<Record<string, unknown>>,
): Promise<void> {
  const columns = Object.keys(set);
  const assignments = columns.map((column, index) => `${column} = $${String(index + 1)}`);
  assignments.push('version = version + 1');

  await client.query(
    `UPDATE payments.payments SET ${assignments.join(', ')} WHERE id = $${String(columns.length + 1)}`,
    [...columns.map((column) => set[column]), paymentId],
  );
}
