import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseBaseConfig, readPort, type StartFn } from '@flowledger/config';
import { AppModule } from './app.module.js';

/**
 * Health and readiness are registered on the raw Fastify instance and are deliberately
 * not OpenAPI operations: they are process liveness, not merchant API surface.
 */
export const start: StartFn = async (env) => {
  parseBaseConfig(env);
  const port = readPort(env, 'API_PORT');

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.get('/healthz', async () => ({ status: 'ok' }));
  fastify.get('/readyz', async () => ({ status: 'ready' }));

  await app.listen(port, '0.0.0.0');
  return { stop: () => app.close() };
};
