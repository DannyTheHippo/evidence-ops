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
  // The hop count is config-driven (`TRUST_PROXY_HOPS`, `app.trustProxyHops`) rather than fixed,
  // because this process is not always reachable through the same number of proxies: the `web`
  // nginx container (`web/nginx.conf`, `proxy_pass http://api:3000`) is one hop, but the compose
  // `api` service publishes its own port too, and a caller reaching that port arrives with no proxy
  // in front of it at all. Defaulting to 0 means every `X-Forwarded-For` entry is ignored and
  // `req.ip` is always the direct socket peer unless a deployment explicitly configures the exact
  // number of proxies in front of it. This is what every user-keyed throttle bucket
  // (`UserThrottlerGuard`) and login/registration's IP fallback rely on: trusting a hop that is not
  // actually there lets a caller past the real edge spoof `req.ip` via `X-Forwarded-For`.
  (app as NestExpressApplication).set('trust proxy', appConfig.trustProxyHops);

  // Swagger UI at /docs inlines scripts/styles; helmet's default CSP would block it,
  // so CSP stays off and the other secure-header defaults (HSTS, no-sniff, etc.) apply.
  app.use(helmet({ contentSecurityPolicy: false }));

  // No `Authorization` here: this process's only credential path is `JwtAuthGuard`'s session
  // cookie (`resolveSessionCookieName`), sent by the browser automatically — a request carrying
  // this header has nothing this process reads it for. The MCP surface's own bearer-token auth
  // (`pat-token.verifier.ts`) is a separate process with its own bootstrap, not this one.
  app.enableCors({
    origin: corsConfig.origin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Content-Length', 'X-Requested-With'],
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
