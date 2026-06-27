/**
 * KS-4695 / ADR-147 §2.2. Два отдельных PrismaClient к `@kingside/events-db`:
 *
 *   - **WriterPrisma** под учёткой `events_writer`. Минимальные права
 *     (USAGE на schema events, INSERT/SELECT на таблицы и matviews,
 *     USAGE/SELECT на sequence). Используется EventsWriterService
 *     для batch INSERT в `events.actor_events`.
 *   - **OwnerPrisma** под учёткой владельца БД (`EVENTS_DATABASE_URL`).
 *     Используется MatViewRefreshService для `REFRESH MATERIALIZED
 *     VIEW CONCURRENTLY` — это привилегированная операция, writer'у не
 *     разрешена.
 *
 * URL для writer'а собирается в рантайме из host/port/db основного
 * `EVENTS_DATABASE_URL` + пользователя `events_writer` + пароля из env
 * `EVENTS_WRITER_PASSWORD` (KS-4692 — secret в Secrets Manager). В коде
 * храним сборку, не хардкод — пароль никогда не попадает в логи.
 *
 * Если env не заданы (локальный dev без events-infra) — клиенты
 * НЕ создаются, `EventsWriterService` и `MatViewRefreshService`
 * detect'ят это через `null` и переходят в no-op. См. их собственные
 * `onModuleInit`.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient as EventsPrismaClient } from '@kingside/events-db';

@Injectable()
export class EventsPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsPrismaService.name);

  /** Клиент под учёткой events_writer (INSERT). `null` — events
   *  не сконфигурирован (нет EVENTS_WRITER_PASSWORD или EVENTS_DATABASE_URL). */
  private writer: EventsPrismaClient | null = null;

  /** Клиент под owner-ролью (REFRESH MV). `null` — нет EVENTS_DATABASE_URL. */
  private owner: EventsPrismaClient | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const ownerUrl = this.config.get<string>('EVENTS_DATABASE_URL') ?? null;
    const writerPassword = this.config.get<string>('EVENTS_WRITER_PASSWORD') ?? null;

    if (!ownerUrl) {
      this.logger.warn(
        'EVENTS_DATABASE_URL не задан — EventsModule работает в no-op режиме '
          + '(локальный dev без events-infra).',
      );
      return;
    }

    this.owner = new EventsPrismaClient({ datasourceUrl: ownerUrl });

    if (!writerPassword) {
      this.logger.warn(
        'EVENTS_WRITER_PASSWORD не задан — writer-PrismaClient использует ту же роль, '
          + 'что и refresher (owner). Допустимо для локали; в проде задаётся секретом.',
      );
      this.writer = new EventsPrismaClient({ datasourceUrl: ownerUrl });
    } else {
      const writerUrl = swapUserAndPassword(ownerUrl, 'events_writer', writerPassword);
      this.writer = new EventsPrismaClient({ datasourceUrl: writerUrl });
    }

    this.logger.log('EventsPrismaService: writer + owner clients готовы.');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.writer?.$disconnect(),
      this.owner?.$disconnect(),
    ]);
  }

  /** Возвращает writer-клиент. `null` — events не сконфигурированы. */
  getWriter(): EventsPrismaClient | null {
    return this.writer;
  }

  /** Возвращает owner-клиент. `null` — events не сконфигурированы. */
  getOwner(): EventsPrismaClient | null {
    return this.owner;
  }
}

/**
 * Заменяет user:password в DSN на заданные. Хост/порт/dbname/query —
 * сохраняются как есть. Парсинг через `URL`, чтобы корректно обработать
 * percent-encoded password (бывают спец-символы).
 *
 * Экспортирован для unit-теста — основная функция приватна по смыслу.
 */
export function swapUserAndPassword(dsn: string, user: string, password: string): string {
  const u = new URL(dsn);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}
