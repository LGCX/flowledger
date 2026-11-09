/**
 * Retry classification, backoff, and observation normalization.
 *
 * Two things are deliberately asserted as *tables* rather than spot checks: the observation mapping
 * (16 rows) and the message-failure mapping (6 rows). Both are closed vocabularies transcribed from a
 * contract table, and a spot check would let a transcription slip through.
 *
 * The post-send invariant gets its own test enumerating every post-send observation, because it is the
 * rule that prevents a double capture and it must hold for observations that do not exist yet: adding
 * a post-send observation to the union fails that test until it is classified as UNKNOWN.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY_AFTER_MS,
  MESSAGE_RETRY_SCHEDULE_MS,
  type MessageFailureAction,
  type MessageFailureClass,
  POST_SEND_OBSERVATIONS,
  RECONCILIATION_REASONS,
  RECONCILIATION_SCHEDULE_MS,
  type ReconciliationReason,
  type TransportObservation,
  backoff,
  boundRetryHint,
  classifyMessageFailure,
  classifyObservation,
} from './retry.js';

describe('schedules', () => {
  it('message schedule is exact', () => {
    expect(MESSAGE_RETRY_SCHEDULE_MS).toEqual([
      1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000,
    ]);
  });

  it('reconciliation schedule is exact', () => {
    expect(RECONCILIATION_SCHEDULE_MS).toEqual([5_000, 30_000, 120_000, 600_000, 3_600_000]);
  });

  it('schedules are non-decreasing and end at one hour or below', () => {
    for (const schedule of [MESSAGE_RETRY_SCHEDULE_MS, RECONCILIATION_SCHEDULE_MS]) {
      schedule.forEach((value, index) => {
        if (index > 0) expect(value).toBeGreaterThanOrEqual(schedule[index - 1] ?? 0);
      });
      expect(Math.max(...schedule)).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
    }
  });
});

describe('backoff', () => {
  it('applies the documented values for the first step', () => {
    expect(backoff(MESSAGE_RETRY_SCHEDULE_MS, 1, () => 0)).toEqual({ kind: 'RETRY', delayMs: 800 });
    expect(backoff(MESSAGE_RETRY_SCHEDULE_MS, 1, () => 0.999999)).toEqual({
      kind: 'RETRY',
      delayMs: 1_199,
    });
  });

  it('applies the documented value at the last step', () => {
    expect(backoff(MESSAGE_RETRY_SCHEDULE_MS, 7, () => 0.5)).toEqual({
      kind: 'RETRY',
      delayMs: 3_600_000,
    });
    expect(backoff(RECONCILIATION_SCHEDULE_MS, 5, () => 0.5)).toEqual({
      kind: 'RETRY',
      delayMs: 3_600_000,
    });
  });

  it('exhausts one past the end of each schedule', () => {
    expect(backoff(MESSAGE_RETRY_SCHEDULE_MS, 8, () => 0.5)).toEqual({ kind: 'EXHAUSTED' });
    expect(backoff(RECONCILIATION_SCHEDULE_MS, 6, () => 0.5)).toEqual({ kind: 'EXHAUSTED' });
  });

  it('rejects a non-positive or fractional failuresSoFar', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => backoff(MESSAGE_RETRY_SCHEDULE_MS, bad, () => 0.5)).toThrow(RangeError);
    }
  });

  it('stays within [0.8·base, 1.2·base) for every step and many samples', () => {
    for (const schedule of [MESSAGE_RETRY_SCHEDULE_MS, RECONCILIATION_SCHEDULE_MS]) {
      for (let step = 1; step <= schedule.length; step += 1) {
        const base = schedule[step - 1] ?? 0;
        for (let sample = 0; sample <= 100; sample += 1) {
          const r = sample / 101;
          const decision = backoff(schedule, step, () => r);
          expect(decision.kind).toBe('RETRY');
          if (decision.kind !== 'RETRY') continue;
          expect(decision.delayMs).toBeGreaterThanOrEqual(Math.floor(0.8 * base));
          expect(decision.delayMs).toBeLessThan(1.2 * base);
        }
      }
    }
  });

  it('uses the injected random, never global entropy', () => {
    let calls = 0;
    backoff(MESSAGE_RETRY_SCHEDULE_MS, 1, () => {
      calls += 1;
      return 0.5;
    });
    expect(calls).toBe(1);
  });
});

describe('boundRetryHint', () => {
  it('bounds a large hint', () => {
    expect(boundRetryHint(7_200_000, 1_000, MAX_RETRY_AFTER_MS)).toBe(3_600_000);
  });

  it('falls back when the hint is missing', () => {
    expect(boundRetryHint(null, 1_000, MAX_RETRY_AFTER_MS)).toBe(1_000);
  });

  it('falls back when the hint is negative', () => {
    expect(boundRetryHint(-1, 1_000, MAX_RETRY_AFTER_MS)).toBe(1_000);
  });

  it('honours a hint below the maximum unchanged', () => {
    expect(boundRetryHint(2_500, 1_000, MAX_RETRY_AFTER_MS)).toBe(2_500);
  });

  it('treats a zero hint as a real hint, not a missing one', () => {
    expect(boundRetryHint(0, 1_000, MAX_RETRY_AFTER_MS)).toBe(0);
  });
});

describe('message failure classification', () => {
  it.each<[MessageFailureClass, MessageFailureAction]>([
    ['TRANSIENT_INFRASTRUCTURE', 'RETRY_WITH_BACKOFF'],
    ['HANDLER_RATE_LIMITED', 'RETRY_AFTER_HINT'],
    ['SCHEMA_INVALID', 'DLQ_AND_ALERT'],
    ['UNSUPPORTED_VERSION', 'DLQ_AND_ALERT'],
    ['INVARIANT_VIOLATION', 'DLQ_DISCREPANCY_AND_REVIEW'],
    ['DUPLICATE_DELIVERY', 'ACK_AFTER_DEDUPE'],
  ])('%s -> %s', (failureClass, action) => {
    expect(classifyMessageFailure(failureClass)).toBe(action);
  });

  it('never retries a schema or version problem', () => {
    for (const failureClass of ['SCHEMA_INVALID', 'UNSUPPORTED_VERSION'] as const) {
      expect(classifyMessageFailure(failureClass)).not.toMatch(/^RETRY/);
    }
  });
});

describe('observation normalization', () => {
  it.each<[TransportObservation, string, ReconciliationReason | null]>([
    ['CONFIRMED_MATCHING_SUCCESS', 'SUCCEEDED', null],
    ['BUSINESS_DECLINE', 'REJECTED', null],
    ['LOCAL_VALIDATION_FAILED', 'FAILED', null],
    ['AUTHENTICATED_NO_EFFECT_REJECTION', 'FAILED', null],
    ['PRE_SEND_FAILURE_RETRYABLE', 'RETRYABLE_NO_EFFECT', null],
    ['PRE_SEND_FAILURE_FINAL', 'FAILED', null],
    ['RATE_LIMITED_NOT_EXECUTED', 'RETRYABLE_NO_EFFECT', null],
    ['TIMEOUT_AFTER_SEND', 'UNKNOWN', 'TIMEOUT_AFTER_SEND'],
    ['CONNECTION_LOST_AFTER_SEND', 'UNKNOWN', 'CONNECTION_LOST_AFTER_SEND'],
    ['PROVIDER_5XX', 'UNKNOWN', 'PROVIDER_5XX_AMBIGUOUS'],
    ['SDK_EXCEPTION_AFTER_SEND', 'UNKNOWN', 'SDK_EXCEPTION_AFTER_SEND'],
    ['MALFORMED_SUCCESS', 'UNKNOWN', 'MALFORMED_PROVIDER_RESPONSE'],
    ['MISSING_CORRELATION', 'UNKNOWN', 'MISSING_PROVIDER_CORRELATION'],
    ['WORKER_CRASH_AFTER_SEND', 'UNKNOWN', 'WORKER_CRASH_AFTER_SEND'],
    ['STALE_PROCESSING', 'UNKNOWN', 'STALE_PROCESSING'],
    ['ADAPTER_DEFECT', 'UNKNOWN', 'ADAPTER_DEFECT'],
  ])('%s -> %s with reason %s', (observation, outcome, reason) => {
    const classification = classifyObservation(observation);
    expect(classification.outcome).toBe(outcome);
    expect(classification.reconciliationReason).toBe(reason);
  });

  it('no post-send observation ever maps to FAILED or RETRYABLE_NO_EFFECT', () => {
    for (const observation of POST_SEND_OBSERVATIONS) {
      const { outcome, reconciliationReason } = classifyObservation(observation);
      expect(outcome, observation).toBe('UNKNOWN');
      expect(reconciliationReason, observation).not.toBeNull();
    }
  });

  it('every reconciliation reason is reachable from exactly one observation', () => {
    const reached = new Map<ReconciliationReason, TransportObservation[]>();
    const observations: readonly TransportObservation[] = [
      'CONFIRMED_MATCHING_SUCCESS',
      'BUSINESS_DECLINE',
      'LOCAL_VALIDATION_FAILED',
      'AUTHENTICATED_NO_EFFECT_REJECTION',
      'PRE_SEND_FAILURE_RETRYABLE',
      'PRE_SEND_FAILURE_FINAL',
      'RATE_LIMITED_NOT_EXECUTED',
      ...POST_SEND_OBSERVATIONS,
    ];

    for (const observation of observations) {
      const reason = classifyObservation(observation).reconciliationReason;
      if (reason === null) continue;
      reached.set(reason, [...(reached.get(reason) ?? []), observation]);
    }

    expect([...reached.keys()].sort()).toEqual([...RECONCILIATION_REASONS].sort());
    for (const [reason, list] of reached) expect(list, reason).toHaveLength(1);
  });

  it('every observation has a classification', () => {
    const observations: readonly TransportObservation[] = [
      'CONFIRMED_MATCHING_SUCCESS',
      'BUSINESS_DECLINE',
      'LOCAL_VALIDATION_FAILED',
      'AUTHENTICATED_NO_EFFECT_REJECTION',
      'PRE_SEND_FAILURE_RETRYABLE',
      'PRE_SEND_FAILURE_FINAL',
      'RATE_LIMITED_NOT_EXECUTED',
      ...POST_SEND_OBSERVATIONS,
    ];
    expect(observations).toHaveLength(16);
    for (const observation of observations) {
      expect(classifyObservation(observation).outcome).toBeTruthy();
    }
  });
});

describe('reconciliation vocabulary', () => {
  it('has the nine contract reasons in order', () => {
    expect(RECONCILIATION_REASONS).toEqual([
      'TIMEOUT_AFTER_SEND',
      'CONNECTION_LOST_AFTER_SEND',
      'PROVIDER_5XX_AMBIGUOUS',
      'SDK_EXCEPTION_AFTER_SEND',
      'MALFORMED_PROVIDER_RESPONSE',
      'MISSING_PROVIDER_CORRELATION',
      'WORKER_CRASH_AFTER_SEND',
      'STALE_PROCESSING',
      'ADAPTER_DEFECT',
    ]);
  });
});
