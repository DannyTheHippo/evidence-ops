import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import packageJSON from '../../package.json';
import { TypedConfigService } from './environment/typed-config.service';

export const createSwaggerConfig = (app: INestApplication, config: TypedConfigService) => {
  const appConfig = config.app;

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setVersion(packageJSON.version)
      .setTitle('Evidence Ops API')
      .setDescription('Evidence Ops API specification')
      .addBearerAuth()
      .build(),
  );

  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  if (appConfig.env === 'local') {
    try {
      writeFileSync('openapi.json', JSON.stringify(document, null, 2));
    } catch (error: unknown) {
      Logger.error('Failed to write openapi.json:', error);
    }
  }
};
