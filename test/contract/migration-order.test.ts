/**
 * Migration naming and ordering, enforced before any migration exists.
 *
 * The value is in doing this early: parallel phases allocate number ranges up front
 * (CONVENTIONS §8 — P02 owns `0200`–`0299`, P08 `0800`–`0899`), and a collision or an
 * out-of-range number is far cheaper to reject now than after two branches have migrated the
 * same database. CONVENTIONS §8 also fixes forward-only, fixed-width names so that lexical
 * order equals apply order; this check keeps that property true rather than assuming it.
 *
 * `checkMigrationNames` is pure and exported so P02 can reuse it from the migration runner's
 * own tests instead of copying the rules.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** `NNNN_<slug>.sql`, lowercase slug segments, exactly four digits. */
const MIGRATION_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const IGNORED = '.gitkeep';

export interface MigrationRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Returns human-readable findings; an empty array means the set is valid.
 *
 * An invalid name produces exactly one finding and is not checked further, so a single typo
 * cannot bury itself under several consequences.
 */
export function checkMigrationNames(names: readonly string[], options: MigrationRange): string[] {
  const findings: string[] = [];
  const seen = new Map<string, string>();

  const candidates = names.filter((name) => name !== IGNORED).sort();

  for (const name of candidates) {
    const match = MIGRATION_NAME.exec(name);
    if (match?.[1] === undefined) {
      findings.push(`${name}: must match NNNN_<lowercase_slug>.sql`);
      continue;
    }

    const number = Number(match[1]);

    const previous = seen.get(match[1]);
    if (previous !== undefined) {
      findings.push(`${name}: duplicate number ${match[1]} (also ${previous})`);
    } else {
      seen.set(match[1], name);
    }

    if (number < options.min || number > options.max) {
      findings.push(
        `${name}: number ${match[1]} outside the allowed range ${options.min}..${options.max}`,
      );
    }
  }

  // Fixed-width names make lexical order equal numeric order; assert it rather than assume it,
  // because a future change to the pattern could silently lose the property.
  const numbers = candidates.map((name) => Number(name.slice(0, 4)));
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1];
    const current = numbers[index];
    if (previous !== undefined && current !== undefined && current < previous) {
      findings.push(
        `${candidates[index]}: lexical order is not numeric order (after ${candidates[index - 1]})`,
      );
    }
  }

  return findings;
}

/** Directory entries, or `undefined` when the directory does not exist yet. */
function entries(directory: string): string[] | undefined {
  const absolute = join(repoRoot, directory);
  let names: string[];
  try {
    names = readdirSync(absolute);
  } catch {
    return undefined;
  }
  return names.filter((name) => statSync(join(absolute, name)).isFile());
}

const MIGRATIONS: MigrationRange = { min: 200, max: 1399 };
const SIMULATOR_MIGRATIONS: MigrationRange = { min: 1, max: 9999 };

describe('migration naming and ordering', () => {
  it('the real migrations directory is clean', () => {
    const names = entries(join('migrations'));
    expect(names, 'migrations/ must exist (created by this task)').toBeDefined();
    expect(checkMigrationNames(names ?? [], MIGRATIONS)).toEqual([]);
  });

  it('the simulator migrations directory is clean or absent', () => {
    const names = entries(join('apps', 'provider-simulator', 'migrations'));
    // P06 creates it; until then absence is the expected state.
    expect(checkMigrationNames(names ?? [], SIMULATOR_MIGRATIONS)).toEqual([]);
  });

  it('accepts a valid sequence', () => {
    expect(checkMigrationNames(['0200_roles.sql', '0210_identity.sql'], MIGRATIONS)).toEqual([]);
  });

  it('rejects a three-digit number', () => {
    expect(checkMigrationNames(['200_roles.sql'], MIGRATIONS)).toEqual([
      '200_roles.sql: must match NNNN_<lowercase_slug>.sql',
    ]);
  });

  it('rejects an uppercase slug', () => {
    expect(checkMigrationNames(['0200_Roles.sql'], MIGRATIONS)).toEqual([
      '0200_Roles.sql: must match NNNN_<lowercase_slug>.sql',
    ]);
  });

  it('rejects the wrong extension', () => {
    expect(checkMigrationNames(['0200_a.SQL'], MIGRATIONS)).toEqual([
      '0200_a.SQL: must match NNNN_<lowercase_slug>.sql',
    ]);
  });

  it('rejects a duplicate number', () => {
    expect(checkMigrationNames(['0200_a.sql', '0200_b.sql'], MIGRATIONS)).toEqual([
      '0200_b.sql: duplicate number 0200 (also 0200_a.sql)',
    ]);
  });

  it('rejects a number below the range', () => {
    expect(checkMigrationNames(['0100_x.sql'], MIGRATIONS)).toEqual([
      '0100_x.sql: number 0100 outside the allowed range 200..1399',
    ]);
  });

  it('rejects a number above the range', () => {
    expect(checkMigrationNames(['1400_x.sql'], MIGRATIONS)).toEqual([
      '1400_x.sql: number 1400 outside the allowed range 200..1399',
    ]);
  });

  it('ignores .gitkeep', () => {
    expect(checkMigrationNames(['.gitkeep'], MIGRATIONS)).toEqual([]);
    expect(checkMigrationNames(['.gitkeep', '0200_roles.sql'], MIGRATIONS)).toEqual([]);
  });

  it('reports a name problem once, not once per downstream consequence', () => {
    // A three-digit number is out of range too, but the name finding is the actionable one.
    expect(checkMigrationNames(['100_x.sql'], MIGRATIONS)).toHaveLength(1);
  });
});
