import { ConsoleLogger, Inject, Injectable, Scope } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { AlsContext } from '../../types/als-context.type';
import { resolveLogLevels } from '../../utils/resolve-log-levels.util';

@Injectable({ scope: Scope.TRANSIENT })
export class AppLogger extends ConsoleLogger {
  constructor(
    @Inject(AsyncLocalStorage) private readonly als: AsyncLocalStorage<AlsContext>,
    config: TypedConfigService,
  ) {
    super();
    this.setLogLevels(resolveLogLevels(config.app.logLevel));
  }

  init(context: string): void {
    this.setContext(context);
  }

  override log(message: string, ...optionalParams: unknown[]): void {
    super.log(this.withCorrelationId(message), ...optionalParams);
  }

  override debug(message: string, ...optionalParams: unknown[]): void {
    super.debug(this.withCorrelationId(message), ...optionalParams);
  }

  override verbose(message: string, ...optionalParams: unknown[]): void {
    super.verbose(this.withCorrelationId(message), ...optionalParams);
  }

  override warn(message: string, ...optionalParams: unknown[]): void {
    super.warn(this.withCorrelationId(message), ...optionalParams);
  }

  override error(message: string, ...optionalParams: unknown[]): void {
    super.error(this.withCorrelationId(message), ...optionalParams);
  }

  override fatal(message: string, ...optionalParams: unknown[]): void {
    super.fatal(this.withCorrelationId(message), ...optionalParams);
  }

  private withCorrelationId(message: string): string {
    const correlationId = this.als.getStore()?.['correlation-id'];
    return correlationId ? `[${correlationId}] ${message}` : message;
  }
}
