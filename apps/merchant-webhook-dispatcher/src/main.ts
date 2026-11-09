import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseBaseConfig, readPort, startHealthServer, type StartFn } from '@flowledger/config';
import { AppModule } from './app.module.js';

export const start: StartFn = async (env) => {
  parseBaseConfig(env);

  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const health = await startHealthServer(readPort(env, 'HEALTH_PORT'));
  health.setReady(true);

  return {
    stop: async () => {
      health.setReady(false);
      await ctx.close();
      await health.close();
    },
  };
};
