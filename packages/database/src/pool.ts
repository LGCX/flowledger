/**
 * The one pool per process (CONVENTIONS §7).
 *
 * The `int8` parser is installed here, at the single point where a connection is configured, because
 * every monetary total is `bigint` in the domain (CONVENTIONS §5). Registering it per call site instead
 * would make it a matter of which module was imported first.
 */
import pg from 'pg';

// int8 -> bigint. `pg` returns int8 as a string by default to avoid precision loss; the domain wants
// exact integers, so convert once here rather than parsing at every read.
pg.types.setTypeParser(20, (value: string) => BigInt(value));

export interface PoolOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly applicationName: string;
}

export function createPool(options: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
  });
}
