import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseBaseConfig, readFlag, readPort } from './base.js';

const repoRoot = new URL('../../../', import.meta.url);

function readText(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, repoRoot)), 'utf8');
}

describe('parseBaseConfig', () => {
  it('NODE_ENV valid values', () => {
    for (const value of ['development', 'test', 'production']) {
      expect(parseBaseConfig({ NODE_ENV: value })).toEqual({
        nodeEnv: value,
        shutdownGraceMs: 10_000,
      });
    }
  });

  it('NODE_ENV missing throws ConfigError naming NODE_ENV', () => {
    expect(() => parseBaseConfig({})).toThrow(ConfigError);
    try {
      parseBaseConfig({});
      expect.unreachable('parseBaseConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variable).toBe('NODE_ENV');
    }
  });

  it('NODE_ENV invalid', () => {
    expect(() => parseBaseConfig({ NODE_ENV: 'prod' })).toThrow(
      'NODE_ENV: must be one of development, test, production',
    );
  });

  it('SHUTDOWN_GRACE_MS default', () => {
    expect(parseBaseConfig({ NODE_ENV: 'test' }).shutdownGraceMs).toBe(10_000);
  });

  it('boundary 1000 and 60000 accepted', () => {
    expect(parseBaseConfig({ NODE_ENV: 'test', SHUTDOWN_GRACE_MS: '1000' }).shutdownGraceMs).toBe(
      1000,
    );
    expect(parseBaseConfig({ NODE_ENV: 'test', SHUTDOWN_GRACE_MS: '60000' }).shutdownGraceMs).toBe(
      60_000,
    );
  });

  it('999 and 60001 rejected', () => {
    expect(() => parseBaseConfig({ NODE_ENV: 'test', SHUTDOWN_GRACE_MS: '999' })).toThrow(
      ConfigError,
    );
    expect(() => parseBaseConfig({ NODE_ENV: 'test', SHUTDOWN_GRACE_MS: '60001' })).toThrow(
      ConfigError,
    );
  });

  it('non-integer rejected and value not echoed', () => {
    try {
      parseBaseConfig({ NODE_ENV: 'test', SHUTDOWN_GRACE_MS: 'abc' });
      expect.unreachable('parseBaseConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('SHUTDOWN_GRACE_MS');
      expect(message).not.toContain('abc');
    }
  });

  it('result is frozen', () => {
    const config = parseBaseConfig({ NODE_ENV: 'test' });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { nodeEnv: string }).nodeEnv = 'production';
    }).toThrow();
  });
});

describe('readPort', () => {
  it('0 and 65535 accepted', () => {
    expect(readPort({ PORT: '0' }, 'PORT')).toBe(0);
    expect(readPort({ PORT: '65535' }, 'PORT')).toBe(65_535);
  });

  it('-1, 65536 and x rejected', () => {
    expect(() => readPort({ PORT: '-1' }, 'PORT')).toThrow(ConfigError);
    expect(() => readPort({ PORT: '65536' }, 'PORT')).toThrow(ConfigError);
    expect(() => readPort({ PORT: 'x' }, 'PORT')).toThrow(ConfigError);
  });

  it('missing is rejected', () => {
    expect(() => readPort({}, 'PORT')).toThrow('PORT: is required');
  });

  it('rejection never echoes the value', () => {
    try {
      readPort({ PORT: '90000' }, 'PORT');
      expect.unreachable('readPort should have thrown');
    } catch (error) {
      expect((error as ConfigError).message).not.toContain('90000');
    }
  });
});

describe('readFlag', () => {
  it("accepts only '0' and '1'", () => {
    expect(readFlag({ F: '1' }, 'F', false)).toBe(true);
    expect(readFlag({ F: '0' }, 'F', true)).toBe(false);
  });

  it('falls back when unset', () => {
    expect(readFlag({}, 'F', true)).toBe(true);
    expect(readFlag({}, 'F', false)).toBe(false);
  });

  it('rejects anything else without echoing it', () => {
    expect(() => readFlag({ F: 'true' }, 'F', false)).toThrow(ConfigError);
    try {
      readFlag({ F: 'yes' }, 'F', false);
      expect.unreachable('readFlag should have thrown');
    } catch (error) {
      expect((error as ConfigError).message).not.toContain('yes');
    }
  });
});

describe('.env.example and CONFIG.md', () => {
  function envExampleVariables(): Set<string> {
    const names = new Set<string>();
    for (const line of readText('infra/docker/.env.example').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      names.add(trimmed.slice(0, separator));
    }
    return names;
  }

  function configDocVariables(): Set<string> {
    const names = new Set<string>();
    let inTable = false;
    for (const line of readText('docs/CONFIG.md').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('| Variable')) {
        inTable = true;
        continue;
      }
      if (!inTable) continue;
      if (!trimmed.startsWith('|')) {
        inTable = false;
        continue;
      }
      const first = trimmed.split('|')[1]?.trim() ?? '';
      if (first === '' || /^-+$/.test(first)) continue;
      names.add(first.replaceAll('`', ''));
    }
    return names;
  }

  it('.env.example and CONFIG.md list the same variables', () => {
    const fromExample = [...envExampleVariables()].sort();
    const fromDoc = [...configDocVariables()].sort();

    expect(fromExample.length).toBeGreaterThan(0);
    expect(fromDoc.length).toBeGreaterThan(0);
    expect(fromDoc).toEqual(fromExample);
  });
});
