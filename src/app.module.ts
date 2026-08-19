import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { TypedConfigService } from './config/environment/typed-config.service';
import { mongooseModuleOptions } from './config/mongo.config';
import { AuthModule } from './features/common/auth/auth.module';
import { CsrfOriginMiddleware } from './features/common/auth/middlewares/csrf-origin.middleware';
import { HealthModule } from './features/common/health/health.module';
import { InfoModule } from './features/common/info/info.module';
import { InvitationsModule } from './features/common/invitations/invitations.module';
import { ApprovalsModule } from './features/evidence/approvals/approvals.module';
import { ConflictsModule } from './features/evidence/conflicts/conflicts.module';
import { DocumentsModule } from './features/evidence/documents/documents.module';
import { FactsModule } from './features/evidence/facts/facts.module';
import { IngestionModule } from './features/evidence/ingestion/ingestion.module';
import { MeasuresModule } from './features/evidence/measures/measures.module';
import { QaModule } from './features/evidence/qa/qa.module';
import { RetrievalModule } from './features/evidence/retrieval/retrieval.module';
import { SourcesModule } from './features/evidence/sources/sources.module';
import { WorkflowRunsModule } from './features/evidence/workflow-runs/workflow-runs.module';
import { ApiKeysModule } from './features/platform/api-keys/api-keys.module';
import { AuditEventsModule } from './features/platform/audit-events/audit-events.module';
import { AuthzModule } from './features/platform/authz/authz.module';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { PreAuthThrottlerGuard } from './shared/guards/pre-auth-throttler.guard';
import { UserThrottlerGuard } from './shared/guards/user-throttler.guard';
import { SelectInterceptor } from './shared/interceptors/select.interceptor';
import { AsyncLocalStorageMiddleware } from './shared/middlewares/async-local-storage.middleware';
import { CorrelationMiddleware } from './shared/middlewares/correlation.middleware';
import { SharedModule } from './shared/shared.module';

/**
 * Global guards run in the order their `APP_GUARD` provider is registered, which follows the
 * module scan order — and a module's own directly-declared providers register before any of its
 * imports do, so a guard declared on `AppModule` itself always runs before one declared on an
 * imported module such as `AuthModule`. `UserThrottlerGuard.getTracker` reads `request.user`, which
 * only `JwtAuthGuard` (registered by `AuthModule`) sets, so the throttle guard has to be registered
 * from a module the scanner visits after `AuthModule` — hence this module instead of a direct entry
 * on `AppModule.providers`, imported below only once `AuthModule` already is.
 *
 * `PreAuthThrottlerGuard` (registered directly on `AppModule.providers` below) is the mirror image:
 * it reads only `request.ip`, never `request.user`, so it has no reason to wait for `AuthModule` and
 * every reason not to — placed here it would run after `JwtAuthGuard` too, and a request
 * `JwtAuthGuard` rejects would never reach it, reopening the gap it exists to close.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: UserThrottlerGuard }],
})
class ThrottlingModule {}

@Module({
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: SelectInterceptor },
    // Runs before every other global guard, including `JwtAuthGuard` — see the doc comment above
    // `ThrottlingModule` for why a direct `AppModule.providers` entry is what achieves that. Bounds
    // every request by caller IP before authentication is attempted, so a credential-less burst
    // against an authenticated route can no longer dodge all throttling by failing `JwtAuthGuard`'s
    // 401 before `UserThrottlerGuard` (which only ever runs after, on requests already past auth)
    // gets a turn.
    { provide: APP_GUARD, useClass: PreAuthThrottlerGuard },
  ],
  imports: [
    AppConfigModule,
    MongooseModule.forRootAsync(mongooseModuleOptions),
    ThrottlerModule.forRootAsync({
      inject: [TypedConfigService],
      useFactory: (config: TypedConfigService) => ({
        throttlers: [{ ttl: config.throttle.ttlMs, limit: config.throttle.limit }],
      }),
    }),

    SharedModule,

    AuthModule,
    // Per-user safety gate, layered behind the perimeter `PreAuthThrottlerGuard` above: fails
    // CLOSED — a request over the configured limit is denied (429), never silently let through,
    // even if the throttler storage lookup itself misbehaves. Keyed by authenticated user id rather
    // than IP (`UserThrottlerGuard`), so requests from different users behind the same reverse
    // proxy do not collapse into one shared bucket. Imported after `AuthModule` — see
    // `ThrottlingModule`'s doc comment for why the position is load-bearing.
    ThrottlingModule,
    HealthModule,
    InfoModule,
    InvitationsModule,
    DocumentsModule,
    IngestionModule,
    FactsModule,
    ConflictsModule,
    QaModule,
    MeasuresModule,
    RetrievalModule,
    ApprovalsModule,
    WorkflowRunsModule,
    SourcesModule,
    AuthzModule,
    AuditEventsModule,
    ApiKeysModule,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    const publicRoutes = [
      { path: 'health', method: RequestMethod.ALL, version: '1' },
      { path: 'info', method: RequestMethod.ALL, version: '1' },
    ];

    consumer
      .apply(CorrelationMiddleware)
      .exclude(...publicRoutes)
      .forRoutes('*');
    consumer
      .apply(AsyncLocalStorageMiddleware)
      .exclude(...publicRoutes)
      .forRoutes('*');
    consumer
      .apply(CsrfOriginMiddleware)
      .exclude(...publicRoutes)
      .forRoutes('*');
  }
}
