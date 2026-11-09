import type { BaseConfig, Env } from '@flowledger/config';
import { ConfigError, parseBaseConfig, readFlag, readPort } from '@flowledger/config';

export interface SimulatorConfig extends BaseConfig {
  readonly port: number;
  readonly testEndpoints: boolean;
}

/**
 * `SIMULATOR_TEST_ENDPOINTS` exposes ground-truth control routes (`POST /__test/clock`),
 * so it must never be on in production — that would publish a way to rewrite provider
 * outcomes on a deployed simulator.
 *
 * `PROVIDER_SIMULATOR_DATABASE_URL` is deliberately not read yet: the simulator owns no
 * database until P06.
 */
export function parseSimulatorConfig(env: Env): SimulatorConfig {
  const base = parseBaseConfig(env);
  const port = readPort(env, 'SIMULATOR_PORT');
  const testEndpoints = readFlag(env, 'SIMULATOR_TEST_ENDPOINTS', false);

  if (testEndpoints && base.nodeEnv === 'production') {
    throw new ConfigError('SIMULATOR_TEST_ENDPOINTS', 'must be 0 when NODE_ENV=production');
  }

  return Object.freeze({ ...base, port, testEndpoints });
}
