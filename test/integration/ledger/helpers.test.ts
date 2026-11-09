/**
 * The three ledger primitives every later object depends on.
 *
 * The bucket table's N=7 column is the important part. An implementation that reads only the last
 * character of the ULID is correct at N=32 and wrong everywhere else, so a powers-of-two-only test would
 * pass while the striping was broken. N=7 and N=100 exist to make that implementation fail.
 *
 * `jcs` is tested against a TypeScript reference as well as against literals: the SQL and the TypeScript
 * canonical serializer must agree, or a posting hash computed in one place would not match the same
 * posting hashed in the other.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { canonicalJson } from '@flowledger/domain';
import {
  setTestConnection,
  useTestDatabase,
  withRole,
  disposeTestDatabase,
  type TestDatabase,
} from '@flowledger/testkit';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_REGEX = /^pay_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

beforeAll(() => {
  setTestConnection(inject('flowledgerPg'));
});

let database: TestDatabase;
beforeAll(async () => {
  database = await useTestDatabase()();
});

afterAll(async () => {
  if (database !== undefined) await disposeTestDatabase(database);
});

async function bucketOn(client: pg.ClientBase, paymentId: string, count: number): Promise<number> {
  const { rows } = await client.query<{ bucket: number }>(
    'SELECT ledger.bucket_for_payment($1, $2) AS bucket',
    [paymentId, count],
  );
  return rows[0]?.bucket as number;
}

/** Runs `sql` and returns the raw SQLSTATE plus the parsed `DETAIL`, or null when it succeeded. */
async function failure(
  client: pg.ClientBase,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ code?: string; rule?: string } | null> {
  try {
    await client.query(sql, [...values]);
    return null;
  } catch (error) {
    const raw = error as { code?: string; detail?: string };
    let rule: string | undefined;
    if (typeof raw.detail === 'string') {
      try {
        rule = (JSON.parse(raw.detail) as { rule?: string }).rule;
      } catch {
        rule = undefined;
      }
    }
    return {
      ...(raw.code === undefined ? {} : { code: raw.code }),
      ...(rule === undefined ? {} : { rule }),
    };
  }
}

/** A small deterministic generator, so a failure is reproducible from the seed above. */
function xorshift(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** The reference decoder: ULID chars 11-26 as a big-endian base-32 integer, modulo the count. */
function referenceBucket(paymentId: string, count: number): number {
  let value = 0n;
  for (const character of paymentId.slice(14, 30)) {
    value = value * 32n + BigInt(ALPHABET.indexOf(character));
  }
  return Number(value % BigInt(count));
}

describe('golden vectors', () => {
  it.each<[string, number, number, number]>([
    ['pay_01ARZ3NDEKTSV4RRFFQ69G5FAV', 27, 1, 0],
    ['pay_00000000000000000000000000', 0, 0, 0],
    ['pay_7ZZZZZZZZZZZZZZZZZZZZZZZZZ', 31, 3, 0],
    ['pay_01J9Z8Y7X6W5V4T3S2R1Q0P9N8', 8, 0, 0],
    ['pay_01HZX4K2M3N5P6Q7R8S9T0V1W2', 2, 4, 0],
    ['pay_0000000000ZZZZZZZZZZZZZZZZ', 31, 3, 0],
    ['pay_01JC0000000000000000000001', 1, 1, 0],
    ['pay_01JC000000000000000000000Z', 31, 3, 0],
  ])('%s → %i / %i / %i at N=32/7/1', async (paymentId, at32, at7, at1) => {
    const client = await database.ownerPool.connect();
    try {
      expect(await bucketOn(client, paymentId, 32)).toBe(at32);
      expect(await bucketOn(client, paymentId, 7)).toBe(at7);
      expect(await bucketOn(client, paymentId, 1)).toBe(at1);
    } finally {
      client.release();
    }
  });
});

describe('bucket stability', () => {
  it('computes the same bucket from two separate sessions', async () => {
    const ids: string[] = [];
    const client = await database.ownerPool.connect();
    try {
      for (let index = 0; index < 200; index += 1) {
        const { rows } = await client.query<{ id: string }>(
          "SELECT ledger.generate_id('pay') AS id",
        );
        ids.push(rows[0]?.id as string);
      }
      expect(ids.every((id) => ID_REGEX.test(id))).toBe(true);
    } finally {
      client.release();
    }

    const first = await database.ownerPool.connect();
    const second = await database.ownerPool.connect();
    try {
      for (const id of ids) {
        for (const count of [7, 32]) {
          expect(await bucketOn(first, id, count)).toBe(await bucketOn(second, id, count));
        }
      }
    } finally {
      first.release();
      second.release();
    }
  });

  it('agrees with an independent BigInt decoder over 500 generated IDs', async () => {
    // `fast-check` is a dependency of `packages/domain` and `packages/testkit`, not of the root, so the
    // integration project cannot import it and this task may not add dependencies. A seeded xorshift
    // gives the same coverage here: 500 independent IDs drawn from the full 130-bit space, compared
    // against a decoder written separately from the SQL.
    const next = xorshift(20260101);
    const client = await database.ownerPool.connect();
    try {
      for (let index = 0; index < 500; index += 1) {
        // The first ULID character is bounded by 0..7 — exactly the 130-bit space a ULID body occupies.
        const characters = [String(next() % 8)];
        for (let position = 1; position < 26; position += 1) characters.push(String(next() % 32));
        const paymentId = `pay_${characters.map((value) => ALPHABET[Number(value)]).join('')}`;
        expect(ID_REGEX.test(paymentId)).toBe(true);

        for (const count of [1, 7, 32, 100]) {
          expect(await bucketOn(client, paymentId, count), `${paymentId} N=${String(count)}`).toBe(
            referenceBucket(paymentId, count),
          );
        }
      }
    } finally {
      client.release();
    }
  }, 120_000);
});

describe('bucket derivation is immutable and validates its input', () => {
  it('is declared IMMUTABLE', async () => {
    const { rows } = await database.ownerPool.query<{ provolatile: string; prosecdef: boolean }>(
      `SELECT p.provolatile, p.prosecdef
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'ledger' AND p.proname = 'bucket_for_payment'`,
    );
    // `STABLE` would be legal SQL and would let a payment's postings change bucket between runs.
    expect(rows[0]?.provolatile).toBe('i');
    // Deriving a bucket needs no privilege escalation.
    expect(rows[0]?.prosecdef).toBe(false);
  });

  it.each<[string, string, string]>([
    ['a non-pay prefix', 'lac_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'INVALID_PAYMENT_ID'],
    ['a lowercase body', 'pay_01arz3ndektsv4rrffq69g5fav', 'INVALID_PAYMENT_ID'],
    ['a first character above 7', 'pay_8ARZ3NDEKTSV4RRFFQ69G5FAV0', 'INVALID_PAYMENT_ID'],
    ['a body one character short', 'pay_01ARZ3NDEKTSV4RRFFQ69G5FA', 'INVALID_PAYMENT_ID'],
  ])('rejects %s with INVALID_PAYMENT_ID', async (_label, paymentId, rule) => {
    const client = await database.ownerPool.connect();
    try {
      const result = await failure(client, 'SELECT ledger.bucket_for_payment($1, 32)', [paymentId]);
      expect(result).toMatchObject({ code: 'P0001', rule });
    } finally {
      client.release();
    }
  });

  it.each<[number]>([[0], [101], [-1]])(
    'rejects bucket count %i with INVALID_BUCKET_COUNT',
    async (count) => {
      const client = await database.ownerPool.connect();
      try {
        const result = await failure(client, 'SELECT ledger.bucket_for_payment($1, $2)', [
          'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          count,
        ]);
        expect(result).toMatchObject({ code: 'P0001', rule: 'INVALID_BUCKET_COUNT' });
      } finally {
        client.release();
      }
    },
  );
});

describe('id generator', () => {
  it('returns 1000 distinct IDs matching the CONVENTIONS §6 regex', async () => {
    const { rows } = await database.ownerPool.query<{ id: string }>(
      `SELECT ledger.generate_id('lac') AS id FROM generate_series(1, 1000)`,
    );
    const ids = rows.map((row) => row.id);
    expect(ids).toHaveLength(1000);
    expect(ids.every((id) => /^lac_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id))).toBe(true);
    // Distinctness is the point: a frozen timestamp or a non-random body would collide here.
    expect(new Set(ids).size).toBe(1000);
  });

  it('rejects a prefix outside the documented shape', async () => {
    const client = await database.ownerPool.connect();
    try {
      for (const prefix of ['Lac', 'l', '', 'lac-x', 'a'.repeat(17)]) {
        const result = await failure(client, 'SELECT ledger.generate_id($1)', [prefix]);
        expect(result, `prefix ${prefix}`).toMatchObject({
          code: 'P0001',
          rule: 'INVALID_ID_PREFIX',
        });
      }
    } finally {
      client.release();
    }
  });
});

describe('jcs serializer', () => {
  async function jcs(value: string): Promise<string> {
    const { rows } = await database.ownerPool.query<{ out: string }>(
      'SELECT ledger.jcs($1::jsonb) AS out',
      [value],
    );
    return rows[0]?.out as string;
  }

  it.each<[string, string, string]>([
    ['sorted keys', '{"b":1,"a":[true,null,"x\\n"]}', '{"a":[true,null,"x\\n"],"b":1}'],
    ['C order, uppercase first', '{"a":1,"B":2}', '{"B":2,"a":1}'],
    [
      'nested arrays and objects',
      '{"z":[{"y":2,"x":1},[]],"a":{}}',
      '{"a":{},"z":[{"x":1,"y":2},[]]}',
    ],
    ['empty object', '{}', '{}'],
    ['empty array', '[]', '[]'],
    ['no insignificant whitespace', '{ "a" : 1 , "b" : 2 }', '{"a":1,"b":2}'],
    ['control character escape', '{"a":"\\u0001"}', '{"a":"\\u0001"}'],
    ['quote and backslash escape', '{"a":"x\\"y\\\\z"}', '{"a":"x\\"y\\\\z"}'],
    ['negative integer', '{"a":-7}', '{"a":-7}'],
    ['zero', '{"a":0}', '{"a":0}'],
    ['largest safe integer', '{"a":9007199254740991}', '{"a":9007199254740991}'],
    ['booleans and null at the root', 'true', 'true'],
    ['string at the root', '"x"', '"x"'],
  ])('%s', async (_label, input, expected) => {
    expect(await jcs(input)).toBe(expected);
  });

  it("normalises '1e3' to 1000, matching the TypeScript canonicaliser", async () => {
    // `jsonb` normalises the exponent at cast time, before `jcs` runs, so there is nothing left to
    // reject. What matters is that both serialisers agree on the result.
    expect(await jcs('1e3')).toBe('1000');
    expect(canonicalJson(JSON.parse('1e3') as never)).toBe('1000');
  });

  it.each<[string, string]>([
    ['a fractional number', '1.5'],
    ['a number with preserved scale', '1.0'],
    ['a number above the safe range', '9007199254740992'],
    ['a nested fractional number', '{"a":[1.5]}'],
  ])('rejects %s with JCS_UNSUPPORTED_NUMBER', async (_label, input) => {
    const client = await database.ownerPool.connect();
    try {
      // `1.0` matters most: jsonb keeps the scale and prints `1.0` where TypeScript prints `1`, so
      // emitting it would make a SQL hash and a TypeScript hash of the same document disagree.
      const result = await failure(client, 'SELECT ledger.jcs($1::jsonb)', [input]);
      expect(result).toMatchObject({ code: 'P0001', rule: 'JCS_UNSUPPORTED_NUMBER' });
    } finally {
      client.release();
    }
  });

  it.each<[string]>([['{"é":1}'], ['{"a":{"ü":2}}']])(
    'rejects a non-ASCII key in %s with JCS_NON_ASCII_KEY',
    async (input) => {
      const client = await database.ownerPool.connect();
      try {
        // C-collation order equals JCS's UTF-16 order only for ASCII, so non-ASCII keys cannot be
        // sorted correctly here and must not be silently accepted.
        const result = await failure(client, 'SELECT ledger.jcs($1::jsonb)', [input]);
        expect(result).toMatchObject({ code: 'P0001', rule: 'JCS_NON_ASCII_KEY' });
      } finally {
        client.release();
      }
    },
  );
});

describe('privileges', () => {
  const SIGNATURES = [
    'ledger.bucket_for_payment(text, integer)',
    'ledger.generate_id(text)',
    'ledger.jcs(jsonb)',
  ];

  it('grants nothing to PUBLIC', async () => {
    for (const signature of SIGNATURES) {
      const { rows } = await database.ownerPool.query<{ granted: boolean }>(
        'SELECT has_function_privilege($1, $2, $3) AS granted',
        ['public', signature, 'EXECUTE'],
      );
      expect(rows[0]?.granted, signature).toBe(false);
    }
  });

  it('refuses fl_api', async () => {
    const client = await database.poolAs('fl_api').connect();
    try {
      for (const call of [
        'SELECT ledger.bucket_for_payment($1, 32)',
        "SELECT ledger.generate_id('lac')",
        "SELECT ledger.jcs('{}'::jsonb)",
      ]) {
        const values = call.includes('$1') ? ['pay_01ARZ3NDEKTSV4RRFFQ69G5FAV'] : [];
        const error = await client.query(call, values).catch((caught: unknown) => caught);
        expect((error as { code?: string }).code, call).toBe('42501');
      }
    } finally {
      client.release();
    }
  });

  it('lets the roles that need the bucket compute it', async () => {
    // A login role connects as itself; a function owner is assumed with SET ROLE, which the migration
    // owner is granted with SET TRUE in 0200 (and is *not* granted for the login roles).
    const login = await database.poolAs('fl_operator_readonly').connect();
    try {
      // A missing `GRANT USAGE ON SCHEMA ledger` would surface here as 42501 rather than a value.
      expect(await bucketOn(login, 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV', 32)).toBe(27);
    } finally {
      login.release();
    }

    for (const role of ['payments_function_owner', 'settlement_function_owner'] as const) {
      const bucket = await withRole(database.ownerPool, role, async (client) =>
        bucketOn(client, 'pay_01ARZ3NDEKTSV4RRFFQ69G5FAV', 32),
      );
      expect(bucket, role).toBe(27);
    }
  });

  it('is owned by ledger_function_owner', async () => {
    for (const signature of SIGNATURES) {
      const { rows } = await database.ownerPool.query<{ owner: string }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p
          WHERE p.oid = $1::regprocedure`,
        [signature],
      );
      expect(rows[0]?.owner, signature).toBe('ledger_function_owner');
    }
  });
});
