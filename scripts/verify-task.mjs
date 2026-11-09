#!/usr/bin/env node
/**
 * Task gate: refuse to commit a task from the base branch, and refuse to commit at all unless
 * the required checks pass (CONVENTIONS §13: "Every commit leaves `pnpm check` green",
 * "Branch per task").
 *
 * Both guards exist because both were violated by hand. A task was twice committed straight
 * to `main` and only noticed when the merge reported nothing to merge, and a commit once
 * landed with `pnpm check` failing. Neither is detectable by review after the fact, so the
 * check belongs in the path of the commit rather than in a checklist.
 *
 * Usage:
 *   node scripts/verify-task.mjs            # default: branch guard + check + build
 *   node scripts/verify-task.mjs --full     # adds integration + e2e (needs Docker)
 *
 * The default is what `.git/hooks/pre-commit` runs. `--full` is the pre-merge verification
 * reported in PROGRESS.md, and what CI (P00-T14) runs: integration and e2e need the Docker
 * stack, and a hook that requires Docker would block commits whenever it is not running.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const BASE_BRANCHES = ['main', 'master'];
const full = process.argv.includes('--full');

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function fail(message) {
  process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(1);
}

function run(label, command, args) {
  process.stdout.write(`  ${label} … `);
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.status === 0) {
    process.stdout.write('ok\n');
    return;
  }
  process.stdout.write('FAILED\n');
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  process.stderr.write(`\n${output.split('\n').slice(-40).join('\n')}\n\n`);
  fail(`${label} failed; the commit was not created.`);
}

// 1. Branch guard. A fast-forward merge into the base branch creates no commit, so this does
//    not obstruct merging — it only stops a task being authored on top of it.
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (BASE_BRANCHES.includes(branch)) {
  fail(
    `refusing to commit on "${branch}". A task needs its own branch ` +
      `(CONVENTIONS §13 "Branch per task"). Create one with:\n` +
      `      git switch -c task/<task-id-lowercase>-<slug>`,
  );
}

process.stdout.write(`\n  task gate on branch "${branch}"${full ? ' (full)' : ''}\n`);

// 2. Required checks.
run('pnpm check', 'pnpm', ['check']);
run('pnpm build', 'pnpm', ['build']);

if (full) {
  run('pnpm test:integration', 'pnpm', ['test:integration']);
  run('pnpm test:e2e', 'pnpm', ['test:e2e']);
}

process.stdout.write('\n  all gates green\n\n');
