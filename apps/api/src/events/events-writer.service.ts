/**
 * KS-4695 / ADR-147 §2.2 пункт «Events Writer Worker». Consumer-group
 * по Redis Stream `actor_events:stream`, batch INSERT в
 * `events.actor_events` через PrismaClient под учёткой `events_writer`
 * + INCR Redis hot counters (`agg:<actor_id>:<type>:<window>`).
 *
 * Жизненный цикл:
 *   1. `onModuleInit` — `XGROUP CREATE … MKSTREAM` (идемпотентно).
 *   2. Бесконечный цикл `XREADGROUP COUNT 1000 BLOCK 1000`.
 *   3. Batch INSERT (через `prisma.actorEvent.createMany`).
 *   4. Pipeline INCR + EXPIRE по hot counters.
 *   5. `XACK` обработанных messageId.
 *   6. Раз в 5 сек — `XPENDING` → обновить gauge'и lag/size.
 *   7. `onModuleDestroy` — мягкая остановка (стоп-флаг, await текущего
 *      батча, $disconnect).
 *
 * Defensive:
 *   - Если EventsPrismaService.getWriter() === null (нет EVENTS_* env)
 *     — воркер не стартует, log warn. Локаль без events-infra работает.
 *   - Если XADD в Stream'е есть, а Redis Stream-сервер недоступен —
 *     цикл логирует и спит 1 сек, потом продолжает.
 *   - Если batch INSERT падает (например, drift схемы) — НЕ ACK'аем,
 *     цикл повторит на следующей итерации (entries останутся в PEL).
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { PrismaClient as EventsPrismaClient, Prisma } from '@kingside/events-db';
import { RedisService } from '../redis/redis.service';
import { EventsMetricsService } from './events-metrics.service';
import { EventsPrismaService } from './events-prisma.service';
import {
  ACTOR_EVENTS_STREAM,
  AGG_KEY_PREFIX,
  AGG_WINDOWS_SEC,
  EVENTS_WRITER_GROUP,
} from './events.types';

const CONSUMER_NAME = `writer-${process.pid}`;
const BATCH_COUNT = 1_000;
const BLOCK_MS = 1_000;
/** Период обновления XPENDING-метрик (мс). */
const PENDING_METRICS_INTERVAL_MS = 5_000;

@Injectable()
export class EventsWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsWriterService.name);
  private stopRequested = false;
  private loopDone: Promise<void> | null = null;
  private pendingMetricsTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: EventsMetricsService,
    private readonly prismaSvc: EventsPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const writer = this.prismaSvc.getWriter();
    if (!writer) {
      this.logger.warn(
        'EventsPrismaService writer-client отсутствует — воркер не стартует. '
          + 'EVENTS_DATABASE_URL/EVENTS_WRITER_PASSWORD не заданы (локальный dev).',
      );
      return;
    }

    await this.ensureGroup();
    this.loopDone = this.runLoop(writer);
    this.pendingMetricsTimer = setInterval(
      () => void this.updatePendingMetrics(),
      PENDING_METRICS_INTERVAL_MS,
    );
    this.logger.log(`EventsWriter started (consumer=${CONSUMER_NAME}, group=${EVENTS_WRITER_GROUP}).`);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopRequested = true;
    if (this.pendingMetricsTimer) clearInterval(this.pendingMetricsTimer);
    this.pendingMetricsTimer = null;
    if (this.loopDone) {
      // Ждём максимум 2× BLOCK_MS — XREADGROUP-блок завершится сам.
      await Promise.race([
        this.loopDone,
        new Promise<void>((resolve) => setTimeout(resolve, BLOCK_MS * 2 + 500)),
      ]);
    }
  }

  /**
   * `XGROUP CREATE actor_events:stream events-writer $ MKSTREAM` —
   * идемпотентно. BUSYGROUP — нормальная ошибка повторного create.
   */
  private async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        'CREATE',
        ACTOR_EVENTS_STREAM,
        EVENTS_WRITER_GROUP,
        '$',
        'MKSTREAM',
      );
      this.logger.log(`XGROUP CREATE OK: ${EVENTS_WRITER_GROUP}@${ACTOR_EVENTS_STREAM}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('BUSYGROUP')) {
        // Уже создана — нормально.
        return;
      }
      this.logger.error(`XGROUP CREATE failed: ${msg}`);
      throw err;
    }
  }

  private async runLoop(writer: EventsPrismaClient): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.processBatch(writer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`runLoop: batch failed, will retry: ${msg}`);
        await sleep(1_000);
      }
    }
  }

  /**
   * Один шаг: XREADGROUP → INSERT → INCR-counters → XACK.
   * Если в Stream'е пусто (`XREADGROUP` вернул null после BLOCK) —
   * молча возвращается.
   */
  private async processBatch(writer: EventsPrismaClient): Promise<void> {
    // ioredis типизирует xreadgroup ответ как `unknown` (его форма
    // массива массивов сложна для статики). Парсим вручную.
    const res = (await this.redis.xreadgroup(
      'GROUP',
      EVENTS_WRITER_GROUP,
      CONSUMER_NAME,
      'COUNT',
      BATCH_COUNT,
      'BLOCK',
      BLOCK_MS,
      'STREAMS',
      ACTOR_EVENTS_STREAM,
      '>',
    )) as XReadGroupResult | null;

    if (!res) return;
    const messages = extractMessages(res, ACTOR_EVENTS_STREAM);
    if (messages.length === 0) return;

    const rows: Prisma.ActorEventCreateManyInput[] = [];
    const counterIncrs: Array<{ key: string; ttlSec: number }> = [];
    const ackIds: string[] = [];
    const perTypeStats = new Map<string, { user: number; guest: number }>();

    for (const msg of messages) {
      const parsed = parseFields(msg.fields);
      if (!parsed) {
        // Малформед — ACK'аем чтобы не зацикливаться. Лучше потерять одну
        // битую запись, чем дать PEL расти бесконечно.
        ackIds.push(msg.id);
        continue;
      }
      const { type, actorId, actorType, payload, occurredAt } = parsed;
      rows.push({
        actorId,
        actorType,
        type,
        payload,
        createdAt: occurredAt,
      });
      // Hot counters: три окна на (actor_id, type).
      for (const [winKey, winSec] of Object.entries(AGG_WINDOWS_SEC)) {
        counterIncrs.push({
          key: `${AGG_KEY_PREFIX}${actorId}:${type}:${winKey}`,
          ttlSec: winSec,
        });
      }
      ackIds.push(msg.id);

      const stats = perTypeStats.get(type) ?? { user: 0, guest: 0 };
      stats[actorType] += 1;
      perTypeStats.set(type, stats);
    }

    if (rows.length > 0) {
      await writer.actorEvent.createMany({ data: rows });
    }

    if (counterIncrs.length > 0) {
      const pipe = this.redis.pipeline();
      for (const c of counterIncrs) {
        pipe.incr(c.key).expire(c.key, c.ttlSec);
      }
      await pipe.exec();
    }

    if (ackIds.length > 0) {
      await this.redis.xack(ACTOR_EVENTS_STREAM, EVENTS_WRITER_GROUP, ...ackIds);
    }

    // Метрики по фактически записанным.
    for (const [type, stats] of perTypeStats.entries()) {
      if (stats.user > 0) this.metrics.incInserted(type, 'user', stats.user);
      if (stats.guest > 0) this.metrics.incInserted(type, 'guest', stats.guest);
    }
  }

  /**
   * Раз в 5 сек обновляет два gauge'а — pending count и idle самого
   * старого entry. Через XPENDING (минимальная форма) + XPENDING со
   * стартовой границей если есть подвисшие.
   */
  private async updatePendingMetrics(): Promise<void> {
    try {
      // XPENDING <stream> <group> → [count, minId, maxId, [[consumer, count], ...]]
      const summary = (await this.redis.xpending(
        ACTOR_EVENTS_STREAM,
        EVENTS_WRITER_GROUP,
      )) as [number, string | null, string | null, Array<[string, string]> | null];

      const count = Number(summary?.[0] ?? 0);
      this.metrics.setStreamPending(ACTOR_EVENTS_STREAM, count);

      if (count === 0) {
        this.metrics.setBufferLag(0);
        return;
      }

      // Возраст самого старого pending = now - timestamp(minId).
      // ID в Redis stream имеет формат `<ms>-<seq>`.
      const minId = summary?.[1];
      if (minId) {
        const msPart = parseInt(minId.split('-')[0] ?? '0', 10);
        if (Number.isFinite(msPart) && msPart > 0) {
          const lagSec = Math.max(0, (Date.now() - msPart) / 1000);
          this.metrics.setBufferLag(lagSec);
        }
      }
    } catch (err) {
      // Метрика — не критика, в логи и забыть.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug?.(`updatePendingMetrics: ${msg}`);
    }
  }
}

/* ─── helpers ─────────────────────────────────────────────────── */

type XReadGroupResult = Array<[string, Array<[string, string[]]>]>;

interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

function extractMessages(res: XReadGroupResult, stream: string): StreamMessage[] {
  for (const [s, entries] of res) {
    if (s !== stream) continue;
    return entries.map(([id, kv]) => ({
      id,
      fields: kvToObject(kv),
    }));
  }
  return [];
}

function kvToObject(kv: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < kv.length - 1; i += 2) {
    obj[kv[i]] = kv[i + 1];
  }
  return obj;
}

interface ParsedEntry {
  type: string;
  actorId: string;
  actorType: 'user' | 'guest';
  payload: Prisma.InputJsonValue;
  occurredAt: Date;
}

function parseFields(fields: Record<string, string>): ParsedEntry | null {
  const type = fields.type;
  const actorId = fields.actor_id;
  const actorTypeRaw = fields.actor_type;
  const payloadRaw = fields.payload ?? '{}';
  const occurredAtRaw = fields.occurred_at;

  if (
    typeof type !== 'string' || type.length === 0 || type.length > 64
    || typeof actorId !== 'string' || actorId.length === 0
    || (actorTypeRaw !== 'user' && actorTypeRaw !== 'guest')
  ) {
    return null;
  }
  let payload: Prisma.InputJsonValue;
  try {
    payload = JSON.parse(payloadRaw) as Prisma.InputJsonValue;
  } catch {
    payload = {};
  }
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return null;
  return { type, actorId, actorType: actorTypeRaw, payload, occurredAt };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
