import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import { isProdLike } from '../../config/environment/environment.config';
import { TypedConfigService } from '../../config/environment/typed-config.service';

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly config: TypedConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const appConfig = this.config.app;

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const body: Record<string, unknown> =
      typeof message === 'string' ? { status, message } : { ...message };

    if (!isProdLike(appConfig.env) && exception instanceof Error) {
      body.stack = exception.stack;

      if (exception.cause instanceof Error) {
        body.cause = { message: exception.cause.message, stack: exception.cause.stack };
      }
    }

    const response = host.switchToHttp().getResponse<Response>();
    response.status(status).json(body);
  }
}
