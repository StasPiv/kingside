import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { ArchiveBucket } from '@kingside/shared';

/**
 * Центральный Prometheus registry для всего API.
 *
 * Отдельный `Registry` (а не `register` default из prom-client) — чтобы:
 *   1. В тестах можно было создавать чистый экземпляр без глобальных
 *      побочных эффектов (если понадобится).
 *   2. Логически собрать все метрики API в одном месте.
 *
 * Метрики:
 *   - archive_tree_list_mismatch_total{bucket}              — counter
 *   - archive_games_list_position_not_indexed_total{bucket} — counter
 *   - archive_tree_query_duration_seconds{cache_hit}        — histogram
 *   - archive_tree_cache_hit_ratio                          — gauge
 *
 * Также через `collectDefaultMetrics` собираются стандартные process-метрики
 * (event loop, память, fd) — они полезны для общего прод-мониторинга.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry: Registry;

  readonly archiveTreeListMismatchTotal: Counter<'bucket'>;
  readonly archiveGamesListPositionNotIndexedTotal: Counter<'bucket'>;
  readonly archiveTreeQueryDurationSeconds: Histogram<'cache_hit'>;
  readonly archiveTreeCacheHitRatio: Gauge<string>;

  /**
   * KS-2305 (ADR-039 §4). Счётчик успешно выданных JWT-токенов
   * `__screenshot_agent` (внутренний endpoint screenshot-tool'а).
   *
   * Label `ip` — для отслеживания подозрительных всплесков с одного
   * адреса. Cardinality ок: endpoint вызывает один tool из одного-двух
   * фиксированных IP (CI runner / dev-box), поэтому `ip` не порождает
   * взрыв timeseries (как было бы у user-facing endpoint).
   */
  readonly screenshotTokenIssuedTotal: Counter<'ip'>;

  /**
   * KS-3734 / ADR-110 §2.9.14. Метрики live-трансляции анализа.
   *
   * - `live_analysis_active_total` (gauge) — текущее число active-трансляций.
   *   Источник: cleanup-tick (после удаления просроченных пересчитывает),
   *   плюс инкремент/декремент на create/close.
   * - `live_analysis_viewers_total` (gauge) — суммарно зрителей по всем
   *   active. Обновляется gateway-ом на subscribe/unsubscribe.
   * - `live_analysis_moves_total` (counter) — суммарное число принятых
   *   ходов автора (после валидации). Метка `outcome` — `accepted` или
   *   `illegal`.
   * - `live_analysis_rate_limited_total` (counter) — отказы по любому
   *   лимиту. Метка `reason`: `author_moves` (token-bucket), `viewers_cap`
   *   (1000 viewers на трансляцию), `ip_conns` (10 коннектов с IP).
   * - `live_analysis_cleanup_closed_total` (counter) — сколько трансляций
   *   закрыто cleanup-job'ом за всё время.
   */
  readonly liveAnalysisActiveTotal: Gauge<string>;
  readonly liveAnalysisViewersTotal: Gauge<string>;
  readonly liveAnalysisMovesTotal: Counter<'outcome'>;
  readonly liveAnalysisRateLimitedTotal: Counter<'reason'>;
  readonly liveAnalysisCleanupClosedTotal: Counter<string>;

  /**
   * KS-3745 / ADR-111 §8. Метрики state-patch-потока.
   *
   * - `live_analysis_state_patches_total` (counter) — успешно
   *   применённые патчи (после валидации и записи в Redis).
   * - `live_analysis_state_patch_bytes_sum` (counter) — суммарный
   *   размер принятых PGN в байтах. Деление на счётчик патчей даёт
   *   среднюю длину в Grafana без отдельного histogram'а.
   * - `live_analysis_state_patch_rejected_total{reason}` (counter)
   *   отказы. Допустимые значения `reason`:
   *     pgn_too_large | invalid_pgn | rate_limit | forbidden.
   */
  readonly liveAnalysisStatePatchesTotal: Counter<string>;
  readonly liveAnalysisStatePatchBytesSum: Counter<string>;
  readonly liveAnalysisStatePatchRejectedTotal: Counter<'reason'>;

  /**
   * KS-3762 / ADR-112 §8. Метрики binding live-трансляции к Analysis.
   *
   * - `live_analysis_created_total{with_analysis_id="true|false"}`
   *   (counter) — успешно созданные трансляции. Label `with_analysis_id`
   *   позволяет отделить нормальный поток (`true`, после ADR-112) от
   *   аномальных создаваемых без binding (`false` — должно стремиться
   *   к нулю; рост сигнализирует о баге или regression).
   * - `live_analysis_zombie_closed_at_migration_total` (gauge) —
   *   сколько трансляций было закрыто data-cleanup'ом миграции KS-3757
   *   (исторические записи ADR-110 без `analysisId`). Значение
   *   проставляется один раз при инициализации модуля через
   *   `SELECT COUNT(*) WHERE status='closed' AND analysis_id IS NULL`
   *   и не меняется в рантайме (миграция применяется единожды).
   */
  readonly liveAnalysisCreatedTotal: Counter<'with_analysis_id'>;
  readonly liveAnalysisZombieClosedAtMigrationTotal: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Process-метрики (cpu, memory, event-loop). Делать это идемпотентно:
    // второй `collectDefaultMetrics` на тот же registry — no-op (prom-client
    // сам защищает), но лишние импорты не хочется тянуть.
    collectDefaultMetrics({ register: this.registry });

    this.archiveTreeListMismatchTotal = new Counter({
      name: 'archive_tree_list_mismatch_total',
      help:
        'Количество срабатываний fail-closed guard в /archive/games/by-position ' +
        '(items=[] && totalApprox>0). Инвариант #3 из ADR-016.',
      labelNames: ['bucket'] as const,
      registers: [this.registry],
    });

    this.archiveGamesListPositionNotIndexedTotal = new Counter({
      name: 'archive_games_list_position_not_indexed_total',
      help:
        'Количество запросов /archive/games/by-position, где позиция не ' +
        'индексирована в archive_game_positions (ply за пределами лимита).',
      labelNames: ['bucket'] as const,
      registers: [this.registry],
    });

    this.archiveTreeQueryDurationSeconds = new Histogram({
      name: 'archive_tree_query_duration_seconds',
      help: 'Длительность запроса /archive/tree и /archive/games/by-position в секундах.',
      labelNames: ['cache_hit'] as const,
      // Бакеты нацелены на типичные p50..p99 кэш-хитов (мс) и промахов
      // (сотни мс — SQL-путь). Если прод-профиль отклонится, скорректируем.
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.archiveTreeCacheHitRatio = new Gauge({
      name: 'archive_tree_cache_hit_ratio',
      help: 'Текущая доля cache-hit для archive-tree запросов [0..1].',
      registers: [this.registry],
    });

    // KS-2305 (ADR-039 §4): screenshot-token-issued counter.
    this.screenshotTokenIssuedTotal = new Counter({
      name: 'screenshot_token_issued_total',
      help:
        'Количество успешно выданных JWT-токенов screenshot-агенту через ' +
        'POST /internal/screenshot-token (ADR-039 §4). Label ip — для ' +
        'отслеживания всплесков; ожидаем одно-два значений в проде.',
      labelNames: ['ip'] as const,
      registers: [this.registry],
    });

    // KS-3734 / ADR-110 §2.9.14: live-analysis метрики.
    this.liveAnalysisActiveTotal = new Gauge({
      name: 'live_analysis_active_total',
      help: 'Текущее число активных live-трансляций анализа (status=active).',
      registers: [this.registry],
    });
    this.liveAnalysisViewersTotal = new Gauge({
      name: 'live_analysis_viewers_total',
      help:
        'Текущее суммарное число подключённых зрителей по всем активным ' +
        'live-трансляциям анализа.',
      registers: [this.registry],
    });
    this.liveAnalysisMovesTotal = new Counter({
      name: 'live_analysis_moves_total',
      help:
        'Принятые/отклонённые ходы автора live-трансляции. Label outcome: ' +
        'accepted | illegal.',
      labelNames: ['outcome'] as const,
      registers: [this.registry],
    });
    this.liveAnalysisRateLimitedTotal = new Counter({
      name: 'live_analysis_rate_limited_total',
      help:
        'Отказы по лимитам live-трансляции. Label reason: author_moves ' +
        '(token-bucket автора) | viewers_cap (1000 на трансляцию) | ' +
        'ip_conns (10 WS-коннектов с одного IP).',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });
    this.liveAnalysisCleanupClosedTotal = new Counter({
      name: 'live_analysis_cleanup_closed_total',
      help:
        'Сколько live-трансляций закрыто cleanup-job’ом по неактивности ' +
        '(lastActivityAt < NOW() - 30 min).',
      registers: [this.registry],
    });

    // KS-3745 / ADR-111 §8: state-patch counters.
    this.liveAnalysisStatePatchesTotal = new Counter({
      name: 'live_analysis_state_patches_total',
      help:
        'Количество успешно применённых state-patch-событий от авторов ' +
        'live-трансляций (после валидации и записи в Redis).',
      registers: [this.registry],
    });
    this.liveAnalysisStatePatchBytesSum = new Counter({
      name: 'live_analysis_state_patch_bytes_sum',
      help:
        'Суммарный размер принятых annotated-PGN в state-patch (байты). ' +
        'Делением на live_analysis_state_patches_total получаем среднюю ' +
        'длину payload без выделенного гистограммного timeseries.',
      registers: [this.registry],
    });
    this.liveAnalysisStatePatchRejectedTotal = new Counter({
      name: 'live_analysis_state_patch_rejected_total',
      help:
        'Отказы по state-patch. Label reason: pgn_too_large | ' +
        'invalid_pgn | rate_limit | forbidden.',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    // KS-3762 / ADR-112 §8: binding-метрики.
    this.liveAnalysisCreatedTotal = new Counter({
      name: 'live_analysis_created_total',
      help:
        'Количество созданных live-трансляций. Label with_analysis_id: ' +
        '"true" — нормальный поток с binding к Analysis (ADR-112); ' +
        '"false" — аномалия, должно стремиться к нулю.',
      labelNames: ['with_analysis_id'] as const,
      registers: [this.registry],
    });
    this.liveAnalysisZombieClosedAtMigrationTotal = new Gauge({
      name: 'live_analysis_zombie_closed_at_migration_total',
      help:
        'Сколько живых трансляций без binding к Analysis было ' +
        'принудительно закрыто data-cleanup-ом миграции KS-3757 (ADR-112 §6). ' +
        'Значение проставляется при инициализации модуля и не меняется ' +
        'в рантайме.',
      registers: [this.registry],
    });
  }

  async onModuleInit(): Promise<void> {
    // Nothing async on boot — registry inited in constructor. Hook resrved
    // для будущего динамического enable/disable без рестарта.
  }

  /** Инкремент `archive_tree_list_mismatch_total{bucket}`. */
  incListMismatch(bucket: ArchiveBucket): void {
    this.archiveTreeListMismatchTotal.inc({ bucket });
  }

  /** Инкремент `archive_games_list_position_not_indexed_total{bucket}`. */
  incPositionNotIndexed(bucket: ArchiveBucket): void {
    this.archiveGamesListPositionNotIndexedTotal.inc({ bucket });
  }

  /** Запись длительности `archive_tree_query_duration_seconds{cache_hit}`. */
  observeTreeQueryDuration(cacheHit: boolean, durationSec: number): void {
    this.archiveTreeQueryDurationSeconds.observe(
      { cache_hit: cacheHit ? 'true' : 'false' },
      durationSec,
    );
  }

  /** Устанавливает текущий ratio (0..1). */
  setTreeCacheHitRatio(ratio: number): void {
    this.archiveTreeCacheHitRatio.set(ratio);
  }

  /** KS-2305: инкремент `screenshot_token_issued_total{ip}`. */
  incScreenshotTokenIssued(ip: string): void {
    this.screenshotTokenIssuedTotal.inc({ ip });
  }

  // ─── KS-3734 / ADR-110: live-analysis ──────────────────────────────

  /** Установить текущее значение `live_analysis_active_total`. */
  setLiveAnalysisActive(count: number): void {
    this.liveAnalysisActiveTotal.set(count);
  }
  /** Инкремент `live_analysis_active_total` на create. */
  incLiveAnalysisActive(): void {
    this.liveAnalysisActiveTotal.inc();
  }
  /** Декремент `live_analysis_active_total` на close. */
  decLiveAnalysisActive(): void {
    this.liveAnalysisActiveTotal.dec();
  }
  /** Инкремент суммарных зрителей. */
  incLiveAnalysisViewers(by = 1): void {
    this.liveAnalysisViewersTotal.inc(by);
  }
  /** Декремент суммарных зрителей. */
  decLiveAnalysisViewers(by = 1): void {
    this.liveAnalysisViewersTotal.dec(by);
  }
  /** Принятый ход автора. */
  incLiveAnalysisMoveAccepted(): void {
    this.liveAnalysisMovesTotal.inc({ outcome: 'accepted' });
  }
  /** Нелегальный/некорректный ход. */
  incLiveAnalysisMoveIllegal(): void {
    this.liveAnalysisMovesTotal.inc({ outcome: 'illegal' });
  }
  /** Срабатывание любого rate-limit'а. */
  incLiveAnalysisRateLimited(reason: 'author_moves' | 'viewers_cap' | 'ip_conns'): void {
    this.liveAnalysisRateLimitedTotal.inc({ reason });
  }
  /** Cleanup-tick закрыл одну трансляцию по неактивности. */
  incLiveAnalysisCleanupClosed(by = 1): void {
    this.liveAnalysisCleanupClosedTotal.inc(by);
  }

  // ─── KS-3745 / ADR-111: state-patch ────────────────────────────────

  /** Принят state-patch + добавить размер payload в bytes_sum. */
  incLiveAnalysisStatePatchAccepted(bytes: number): void {
    this.liveAnalysisStatePatchesTotal.inc();
    if (Number.isFinite(bytes) && bytes >= 0) {
      this.liveAnalysisStatePatchBytesSum.inc(bytes);
    }
  }

  /** Отказ по причине: pgn_too_large | invalid_pgn | rate_limit | forbidden. */
  incLiveAnalysisStatePatchRejected(
    reason: 'pgn_too_large' | 'invalid_pgn' | 'rate_limit' | 'forbidden',
  ): void {
    this.liveAnalysisStatePatchRejectedTotal.inc({ reason });
  }

  // ─── KS-3762 / ADR-112: binding metrics ───────────────────────────

  /** Создана трансляция; `withAnalysisId=true` — есть binding к Analysis. */
  incLiveAnalysisCreated(withAnalysisId: boolean): void {
    this.liveAnalysisCreatedTotal.inc({
      with_analysis_id: withAnalysisId ? 'true' : 'false',
    });
  }

  /** Установить число «зомби», закрытых миграцией KS-3757 (вызывается единожды на старте). */
  setLiveAnalysisZombieClosedAtMigration(count: number): void {
    this.liveAnalysisZombieClosedAtMigrationTotal.set(count);
  }

  /**
   * Экспорт в Prometheus text-формате (`# HELP` / `# TYPE` / сэмплы).
   */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content-Type, который ожидает Prometheus scrape. */
  get contentType(): string {
    return this.registry.contentType;
  }
}
