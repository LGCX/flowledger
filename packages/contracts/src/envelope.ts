/**
 * The one way a producer builds an envelope (CONVENTIONS §9).
 *
 * It adds nothing the caller did not pass: no generated `id` and no clock read. A producer
 * that relies on the builder to invent an envelope ID or a timestamp cannot be tested
 * deterministically, and an ID minted here would be a second source of deduplication
 * identity alongside the one the caller already chose. Absent fields therefore fail
 * validation rather than being filled in.
 *
 * The returned envelope is a frozen copy, so a later mutation by the caller cannot change
 * what was validated or what another consumer observes.
 */
import type { FlowLedgerInternalMessageEnvelopeV1 } from './generated/messages.js';
import { validateMessage, type RegisteredEnvelope, type ValidationIssue } from './validate.js';

/**
 * The generated envelope shape with `id` optional (the builder never invents one) and
 * `traceparent` optional (absent outside a traced call).
 */
export type EnvelopeInput = Omit<FlowLedgerInternalMessageEnvelopeV1, 'id' | 'traceparent'> & {
  readonly id?: string;
  readonly traceparent?: string;
};

export type EnvelopeFailure = 'SCHEMA' | 'SEMANTIC';

export class EnvelopeValidationError extends Error {
  readonly failure: EnvelopeFailure;
  readonly issues: readonly ValidationIssue[];

  constructor(failure: EnvelopeFailure, issues: readonly ValidationIssue[]) {
    const detail = issues
      .map((issue) => `${issue.rule}@${issue.path === '' ? '/' : issue.path}: ${issue.message}`)
      .join('; ');
    super(`${failure}: ${detail === '' ? 'envelope rejected' : detail}`);
    this.name = 'EnvelopeValidationError';
    this.failure = failure;
    this.issues = issues;
  }
}

export function buildEnvelope(input: EnvelopeInput): RegisteredEnvelope {
  const candidate: Record<string, unknown> = { ...input };
  // An explicit `undefined` would be a present-but-invalid property; drop it instead.
  if (candidate.traceparent === undefined) delete candidate.traceparent;

  const result = validateMessage(candidate);
  if (!result.ok) {
    // An unregistered type is a schema-level failure for a producer: it built a message the
    // registry does not contain, which is a programming error, not a routing decision.
    const failure: EnvelopeFailure = result.failure === 'SEMANTIC' ? 'SEMANTIC' : 'SCHEMA';
    throw new EnvelopeValidationError(failure, result.issues);
  }

  return Object.freeze({ ...result.message }) as RegisteredEnvelope;
}
