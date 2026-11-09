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

  it('migrate returns 2 and names P02', async () => {
    const test = capture();
    expect(await runCli(['migrate'], test.io)).toBe(2);
    expect(test.err).toEqual(['flowledger migrate: not implemented until P02']);
    expect(test.out).toEqual([]);
  });

  it('seed returns 2 and names P02', async () => {
    const test = capture();
    expect(await runCli(['seed'], test.io)).toBe(2);
    expect(test.err).toEqual(['flowledger seed: not implemented until P02']);
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
