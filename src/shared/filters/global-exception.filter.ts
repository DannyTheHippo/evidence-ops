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
import { AppLogger } from '../services/logger/logger.service';

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly config: TypedConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.init(GlobalExceptionFilter.name);
  }

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

    // `AppLogger` reads the correlation id off ALS itself (`withCorrelationId`), so every line
    // here already carries it. Only a 500-and-above status is logged — a routine 4xx from
    // `HttpException`/`BaseException` is expected application traffic, not the "zero server-side
    // record" gap this filter closes; anything that reaches the client as a 5xx gets one.
    if (Number(status) >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      const errorMessage = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `Unhandled exception (status ${status}): ${errorMessage}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const response = host.switchToHttp().getResponse<Response>();
    // A response whose headers are already sent (a stream that started writing before this
    // exception fired) cannot be re-written — calling `.status().json()` on it throws again,
    // outside any filter that could catch it. The log line above still fires either way.
    if (response.headersSent) {
      return;
    }

    response.status(status).json(body);
  }
}
