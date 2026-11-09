/**
 * Reproducible property testing (docs/09: "Use a reproducible random seed. A failing generated
 * case MUST print and persist the minimal counterexample").
 *
 * Two things make a failure actionable months later. The seed is fixed by default, so a failure
 * reproduces on a clean machine without the original run's environment. And the counterexample is
 * appended to `reports/property-failures.jsonl` — which CI already uploads (P00-T14) — rather than
 * only printed, because a printed counterexample scrolls out of a collapsed log group while an
 * artifact survives.
 *
 * `fc.stringify` is used instead of `JSON.stringify` because counterexamples routinely contain
 * `bigint`, which `JSON.stringify` throws on.
 */
import fc from 'fast-check';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { expect } from 'vitest';

/** Default from the plan's vector date; overridable so a CI re-run can explore other seeds. */
const DEFAULT_SEED = '20261108';
const DEFAULT_NUM_RUNS = '200';

/** `reports/` is gitignored and created on demand; CI uploads it as an artifact. */
const FAILURE_LOG = join(process.cwd(), 'reports', 'property-failures.jsonl');

fc.configureGlobal({
  seed: Number(process.env.FC_SEED ?? DEFAULT_SEED),
  numRuns: Number(process.env.FC_NUM_RUNS ?? DEFAULT_NUM_RUNS),
  reporter(details) {
    if (!details.failed) return;

    const entry = {
      test: expect.getState().currentTestName ?? 'unknown',
      seed: details.seed,
      // fast-check names this `counterexamplePath` (e.g. `0:0`); the JSON line uses `path` so a
      // reader does not need to know the library's field name.
      path: details.counterexamplePath,
      counterexample: fc.stringify(details.counterexample),
    };

    try {
      mkdirSync(dirname(FAILURE_LOG), { recursive: true });
      appendFileSync(FAILURE_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // A read-only checkout must not turn a property failure into a different failure; the
      // thrown error below still carries the seed and the counterexample.
    }

    throw new Error(fc.defaultReportMessage(details));
  },
});
