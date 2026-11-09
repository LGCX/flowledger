import { ConfigError } from '@flowledger/config';
import { describe, expect, it } from 'vitest';
import { parseSimulatorConfig } from './config.js';

describe('parseSimulatorConfig', () => {
  it('defaults', () => {
    const config = parseSimulatorConfig({ NODE_ENV: 'test', SIMULATOR_PORT: '3100' });
    expect(config).toEqual({
      nodeEnv: 'test',
      shutdownGraceMs: 10_000,
      port: 3100,
      testEndpoints: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("flag '1' in test accepted", () => {
    const config = parseSimulatorConfig({
      NODE_ENV: 'test',
      SIMULATOR_PORT: '0',
      SIMULATOR_TEST_ENDPOINTS: '1',
    });
    expect(config.testEndpoints).toBe(true);
    expect(config.port).toBe(0);
  });

  it("flag '1' in production rejected naming the variable", () => {
    try {
      parseSimulatorConfig({
        NODE_ENV: 'production',
        SIMULATOR_PORT: '3100',
        SIMULATOR_TEST_ENDPOINTS: '1',
      });
      expect.unreachable('parseSimulatorConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variable).toBe('SIMULATOR_TEST_ENDPOINTS');
      expect((error as ConfigError).message).toBe(
        'SIMULATOR_TEST_ENDPOINTS: must be 0 when NODE_ENV=production',
      );
    }
  });

  it("flag '0' in production accepted", () => {
    const config = parseSimulatorConfig({
      NODE_ENV: 'production',
      SIMULATOR_PORT: '3100',
      SIMULATOR_TEST_ENDPOINTS: '0',
    });
    expect(config.testEndpoints).toBe(false);
  });

  it("flag 'yes' rejected", () => {
    expect(() =>
      parseSimulatorConfig({
        NODE_ENV: 'test',
        SIMULATOR_PORT: '3100',
        SIMULATOR_TEST_ENDPOINTS: 'yes',
      }),
    ).toThrow(ConfigError);
  });

  it('port invalid rejected', () => {
    expect(() => parseSimulatorConfig({ NODE_ENV: 'test', SIMULATOR_PORT: 'x' })).toThrow(
      ConfigError,
    );
    expect(() => parseSimulatorConfig({ NODE_ENV: 'test', SIMULATOR_PORT: '70000' })).toThrow(
      ConfigError,
    );
    expect(() => parseSimulatorConfig({ NODE_ENV: 'test' })).toThrow('SIMULATOR_PORT: is required');
  });

  it('does not read PROVIDER_SIMULATOR_DATABASE_URL', () => {
    // Absent entirely; P06 introduces it. A missing value must not fail this parser.
    const config = parseSimulatorConfig({ NODE_ENV: 'test', SIMULATOR_PORT: '3100' });
    expect(config).not.toHaveProperty('databaseUrl');
  });
});
