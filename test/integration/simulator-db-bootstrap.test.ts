import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POSTGRES_IMAGE, startPostgres, type StartedPostgres } from '@flowledger/testkit';

const repoRoot = new URL('../../', import.meta.url);

const SIMULATOR_PASSWORD = 'fl_simulator_local_only';
const TRUTH_PASSWORD = 'fl_simulator_truth_local_only';

let postgres: StartedPostgres;
let admin: Client;
let simulator: Client;

beforeAll(async () => {
  postgres = await startPostgres();

  admin = new Client({ connectionString: postgres.uri });
  await admin.connect();

  simulator = new Client({
    connectionString: postgres.uriFor('flowledger_sim', 'fl_simulator', SIMULATOR_PASSWORD),
  });
  await simulator.connect();
  await simulator.query('CREATE TABLE IF NOT EXISTS t (x int)');
}, 120_000);

afterAll(async () => {
  await simulator?.end();
  await admin?.end();
  await postgres?.stop();
});

describe('simulator database bootstrap', () => {
  it('server is PostgreSQL 17', async () => {
    const { rows } = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
    const version = Number(rows[0]?.server_version_num);
    expect(version).toBeGreaterThanOrEqual(170_000);
    expect(version).toBeLessThan(180_000);
  });

  it('flowledger_sim exists owned by fl_simulator', async () => {
    const { rows } = await admin.query<{ owner: string }>(
      `SELECT r.rolname AS owner
         FROM pg_database d
         JOIN pg_roles r ON r.oid = d.datdba
        WHERE d.datname = 'flowledger_sim'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner).toBe('fl_simulator');
  });

  it('fl_simulator can create and write a table', async () => {
    await simulator.query('INSERT INTO t (x) VALUES ($1)', [1]);
    const { rows } = await simulator.query<{ count: string }>('SELECT count(*) FROM t');
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('fl_simulator_truth can read new tables via default privileges', async () => {
    const truth = new Client({
      connectionString: postgres.uriFor('flowledger_sim', 'fl_simulator_truth', TRUTH_PASSWORD),
    });
    await truth.connect();
    try {
      const { rows } = await truth.query<{ x: number }>('SELECT x FROM t ORDER BY x');
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await truth.end();
    }
  });

  it('fl_simulator_truth cannot insert (25006 or 42501)', async () => {
    const truth = new Client({
      connectionString: postgres.uriFor('flowledger_sim', 'fl_simulator_truth', TRUTH_PASSWORD),
    });
    await truth.connect();
    try {
      await expect(truth.query('INSERT INTO t (x) VALUES ($1)', [2])).rejects.toMatchObject({
        code: expect.stringMatching(/^(25006|42501)$/),
      });
    } finally {
      await truth.end();
    }
  });

  it('PUBLIC has no CONNECT on flowledger_sim', async () => {
    // A fresh login role stands in for "any anonymous role": it inherits only PUBLIC.
    await admin.query('DROP ROLE IF EXISTS probe_public');
    // Utility statements cannot take bind parameters; the password is a fixed literal.
    await admin.query("CREATE ROLE probe_public LOGIN PASSWORD 'probe_only'");
    try {
      const { rows } = await admin.query<{ can_connect: boolean }>(
        `SELECT has_database_privilege('probe_public', 'flowledger_sim', 'CONNECT') AS can_connect`,
      );
      expect(rows[0]?.can_connect).toBe(false);
    } finally {
      await admin.query('DROP ROLE IF EXISTS probe_public');
    }
  });

  it('testkit image constant equals compose image', () => {
    const compose = readFileSync(
      fileURLToPath(new URL('infra/docker/compose.yaml', repoRoot)),
      'utf8',
    );
    const images = [...compose.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    expect(images).toContain(POSTGRES_IMAGE);
    expect(images.filter((image) => image?.startsWith('postgres:'))).toEqual([POSTGRES_IMAGE]);
  });
});
