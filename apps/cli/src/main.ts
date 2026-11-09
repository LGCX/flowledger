/**
 * The `flowledger` command surface. Subcommand names and their exit codes are fixed
 * now (CONVENTIONS §4) so later phases fill in behaviour without renaming anything.
 *
 * No CLI framework: `node:util` `parseArgs` covers what this needs, and the contracts
 * favour the standard library over a dependency.
 */

import { credentialsCommand } from './commands/credentials.js';
import { migrateCommand } from './commands/migrate.js';
import { seedCommand } from './commands/seed.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE: readonly string[] = [
  'usage: flowledger <command> [options]',
  '',
  'commands:',
  '  migrate   apply pending database migrations',
  '  seed      load seed data for the given profile',
  '  credentials  issue or revoke a merchant API credential',
  '  verify    run the ledger invariant checker',
];

/** Exit code for "not implemented yet": the command is real, the behaviour is not. */
const NOT_IMPLEMENTED = 2;
/** Exit code for an unrecognised command (BSD `sysexits.h` EX_USAGE). */
const UNKNOWN_COMMAND = 64;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    for (const line of USAGE) io.out(line);
    return 0;
  }

  switch (command) {
    case 'migrate':
      return migrateCommand(argv.slice(1), process.env, io.out);
    case 'seed': {
      const result = await seedCommand(argv.slice(1), process.env, io.out);
      return result.exitCode;
    }
    case 'credentials':
      return credentialsCommand(argv.slice(1), process.env, io.out);
    case 'verify':
      io.err('flowledger verify: not implemented until P03');
      return NOT_IMPLEMENTED;
    default:
      io.err(`unknown command: ${command}`);
      return UNKNOWN_COMMAND;
  }
}
