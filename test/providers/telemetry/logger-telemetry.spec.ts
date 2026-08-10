import { LoggerTelemetry } from '../../../src/providers/telemetry/logger-telemetry';
import { AppLogger } from '../../../src/shared/services/logger/logger.service';
import { getMockLogger, type MockLogger } from '../../utils/get-mock-logger';

describe('LoggerTelemetry', () => {
  let logger: MockLogger;
  let telemetry: LoggerTelemetry;

  beforeEach(() => {
    logger = getMockLogger();
    telemetry = new LoggerTelemetry(logger as unknown as AppLogger);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should init the logger context to its own class name', () => {
    expect(logger.init).toHaveBeenCalledWith('LoggerTelemetry');
  });

  it('should log a non-error event at log level with its attributes', () => {
    telemetry.event({ name: 'model.request.start', attributes: { taskClass: 'qa_answer' } });

    expect(logger.log).toHaveBeenCalledWith('model.request.start', { taskClass: 'qa_answer' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should log an event with no attributes as an empty object', () => {
    telemetry.event({ name: 'model.request.success' });

    expect(logger.log).toHaveBeenCalledWith('model.request.success', {});
  });

  it('should log a *.error event at error level instead of log level', () => {
    telemetry.event({ name: 'model.request.error', attributes: { error: 'boom' } });

    expect(logger.error).toHaveBeenCalledWith('model.request.error', { error: 'boom' });
    expect(logger.log).not.toHaveBeenCalled();
  });
});
