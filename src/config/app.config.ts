import type { INestApplication } from '@nestjs/common';
import { ShutdownSignal, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
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

  // `NestFactory.create`/`createNestApplication` type their return as the framework-agnostic
  // `INestApplication`, which has no `.set()` — the Express-specific `NestExpressApplication` is
  // what actually backs it at runtime (this app never swaps HTTP adapters), so the cast is sound.
  //
  // The only reverse proxy between a browser and this process is the `web` nginx container
  // (`web/nginx.conf`, `proxy_pass http://api:3000`) — one hop. With `trust proxy` set to that
  // hop count, Express trusts the immediate socket peer (nginx) and reads `req.ip` off the
  // right-most `X-Forwarded-For` entry, which is the one nginx itself appended via
  // `$proxy_add_x_forwarded_for` — i.e. the real client address. This is what every user-keyed
  // throttle bucket (`UserThrottlerGuard`) and login/registration's IP fallback rely on. Docker's
  // host-port publish is a TCP-level mapping, not an HTTP proxy, so it adds no hop of its own.
  (app as NestExpressApplication).set('trust proxy', 1);

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
