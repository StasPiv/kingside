import * as os from 'os';
import { ConsoleLogger, LogLevel } from '@nestjs/common';

const INSTANCE_ID = os.hostname().slice(-12);

/**
 * Logger that prefixes every message with instance ID.
 * Allows distinguishing logs from different ECS tasks.
 */
export class InstanceLogger extends ConsoleLogger {
  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const base = super.formatMessage(logLevel, message, pidMessage, formattedLogLevel, contextMessage, timestampDiff);
    return `[${INSTANCE_ID}] ${base}`;
  }
}
