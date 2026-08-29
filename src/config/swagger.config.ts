import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import packageJSON from '../../package.json';
import { resolveSessionCookieName } from '../features/common/auth/auth.constant';
import {
  FieldValidationErrorResponseDto,
  ValidationErrorResponseDto,
} from '../shared/dtos/response/validation-error.response.dto';
import { TypedConfigService } from './environment/typed-config.service';

export const createSwaggerConfig = (app: INestApplication, config: TypedConfigService) => {
  const appConfig = config.app;

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setVersion(packageJSON.version)
      .setTitle('Evidence Ops API')
      .setDescription('Evidence Ops API specification')
      .addCookieAuth(resolveSessionCookieName(appConfig.env))
      .build(),
    { extraModels: [ValidationErrorResponseDto, FieldValidationErrorResponseDto] },
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
