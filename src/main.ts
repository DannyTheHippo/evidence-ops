import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createApplicationConfig } from './config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  const config = await createApplicationConfig(app);

  await app.listen(config.port);

  Logger.log(`Environment: '${config.env}'`);
  Logger.log(`App url: ${config.url}/api`);
  Logger.log(`Swagger docs: ${config.url}/docs`);
}

['uncaughtException', 'unhandledRejection'].forEach((signal) =>
  process.on(signal, (error: unknown) => {
    console.error(`${signal} received:`, error);
    process.exit(1);
  }),
);

async function main(): Promise<void> {
  try {
    await bootstrap();
  } catch (error: unknown) {
    console.error('Fatal bootstrap failure:', error);
    process.exit(1);
  }
}

void main();
