import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './main.js';

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
  };
}

const SUBCOMMANDS = ['migrate', 'seed', 'verify'];

describe('runCli', () => {
  it('no args prints usage and returns 0', async () => {
    const test = capture();
    expect(await runCli([], test.io)).toBe(0);
    const text = test.out.join('\n');
    for (const command of SUBCOMMANDS) expect(text).toContain(command);
    expect(test.err).toEqual([]);
  });

  it('--help prints usage and returns 0', async () => {
    const test = capture();
    expect(await runCli(['--help'], test.io)).toBe(0);
    const text = test.out.join('\n');
    for (const command of SUBCOMMANDS) expect(text).toContain(command);
    expect(test.err).toEqual([]);
  });

  it('migrate is implemented and reports missing configuration instead of "not implemented"', async () => {
    // P02-T01 implemented `migrate`; with no MIGRATION_DATABASE_URL it must fail configuration
    // validation and say so, rather than claim the command does not exist.
    const test = capture();
    const previous = process.env.MIGRATION_DATABASE_URL;
    delete process.env.MIGRATION_DATABASE_URL;
    try {
      expect(await runCli(['migrate'], test.io)).toBe(1);
    } finally {
      if (previous !== undefined) process.env.MIGRATION_DATABASE_URL = previous;
    }
    expect(test.out.join('\n')).toContain('MIGRATION_DATABASE_URL');
    expect(test.out.join('\n')).not.toContain('not implemented');
  });

  it('seed requires an explicit dev profile', async () => {
    // Implemented by P02-T15: without `--profile dev` the command refuses rather than guessing.
    const test = capture();
    expect(await runCli(['seed'], test.io)).toBe(1);
    expect(test.out).toContain('seed: only --profile dev is supported');
  });

  it('verify returns 2 and names P03', async () => {
    const test = capture();
    expect(await runCli(['verify'], test.io)).toBe(2);
    expect(test.err).toEqual(['flowledger verify: not implemented until P03']);
  });

  it('unknown command returns 64', async () => {
    const test = capture();
    expect(await runCli(['nope'], test.io)).toBe(64);
    expect(test.err).toEqual(['unknown command: nope']);
    expect(test.out).toEqual([]);
  });
});
