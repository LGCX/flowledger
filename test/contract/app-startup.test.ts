import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const APPS = [
  'api',
  'outbox-relay',
  'payment-worker',
  'provider-webhook-receiver',
  'provider-webhook-worker',
  'reconciler',
  'settlement-worker',
  'merchant-webhook-projector',
  'merchant-webhook-dispatcher',
  'provider-simulator',
] as const;

type AppName = (typeof APPS)[number];
type StartupEnv = Record<string, string | undefined>;

interface RunningApp {
  stop(): Promise<void>;
}

interface AppMain {
  start(env: StartupEnv): Promise<RunningApp>;
}

// One literal specifier per app: a computed `import()` of a variable path cannot be
// resolved statically, so the laziness is made explicit here.
const LOADERS: Record<AppName, () => Promise<AppMain>> = {
  api: () => import('@flowledger/app-api/main') as Promise<AppMain>,
  'outbox-relay': () => import('@flowledger/app-outbox-relay/main') as Promise<AppMain>,
  'payment-worker': () => import('@flowledger/app-payment-worker/main') as Promise<AppMain>,
  'provider-webhook-receiver': () =>
    import('@flowledger/app-provider-webhook-receiver/main') as Promise<AppMain>,
  'provider-webhook-worker': () =>
    import('@flowledger/app-provider-webhook-worker/main') as Promise<AppMain>,
  reconciler: () => import('@flowledger/app-reconciler/main') as Promise<AppMain>,
  'settlement-worker': () => import('@flowledger/app-settlement-worker/main') as Promise<AppMain>,
  'merchant-webhook-projector': () =>
    import('@flowledger/app-merchant-webhook-projector/main') as Promise<AppMain>,
  'merchant-webhook-dispatcher': () =>
    import('@flowledger/app-merchant-webhook-dispatcher/main') as Promise<AppMain>,
  'provider-simulator': () => import('@flowledger/app-provider-simulator/main') as Promise<AppMain>,
};

/** The only configuration source for these tests: the checked-in example file. */
function envFromExample(): StartupEnv {
  const env: StartupEnv = {};
  for (const line of readFileSync(join(repoRoot, 'infra/docker/.env.example'), 'utf8').split(
    '\n',
  )) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    env[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  env['NODE_ENV'] = 'test';
  env['API_PORT'] = '0';
  env['HEALTH_PORT'] = '0';
  env['SIMULATOR_PORT'] = '0';
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('application startup', () => {
  for (const app of APPS) {
    it(`${app} starts in test mode with only .env.example and stops`, async () => {
      const { start } = await LOADERS[app]();
      const env = envFromExample();

      const startedAt = Date.now();
      const running = await start(env);
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(5000);

      await expect(running.stop()).resolves.toBeUndefined();
    });
  }

  it('api serves /healthz 200 and /readyz 200', async () => {
    const { start } = await LOADERS.api();
    const port = await freePort();
    const env = { ...envFromExample(), API_PORT: String(port) };

    const running = await start(env);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: 'ready' });
    } finally {
      await running.stop();
    }
  });

  // The worker's not-ready window opens and closes inside `await ctx.close()`, which is
  // microseconds wide and therefore not observable without racing. The deterministic
  // facts asserted here are readiness before shutdown and a released port after it; the
  // 503 transition itself is covered exactly by P00-T03's `/readyz` cases.
  it('worker health endpoint is ready, then the port is released after stop', async () => {
    const { start } = await LOADERS['payment-worker']();
    const port = await freePort();
    const env = { ...envFromExample(), HEALTH_PORT: String(port) };

    const running = await start(env);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });

    await running.stop();

    await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
  });

  for (const app of ['api', 'payment-worker'] as const) {
    it(`missing NODE_ENV fails startup naming the variable (${app})`, async () => {
      const { start } = await LOADERS[app]();
      const env = envFromExample();
      delete env['NODE_ENV'];

      await expect(start(env)).rejects.toThrow(/NODE_ENV/);
    });
  }

  it('no app main.ts reads process.env', () => {
    const offenders = APPS.filter((app) =>
      readFileSync(join(repoRoot, 'apps', app, 'src/main.ts'), 'utf8').includes('process.env'),
    );
    expect(offenders).toEqual([]);
  });

  it('provider-simulator serves /healthz 200', async () => {
    const { start } = await LOADERS['provider-simulator']();
    const port = await freePort();
    const env = { ...envFromExample(), SIMULATOR_PORT: String(port) };

    const running = await start(env);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });
    } finally {
      await running.stop();
    }
  });

  it('flowledger --help prints the three subcommands and exits 0', async () => {
    const { runCli } = (await import('@flowledger/app-cli/main')) as {
      runCli: (
        argv: readonly string[],
        io: { out(l: string): void; err(l: string): void },
      ) => Promise<number>;
    };
    const out: string[] = [];
    const exitCode = await runCli(['--help'], { out: (l) => out.push(l), err: () => {} });

    expect(exitCode).toBe(0);
    const text = out.join('\n');
    for (const command of ['migrate', 'seed', 'verify']) expect(text).toContain(command);
  });
});
