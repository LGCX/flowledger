import { createServer, type ServerResponse } from 'node:http';
import { parseBaseConfig, type Env } from './base.js';

export interface RunningApp {
  stop(): Promise<void>;
}

export type StartFn = (env: Env) => Promise<RunningApp>;

export type Signal = 'SIGTERM' | 'SIGINT';

export interface RunMainDeps {
  env?: Env;
  exit?: (code: number) => void;
  on?: (signal: Signal, handler: () => void) => void;
  graceMs?: number;
}

const FALLBACK_GRACE_MS = 10_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Boots an application and owns its shutdown.
 *
 * `stop()` runs at most once across repeated signals: the first SIGTERM/SIGINT wins and
 * every later one is ignored, so a supervisor's escalations cannot start a second
 * shutdown over the top of the first.
 */
export function runMain(start: StartFn, deps: RunMainDeps = {}): void {
  const env: Env = deps.env ?? process.env;
  const exit = deps.exit ?? ((code: number): void => void (process.exitCode = code));
  const on =
    deps.on ?? ((signal: Signal, handler: () => void): void => void process.on(signal, handler));

  let app: RunningApp | undefined;
  let shuttingDown = false;

  // Resolved at shutdown rather than at boot: by then `start` has succeeded, so the
  // grace period is readable. The fallback only matters if a caller injected a `start`
  // that never parsed the base config.
  const graceMs = (): number => {
    if (deps.graceMs !== undefined) return deps.graceMs;
    try {
      return parseBaseConfig(env).shutdownGraceMs;
    } catch {
      return FALLBACK_GRACE_MS;
    }
  };

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const limit = graceMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), limit);
    });

    const stopping = app === undefined ? Promise.resolve() : app.stop();

    void Promise.race([stopping, expired])
      .then((outcome) => {
        if (timer !== undefined) clearTimeout(timer);
        exit(outcome === 'expired' ? 1 : 0);
      })
      .catch(() => {
        if (timer !== undefined) clearTimeout(timer);
        exit(1);
      });
  };

  start(env)
    .then((running) => {
      app = running;
      on('SIGTERM', shutdown);
      on('SIGINT', shutdown);
    })
    .catch((error: unknown) => {
      process.stderr.write(`startup failed: ${messageOf(error)}\n`);
      exit(1);
    });
}

export interface HealthServer {
  readonly port: number;
  setReady(ready: boolean): void;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Minimal health/readiness endpoint for processes that serve no HTTP traffic of their
 * own. `/healthz` is liveness and always answers; `/readyz` follows {@link setReady}.
 * Starts not-ready so a supervisor cannot route traffic before the process says so.
 */
export async function startHealthServer(port: number): Promise<HealthServer> {
  let ready = false;

  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (request.method !== 'GET') {
      sendJson(response, 404, '{"status":"not_found"}');
      return;
    }
    if (path === '/healthz') {
      sendJson(response, 200, '{"status":"ok"}');
      return;
    }
    if (path === '/readyz') {
      sendJson(
        response,
        ready ? 200 : 503,
        ready ? '{"status":"ready"}' : '{"status":"not_ready"}',
      );
      return;
    }
    sendJson(response, 404, '{"status":"not_found"}');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    port: boundPort,
    setReady: (next: boolean): void => {
      ready = next;
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
