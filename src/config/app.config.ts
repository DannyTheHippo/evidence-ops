import type { INestApplication } from '@nestjs/common';
import { ShutdownSignal, ValidationPipe, VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import { AppLogger } from '../shared/services/logger/logger.service';
import type { AppConfig } from './environment/environment.config';
import { TypedConfigService } from './environment/typed-config.service';
import { createSwaggerConfig } from './swagger.config';

export const createApplicationConfig = async (app: INestApplication): Promise<AppConfig> => {
  const config = app.get(TypedConfigService);

  const appConfig = config.app;
  const corsConfig = config.cors;

  app.useLogger(await app.resolve(AppLogger));

  // Swagger UI at /docs inlines scripts/styles; helmet's default CSP would block it,
  // so CSP stays off and the other secure-header defaults (HSTS, no-sniff, etc.) apply.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.enableCors({
    origin: corsConfig.origin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Content-Length', 'X-Requested-With'],
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT]);

  createSwaggerConfig(app, config);

  return appConfig;
};
