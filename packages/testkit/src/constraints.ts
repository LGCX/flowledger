/**
 * Constraint coverage.
 *
 * Every table task names its constraints and indexes explicitly and calls this helper, so a constraint
 * that exists in the database but not in the task's list — and therefore not in its tests — fails
 * instead of quietly shipping. The usual failure this catches is a forgotten unique index: the schema
 * looks right, nothing tests it, and a duplicate slips through.
 *
 * Unique indexes that do not back a constraint are included, because `CREATE UNIQUE INDEX` is how a
 * partial or expression uniqueness rule is expressed and it is just as load-bearing.
 */
import pg from 'pg';

export async function assertConstraintCoverage(
  pool: pg.Pool,
  table: string,
  covered: readonly string[],
): Promise<void> {
  const { rows } = await pool.query<{ name: string; kind: string }>(
    `
    SELECT conname AS name,
           CASE contype
             WHEN 'c' THEN 'check'
             WHEN 'f' THEN 'foreign key'
             WHEN 'u' THEN 'unique'
             WHEN 'x' THEN 'exclusion'
             WHEN 'p' THEN 'primary key'
           END AS kind
      FROM pg_constraint
     WHERE conrelid = $1::regclass
       -- 'p' included: a primary key is a constraint a task must name like any other.
       AND contype IN ('c', 'f', 'u', 'x', 'p')
    UNION
    -- relname, not regclass::text: the latter schema-qualifies the name for any schema other than
    -- public, so a declared merchant_routes_one_default would look absent.
    SELECT i.relname AS name, 'unique index' AS kind
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
     WHERE x.indrelid = $1::regclass
       AND x.indisunique
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid
       )
    `,
    [table],
  );

  const declared = new Set(covered);
  const undeclared = rows.filter((row) => !declared.has(row.name));
  const missing = covered.filter((name) => !rows.some((row) => row.name === name));

  if (undeclared.length > 0 || missing.length > 0) {
    throw new Error(
      [
        `constraint coverage for ${table}:`,
        undeclared.length === 0
          ? ''
          : `  present but not declared: ${undeclared
              .map((row) => `${row.name} (${String(row.kind)})`)
              .join(', ')}`,
        missing.length === 0 ? '' : `  declared but absent: ${missing.join(', ')}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    );
  }
}
