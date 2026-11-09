/**
 * Base configuration shared by every process.
 *
 * Two rules hold for everything in this module:
 *  - a failure names the offending variable and NEVER echoes its value
 *    (CONVENTIONS §11: "invalid/missing config fails startup with the variable name
 *    (never its value)"), and
 *  - the returned config objects are frozen, so nothing downstream can mutate config.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export type NodeEnv = 'development' | 'test' | 'production';

export interface BaseConfig {
  readonly nodeEnv: NodeEnv;
  readonly shutdownGraceMs: number;
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const MIN_SHUTDOWN_GRACE_MS = 1_000;
const MAX_SHUTDOWN_GRACE_MS = 60_000;

const MAX_PORT = 65_535;

/** Integer syntax only: no decimals, no exponent, no leading/trailing space. */
const INTEGER = /^-?\d+$/;

export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    reason: string,
  ) {
    // The reason is a fixed phrase. It must never be built from the value.
    super(`${variable}: ${reason}`);
    this.name = 'ConfigError';
  }
}

function readRaw(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === '' ? undefined : raw;
}

function readInteger(env: Env, name: string, reason: string): number {
  const raw = readRaw(env, name);
  if (raw === undefined) throw new ConfigError(name, 'is required');
  if (!INTEGER.test(raw)) throw new ConfigError(name, reason);
  return Number(raw);
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(value);
}

export function parseBaseConfig(env: Env): BaseConfig {
  const raw = readRaw(env, 'NODE_ENV');
  if (raw === undefined) throw new ConfigError('NODE_ENV', 'is required');
  if (!isNodeEnv(raw)) {
    throw new ConfigError('NODE_ENV', `must be one of ${NODE_ENVS.join(', ')}`);
  }

  const graceRaw = readRaw(env, 'SHUTDOWN_GRACE_MS');
  let shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS;
  if (graceRaw !== undefined) {
    if (!INTEGER.test(graceRaw)) {
      throw new ConfigError('SHUTDOWN_GRACE_MS', 'must be an integer');
    }
    shutdownGraceMs = Number(graceRaw);
    if (shutdownGraceMs < MIN_SHUTDOWN_GRACE_MS || shutdownGraceMs > MAX_SHUTDOWN_GRACE_MS) {
      throw new ConfigError(
        'SHUTDOWN_GRACE_MS',
        `must be between ${MIN_SHUTDOWN_GRACE_MS} and ${MAX_SHUTDOWN_GRACE_MS}`,
      );
    }
  }

  return Object.freeze({ nodeEnv: raw, shutdownGraceMs });
}

/** A required listening port. `0` is valid: it binds an ephemeral port. */
export function readPort(env: Env, name: string): number {
  const value = readInteger(env, name, 'must be an integer');
  if (value < 0 || value > MAX_PORT) {
    throw new ConfigError(name, `must be between 0 and ${MAX_PORT}`);
  }
  return value;
}

/** A boolean flag written as `0` or `1`. Anything else is a configuration error. */
export function readFlag(env: Env, name: string, fallback: boolean): boolean {
  const raw = readRaw(env, name);
  if (raw === undefined) return fallback;
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new ConfigError(name, "must be '0' or '1'");
}
