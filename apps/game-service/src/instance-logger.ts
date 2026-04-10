import * as os from 'os';
import { ConsoleLogger, LogLevel } from '@nestjs/common';

function getInstanceId(): string {
  // Try private IP (unique per ECS task)
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return os.hostname().slice(-12);
}

export const INSTANCE_ID = getInstanceId();

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
