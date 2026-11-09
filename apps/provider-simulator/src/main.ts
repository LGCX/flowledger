import Fastify from 'fastify';
import type { StartFn } from '@flowledger/config';
import { parseSimulatorConfig } from './config.js';

/** Inert in P00: liveness/readiness only. `/__test/*` control routes arrive in P06. */
export const start: StartFn = async (env) => {
  const config = parseSimulatorConfig(env);
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => ({ status: 'ready' }));

  await app.listen({ port: config.port, host: '0.0.0.0' });

  return { stop: () => app.close() };
};
