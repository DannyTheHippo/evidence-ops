import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { TypedConfigService } from './config/environment/typed-config.service';
import { mongooseModuleOptions } from './config/mongo.config';
import { AuthModule } from './features/common/auth/auth.module';
import { CsrfOriginMiddleware } from './features/common/auth/middlewares/csrf-origin.middleware';
import { HealthModule } from './features/common/health/health.module';
import { InfoModule } from './features/common/info/info.module';
import { ApprovalsModule } from './features/evidence/approvals/approvals.module';
import { ConflictsModule } from './features/evidence/conflicts/conflicts.module';
import { DocumentsModule } from './features/evidence/documents/documents.module';
import { FactsModule } from './features/evidence/facts/facts.module';
import { IngestionModule } from './features/evidence/ingestion/ingestion.module';
import { QaModule } from './features/evidence/qa/qa.module';
import { SourcesModule } from './features/evidence/sources/sources.module';
import { WorkflowRunsModule } from './features/evidence/workflow-runs/workflow-runs.module';
import { AuditEventsModule } from './features/platform/audit-events/audit-events.module';
import { AuthzModule } from './features/platform/authz/authz.module';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { SelectInterceptor } from './shared/interceptors/select.interceptor';
import { AsyncLocalStorageMiddleware } from './shared/middlewares/async-local-storage.middleware';
import { CorrelationMiddleware } from './shared/middlewares/correlation.middleware';
import { SharedModule } from './shared/shared.module';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: SelectInterceptor },
    // Safety gate: fails CLOSED — a request over the configured limit is denied (429),
    // never silently let through, even if the throttler storage lookup itself misbehaves.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
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
    HealthModule,
    InfoModule,
    DocumentsModule,
    IngestionModule,
    FactsModule,
    ConflictsModule,
    QaModule,
    ApprovalsModule,
    WorkflowRunsModule,
    SourcesModule,
    AuthzModule,
    AuditEventsModule,
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
