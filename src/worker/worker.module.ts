import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../config/config.module';
import { mongooseModuleOptions } from '../config/mongo.config';
import { IngestionModule } from '../features/evidence/ingestion/ingestion.module';
import { QaModule } from '../features/evidence/qa/qa.module';
import { SharedModule } from '../shared/shared.module';

/**
 * Worker-side root module, booted via `NestFactory.createApplicationContext` in `main.ts` so
 * activities resolve real services from the same DI graph as the API process (ADR-0003). Mirrors
 * the slice of `AppModule`'s imports the worker's activities need — config, Mongo, and the
 * request-context/logger providers from `SharedModule`, plus `IngestionModule` and `QaModule` for
 * the services `createActivities` resolves — without the HTTP-only concerns (`ThrottlerModule`,
 * filters, versioning, middleware) that only apply to the API process.
 */
@Module({
  imports: [
    AppConfigModule,
    MongooseModule.forRootAsync(mongooseModuleOptions),
    SharedModule,
    IngestionModule,
    QaModule,
  ],
})
export class WorkerModule {}
