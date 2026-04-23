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
 * Поведение по `code`:
 *   - нет записи → создать со всеми полями из seed;
 *   - есть запись → НЕ трогать `schedule`/`cursor`/`url`/`name`/`kind`, чтобы
 *     оператор-правки (через `cli:import-twic-issue` или прямой SQL) не
 *     откатывались при каждом cron-tick'е;
 *   - есть запись, `seed.enabled=true` И `existing.enabled=false` → heal-up:
 *     выставить `enabled=true`. Это однонаправленная починка «дотянуть до
 *     seed-default», НЕ симметричный force-overwrite:
 *     - если seed.enabled=true и existing.enabled=false — heal (включаем);
 *     - если seed.enabled=false и existing.enabled=true — НЕ трогаем
 *       (оператор вручную включил источник, который мы по дефолту считаем
 *       отключённым; его решение весомее defaults);
 *     - если значения совпадают — НЕ трогаем.
 *
 * Почему heal-up именно для `enabled=true` нужен: без `enabled=true`
 * `archiveSource.findMany({where:{enabled:true}})` не вернёт запись,
 * catalog-метрика `LastSuccessAgeSeconds{source=<code>}` не эмитится и
 * CloudWatch alarm A4 застревает в ALARM (KS-1716, итерация 3 — реальный
 * прод-репорт: сид отрапортовал `kept=1`, но `findMany({enabled:true})`
 * вернул пусто, т.к. запись сохранена с `enabled=false` от предыдущей
 * версии кода). Heal применим только к полю `enabled` — остальные поля
 * описывают конфигурацию, которую оператор может менять легитимно.
 */
@Injectable()
export class ArchiveSourcesSeedService {
  private readonly logger = new Logger(ArchiveSourcesSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaults(
    sources: ArchiveSourceSeed[] = DEFAULT_ARCHIVE_SOURCES,
  ): Promise<{ created: number; kept: number; healed: number }> {
    let created = 0;
    let kept = 0;
    let healed = 0;
    for (const seed of sources) {
      const existing = await this.prisma.archiveSource.findUnique({
        where: { code: seed.code },
        select: { id: true, enabled: true },
      });
      if (existing) {
        kept += 1;
        // KS-1716: heal-up `enabled` (однонаправленный: только false→true).
        // Если существующая запись имеет `enabled=false` (результат прошлой
        // версии сида / миграции / прямого SQL-вмешательства), а seed
        // объявляет `enabled=true` — восстанавливаем true, иначе catalog-emit
        // не опубликует метрику. Обратное направление (seed=false, existing=
        // true) НЕ чиним — это валидная оператор-правка «включить источник,
        // который мы по дефолту считаем отключённым». Остальные поля не
        // трогаем в любом случае.
        if (seed.enabled && !existing.enabled) {
          await this.prisma.archiveSource.update({
            where: { id: existing.id },
            data: { enabled: true },
          });
          healed += 1;
          this.logger.log(
            `archive_source healed: code=${seed.code} enabled:false→true`,
          );
        }
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
    if (created === 0 && healed === 0) {
      this.logger.log(
        `archive_sources already seeded (${kept} of ${sources.length}); nothing to do`,
      );
    }
    return { created, kept, healed };
  }
}
