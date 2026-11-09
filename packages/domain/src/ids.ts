/**
 * Branded entity identifiers (docs/07 §IDs, CONVENTIONS §6).
 *
 * Two problems are solved here at once. A branded alias makes the compiler reject a `PaymentId`
 * where an `OperationId` is expected, which is the class of defect that silently corrupts a join
 * and is invisible in review. And one strict parser per prefix rejects a malformed or
 * wrong-prefix identifier at the boundary, so no later layer has to ask whether its ID is real.
 *
 * The pattern is `^<prefix>_[0-7][0-9A-HJKMNP-TV-Z]{25}$`: Crockford base32, case-sensitive, with
 * `I`, `L`, `O`, and `U` excluded. The leading `0`–`7` is the overflow bound that
 * `schemas/common/entity-ids.v1.schema.json` enforces — a ULID starting at `8` or above cannot be
 * represented and is rejected rather than truncated.
 *
 * `newId` takes an optional millisecond timestamp for deterministic tests only. Production callers
 * omit it; an ID must not depend on a caller's clock.
 */
import { ulid } from 'ulid';
import { DomainError, type Result, err, ok } from './errors.js';

/**
 * Every entity prefix, union of `schemas/common/entity-ids.v1.schema.json` and the docs/07 primary
 * key checks, plus `req_` for request identifiers (docs/05 §Request and correlation identifiers).
 * P01-GATE re-derives this list from the generated schemas, so a prefix added to the contract
 * without being added here fails there.
 */
export const ID_PREFIXES = {
  merchant: 'mer',
  merchantCredential: 'mcr',
  providerAccount: 'pacc',
  providerAccountCredential: 'pac',
  providerWebhookEndpoint: 'pwe',
  feePolicy: 'fee',
  payment: 'pay',
  operation: 'op',
  providerAttempt: 'pat',
  providerNotification: 'pno',
  providerEvidence: 'pev',
  ledger: 'led',
  ledgerAccount: 'lac',
  ledgerTransaction: 'ltx',
  correctionRequest: 'lcr',
  settlementRun: 'srn',
  settlementBatch: 'sbt',
  webhookEndpoint: 'whe',
  webhookDelivery: 'whd',
  reviewCase: 'case',
  request: 'req',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/**
 * An identifier carrying its prefix in the type. The brand is a phantom property: it exists only
 * in the type system, so `EntityId<'pay'>` and `EntityId<'op'>` are not assignable to each other
 * while both are ordinary strings at runtime.
 */
export type EntityId<P extends IdPrefix> = string & { readonly __idPrefix: P };

export type MerchantId = EntityId<'mer'>;
export type MerchantCredentialId = EntityId<'mcr'>;
export type ProviderAccountId = EntityId<'pacc'>;
export type ProviderAccountCredentialId = EntityId<'pac'>;
export type ProviderWebhookEndpointId = EntityId<'pwe'>;
export type FeePolicyId = EntityId<'fee'>;
export type PaymentId = EntityId<'pay'>;
export type OperationId = EntityId<'op'>;
export type ProviderAttemptId = EntityId<'pat'>;
export type ProviderNotificationId = EntityId<'pno'>;
export type ProviderEvidenceId = EntityId<'pev'>;
export type LedgerId = EntityId<'led'>;
export type LedgerAccountId = EntityId<'lac'>;
export type LedgerTransactionId = EntityId<'ltx'>;
export type CorrectionRequestId = EntityId<'lcr'>;
export type SettlementRunId = EntityId<'srn'>;
export type SettlementBatchId = EntityId<'sbt'>;
export type WebhookEndpointId = EntityId<'whe'>;
export type WebhookDeliveryId = EntityId<'whd'>;
export type ReviewCaseId = EntityId<'case'>;
export type RequestId = EntityId<'req'>;

/** Crockford base32, 26 characters, leading `0`–`7`. Built per prefix so the prefix is part of it. */
function patternFor(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`);
}

const PATTERNS = new Map<IdPrefix, RegExp>(
  Object.values(ID_PREFIXES).map((prefix) => [prefix, patternFor(prefix)]),
);

export function isId<P extends IdPrefix>(prefix: P, input: unknown): input is EntityId<P> {
  if (typeof input !== 'string') return false;
  const pattern = PATTERNS.get(prefix);
  if (pattern === undefined) return false;
  return pattern.test(input);
}

/**
 * Parses an identifier of the expected prefix. A wrong prefix, a malformed body, and a
 * non-string are all `ID_MALFORMED`: from the domain's point of view the value is not an
 * identifier of that kind, and the caller supplied it.
 */
export function parseId<P extends IdPrefix>(prefix: P, input: unknown): Result<EntityId<P>> {
  if (!isId(prefix, input)) {
    return err<EntityId<P>>(new DomainError('INVALID_REQUEST', 'ID_MALFORMED', { prefix }));
  }
  return ok(input as EntityId<P>);
}

/**
 * Generates an identifier. `nowMs` exists for deterministic tests only; a production call omits it
 * so the value comes from the clock at the point of creation rather than from a caller's copy.
 */
export function newId<P extends IdPrefix>(prefix: P, nowMs?: number): EntityId<P> {
  const body = nowMs === undefined ? ulid() : ulid(nowMs);
  return `${prefix}_${body}` as EntityId<P>;
}
