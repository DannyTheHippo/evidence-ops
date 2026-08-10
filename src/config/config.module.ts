import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './environment/environment.config';
import { TypedConfigService } from './environment/typed-config.service';

/**
 * Global configuration. Validates the environment once at boot (zod), exposes
 * the namespaced, typed `TypedConfigService` to every module.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
      envFilePath: ['.env'],
    }),
  ],
  providers: [TypedConfigService],
  exports: [TypedConfigService],
})
export class AppConfigModule {}
