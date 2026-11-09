import { describe, expect, it } from 'vitest';
import { startHealthServer, runMain, type RunningApp, type Signal } from './lifecycle.js';

/** Resolves after the runMain promise chain has had a chance to settle. */
const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  readonly exits: number[];
  readonly signals: Map<Signal, () => void>;
  readonly stopCalls: () => number;
}

function harness(app: RunningApp): Harness {
  const exits: number[] = [];
  const signals = new Map<Signal, () => void>();
  let stops = 0;

  const wrapped: RunningApp = {
    stop: () => {
      stops += 1;
      return app.stop();
    },
  };

  runMain(async () => wrapped, {
    env: { NODE_ENV: 'test', SHUTDOWN_GRACE_MS: '1000' },
    exit: (code) => exits.push(code),
    on: (signal, handler) => signals.set(signal, handler),
  });

  return { exits, signals, stopCalls: () => stops };
}

describe('runMain', () => {
  it('startup rejection exits 1 without stopping', async () => {
    const exits: number[] = [];
    const signals = new Map<Signal, () => void>();

    runMain(() => Promise.reject(new Error('boom')), {
      env: { NODE_ENV: 'test' },
      exit: (code) => exits.push(code),
      on: (signal, handler) => signals.set(signal, handler),
    });
    await settle();

    expect(exits).toEqual([1]);
    expect(signals.size).toBe(0);
  });

  it('SIGTERM stops once then exits 0', async () => {
    const test = harness({ stop: () => Promise.resolve() });
    await settle();

    expect(test.signals.size).toBe(2);
    test.signals.get('SIGTERM')?.();
    await settle();

    expect(test.stopCalls()).toBe(1);
    expect(test.exits).toEqual([0]);
  });

  it('SIGINT also triggers shutdown', async () => {
    const test = harness({ stop: () => Promise.resolve() });
    await settle();

    test.signals.get('SIGINT')?.();
    await settle();

    expect(test.stopCalls()).toBe(1);
    expect(test.exits).toEqual([0]);
  });

  it('second signal ignored', async () => {
    const test = harness({ stop: () => new Promise((resolve) => setTimeout(resolve, 20)) });
    await settle();

    test.signals.get('SIGTERM')?.();
    test.signals.get('SIGTERM')?.();
    test.signals.get('SIGINT')?.();
    await settle(60);

    expect(test.stopCalls()).toBe(1);
    expect(test.exits).toEqual([0]);
  });

  it('stop rejects exits 1', async () => {
    const test = harness({ stop: () => Promise.reject(new Error('stop failed')) });
    await settle();

    test.signals.get('SIGTERM')?.();
    await settle();

    expect(test.stopCalls()).toBe(1);
    expect(test.exits).toEqual([1]);
  });

  it('stop exceeds grace exits 1', async () => {
    const exits: number[] = [];
    const signals = new Map<Signal, () => void>();
    let stops = 0;

    runMain(
      async () => ({
        stop: () => {
          stops += 1;
          return new Promise<void>(() => {
            /* never resolves */
          });
        },
      }),
      {
        env: { NODE_ENV: 'test' },
        graceMs: 50,
        exit: (code) => exits.push(code),
        on: (signal, handler) => signals.set(signal, handler),
      },
    );
    await settle();

    const startedAt = Date.now();
    signals.get('SIGTERM')?.();
    await settle(120);

    expect(stops).toBe(1);
    expect(exits).toEqual([1]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
  });
});

describe('startHealthServer', () => {
  it('port 0 reports the bound port', async () => {
    const health = await startHealthServer(0);
    try {
      expect(health.port).toBeGreaterThan(0);
    } finally {
      await health.close();
    }
  });

  it('/healthz 200', async () => {
    const health = await startHealthServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${health.port}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await health.close();
    }
  });

  it('/readyz 503 then 200 after setReady(true)', async () => {
    const health = await startHealthServer(0);
    try {
      const before = await fetch(`http://127.0.0.1:${health.port}/readyz`);
      expect(before.status).toBe(503);
      expect(await before.json()).toEqual({ status: 'not_ready' });

      health.setReady(true);

      const after = await fetch(`http://127.0.0.1:${health.port}/readyz`);
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ status: 'ready' });
    } finally {
      await health.close();
    }
  });

  it('unknown path 404', async () => {
    const health = await startHealthServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${health.port}/nope`);
      expect(response.status).toBe(404);
    } finally {
      await health.close();
    }
  });

  it('close releases the port', async () => {
    const health = await startHealthServer(0);
    const { port } = health;
    await health.close();
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
