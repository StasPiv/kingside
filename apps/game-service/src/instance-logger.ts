import * as os from 'os';
import { ConsoleLogger, LogLevel } from '@nestjs/common';

/** Resolved asynchronously from ECS metadata, falls back to hostname */
export let INSTANCE_ID = os.hostname().slice(-12);

/** Fetch task IP from ECS container metadata (call once at startup) */
export async function resolveInstanceId(): Promise<void> {
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) return; // not on ECS — keep hostname fallback

  try {
    const res = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json() as { Containers?: Array<{ Networks?: Array<{ IPv4Addresses?: string[] }> }> };
    const ip = data.Containers?.[0]?.Networks?.[0]?.IPv4Addresses?.[0];
    if (ip) INSTANCE_ID = ip;
  } catch { /* keep fallback */ }
}

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
