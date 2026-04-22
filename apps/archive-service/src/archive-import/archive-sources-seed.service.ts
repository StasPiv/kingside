import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Дефолтный каталог источников архива, сидируемый на bootstrap
 * importer-once (KS-1716, ADR-020 §1.4).
 *
 * ПОЧЕМУ СЕЙЧАС НЕ МИГРАЦИЯ: Prisma data-миграции в этом пакете (`packages/archive-db`)
 * в prod-deploy-пайплайне archive-service автоматически НЕ применяются — скрипт
 * `prisma:migrate` из `package.json` — это `prisma migrate dev` (локально).
 * Сид через ORM upsert на старте importer-once обеспечивает идемпотентную
 * регистрацию без зависимости от инфра-скриптов devops'а.
 *
 * Расширение: добавить новый источник — одна запись в массиве. Первый
 * scheduler-invocation после деплоя сделает upsert; существующая запись
 * с тем же `code` не перезаписывается (update={}), чтобы ручные правки
 * оператора в БД (например, корректировка `cursor` через `cli:import-twic-issue`
 * или пересчёт `schedule`) не откатывались каждый день.
 */
export interface ArchiveSourceSeed {
  code: string;
  kind: string;
  name: string;
  enabled: boolean;
  /**
   * Cron в формате, поддерживаемом `intervalFromSchedule` (KS-1676 MVP):
   *   `*\/N * * * *`    — каждые N минут
   *   `0 *\/N * * *`    — каждые N часов
   * Любые другие формы парсятся fallback-ом в 60 минут.
   *
   * Для TWIC недельный интервал: `0 *\/168 * * *` = 168 часов = 7 суток.
   * isDue() сработает при `now - lastRunAt >= 7 суток` (ADR-020 §1.4).
   */
  schedule: string;
  url: string | null;
}

export const DEFAULT_ARCHIVE_SOURCES: ArchiveSourceSeed[] = [
  {
    code: 'twic',
    kind: 'twic',
    name: 'The Week in Chess',
    enabled: true,
    // Раз в неделю (168 часов). Scheduler EventBridge дёргает importer-once
    // ежедневно (ADR-020 §2.3); isDue() пропускает не-due дни.
    schedule: '0 */168 * * *',
    url: 'https://theweekinchess.com/',
  },
];

/**
 * Идемпотентный bootstrap-сид реестра `archive_sources`.
 *
 * Вызывается из `runImporterOnce()` перед `tickOnce()` каждый scheduler-invocation.
 * `upsert` по уникальному `code`: создаёт запись при отсутствии, не трогает
 * существующую. Это важно: оператор может править `schedule`/`cursor`/`enabled`
 * в проде через `cli:import-twic-issue` или прямым SQL — эти правки не должны
 * откатываться при каждом cron-tick'е.
 */
@Injectable()
export class ArchiveSourcesSeedService {
  private readonly logger = new Logger(ArchiveSourcesSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaults(
    sources: ArchiveSourceSeed[] = DEFAULT_ARCHIVE_SOURCES,
  ): Promise<{ created: number; kept: number }> {
    let created = 0;
    let kept = 0;
    for (const seed of sources) {
      const existing = await this.prisma.archiveSource.findUnique({
        where: { code: seed.code },
        select: { id: true },
      });
      if (existing) {
        kept += 1;
        continue;
      }
      await this.prisma.archiveSource.create({
        data: {
          code: seed.code,
          kind: seed.kind,
          name: seed.name,
          enabled: seed.enabled,
          schedule: seed.schedule,
          url: seed.url,
        },
      });
      created += 1;
      this.logger.log(
        `Seeded archive_source: code=${seed.code} kind=${seed.kind} schedule="${seed.schedule}"`,
      );
    }
    if (created === 0) {
      this.logger.log(
        `archive_sources already seeded (${kept} of ${sources.length}); nothing to do`,
      );
    }
    return { created, kept };
  }
}
