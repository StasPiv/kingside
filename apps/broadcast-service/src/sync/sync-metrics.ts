import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Prometheus-метрики sync-цикла (ADR-022 §2.5).
 *
 * Регистрируются в общем `MetricsService.registry` — `/_/metrics` отдаёт всё.
 *
 *  - `broadcast_sync_cycles_total{kind,result}` — счётчик тиков
 *    full/pinned-poll с результатом ok|err|skipped.
 *  - `broadcast_sync_duration_seconds{kind}` — длительность тика.
 *  - `broadcast_sync_failures_total{kind,reason}` — счётчик фейлов
 *    (отдельно, чтобы быстрее делать алерт без фильтра по label result).
 *
 * На шаге 0 сами счётчики увеличиваются только точечно — полное
 * инструментирование sync-цикла детализируем в follow-up-тасках. Здесь
 * гарантируем, что метрики зарегистрированы и экспортируются.
 */
@Injectable()
export class SyncMetricsService {
  readonly broadcastSyncCyclesTotal: Counter<'kind' | 'result'>;
  readonly broadcastSyncDurationSeconds: Histogram<'kind'>;
  readonly broadcastSyncFailuresTotal: Counter<'kind' | 'reason'>;
  /**
   * KS-1735 / ADR-023 §5.4. Покрытие chess-results URL'ами на каждой
   * `upsertBroadcast`-операции. Дешёвый сигнал «достаточно ли > 50% top-20
   * broadcasts имеют chess-results URL, чтобы фича оправдывала запуск».
   */
  readonly crosstableCoverageTotal: Counter<'status'>;
  /**
   * KS-1735 / ADR-023 §5.4. Hostname'ы сторонних standings-источников —
   * диагностика «какие популярные сайты закрывают остальной 50%, кандидаты
   * для будущих парсеров».
   */
  readonly crosstableUnsupportedSourceTotal: Counter<'host'>;
  /**
   * KS-4832 / ADR-155 §2.4.6. Исходы pending-heal-проверок: pinned-цикл
   * запрашивает metadata раундов в `pending` окне и решает, промотать ли
   * их в `ongoing`. `promoted` — раунд перешёл в ongoing; `still_pending`
   * — Lichess подтверждает, что раунд ещё не идёт; `not_found` — 404 у
   * Lichess (раунд удалён); `err` — сетевые/429/парсинг-ошибки.
   */
  readonly broadcastSyncPendingChecksTotal: Counter<'result'>;
  /**
   * KS-4832 / ADR-155 §2.4.6. Задержка между заявленным `startsAt` раунда
   * и фактическим переводом в `ongoing` через pending-heal. Гистограмма
   * показывает эффективность heal — время «застревания» раунда.
   */
  readonly broadcastSyncPendingPromotionDelaySeconds: Histogram<never>;
  /**
   * KS-4832 / ADR-156 §2.3. Текущее число активных PGN-стримов
   * (`activeStreams.size`). Обновляется периодически из `broadcast-sync`,
   * gauge — снимок состояния, а не счётчик.
   */
  readonly broadcastStreamsActive: Gauge<never>;
  /**
   * KS-4832 / ADR-156 §2.3. Инкремент при каждом вызове `startStream()`.
   * `ok` — стрим запущен; `capacity_full` — уперлись в MAX_CONCURRENT_STREAMS;
   * `error` — исключение при старте; `already_active` — стрим уже был.
   */
  readonly broadcastStreamsStartedTotal: Counter<'result'>;
  /**
   * KS-4832 / ADR-156 §2.3, KS-4842 §1/§3. Инкремент при завершении стрима.
   *  - `round_finished` — Lichess закрыл поток штатно.
   *  - `aborted` — abort из-за перехода раунда в finished.
   *  - `error` — сетевые/парсинг-ошибки прервали цикл.
   *  - `rate_limit_429` — Lichess ответил 429, стрим остановлен.
   *  - `watchdog_stale` (KS-4842 §1) — сторожевой таймер закрыл стрим
   *    из-за молчания дольше `STREAM_WATCHDOG_TIMEOUT_SEC`.
   *  - `rotation` (KS-4842 §3) — плановое пересоздание всех активных
   *    стримов, следующий pinned-цикл поднимет их заново.
   */
  readonly broadcastStreamsEndedTotal: Counter<'reason'>;
  /**
   * KS-4842 §Метрики. Максимальный возраст последнего принятого байта
   * среди активных стримов (в секундах). Обновляется каждые 5 сек рядом
   * с `broadcast_streams_active`. Сигнал живучести пула: если пул
   * «жив», gauge должен колебаться в пределах порога watchdog'а.
   */
  readonly broadcastStreamsWatchdogMaxAge: Gauge<never>;
  /**
   * KS-4832 / ADR-156 §2.3. Длительность одной сессии стрима (сек). От
   * `startStream()` до выхода из основного `while` цикла `runStream()`.
   */
  readonly broadcastStreamDurationSeconds: Histogram<never>;

  constructor(metrics: MetricsService) {
    this.broadcastSyncCyclesTotal = new Counter({
      name: 'broadcast_sync_cycles_total',
      help: 'Количество завершённых циклов sync (full / pinned-poll).',
      labelNames: ['kind', 'result'] as const,
      registers: [metrics.registry],
    });

    this.broadcastSyncDurationSeconds = new Histogram({
      name: 'broadcast_sync_duration_seconds',
      help: 'Длительность одного тика sync в секундах.',
      labelNames: ['kind'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [metrics.registry],
    });

    this.broadcastSyncFailuresTotal = new Counter({
      name: 'broadcast_sync_failures_total',
      help: 'Количество фейлов в sync-цикле.',
      labelNames: ['kind', 'reason'] as const,
      registers: [metrics.registry],
    });

    this.crosstableCoverageTotal = new Counter({
      name: 'crosstable_coverage_total',
      help: 'Покрытие broadcast.standings_url chess-results-источником. ' +
        'matched=URL ведёт на chess-results.com (id извлечён); ' +
        'unsupported=URL есть, но другой домен; missing=URL пустой.',
      labelNames: ['status'] as const,
      registers: [metrics.registry],
    });

    this.crosstableUnsupportedSourceTotal = new Counter({
      name: 'crosstable_unsupported_source_total',
      help: 'Hostname сторонних standings-источников (для диагностики ' +
        'каких сайтов парсеры писать дальше). Кардинальность ограничена ' +
        'нормализацией: lower-case, www-префикс снят.',
      labelNames: ['host'] as const,
      registers: [metrics.registry],
    });

    this.broadcastSyncPendingChecksTotal = new Counter({
      name: 'broadcast_sync_pending_checks_total',
      help: 'Исходы pending-heal проверок раундов в pinned-цикле (ADR-155).',
      labelNames: ['result'] as const,
      registers: [metrics.registry],
    });

    this.broadcastSyncPendingPromotionDelaySeconds = new Histogram({
      name: 'broadcast_sync_pending_promotion_delay_seconds',
      help: 'Задержка между startsAt раунда и его переводом в ongoing ' +
        'через pending-heal (ADR-155).',
      buckets: [30, 60, 120, 300, 600, 1800, 3600, 21600, 86400],
      registers: [metrics.registry],
    });

    this.broadcastStreamsActive = new Gauge({
      name: 'broadcast_streams_active',
      help: 'Число активных PGN-стримов (activeStreams.size).',
      registers: [metrics.registry],
    });

    this.broadcastStreamsStartedTotal = new Counter({
      name: 'broadcast_streams_started_total',
      help: 'Количество попыток запуска PGN-стрима, по исходу (ADR-156).',
      labelNames: ['result'] as const,
      registers: [metrics.registry],
    });

    this.broadcastStreamsEndedTotal = new Counter({
      name: 'broadcast_streams_ended_total',
      help: 'Количество завершений PGN-стрима, по причине (ADR-156).',
      labelNames: ['reason'] as const,
      registers: [metrics.registry],
    });

    this.broadcastStreamDurationSeconds = new Histogram({
      name: 'broadcast_stream_duration_seconds',
      help: 'Длительность одной сессии PGN-стрима в секундах (ADR-156).',
      buckets: [1, 5, 15, 60, 300, 900, 1800, 3600, 21600],
      registers: [metrics.registry],
    });

    this.broadcastStreamsWatchdogMaxAge = new Gauge({
      name: 'broadcast_streams_watchdog_last_byte_age_seconds',
      help: 'Максимальный возраст последнего принятого байта среди ' +
        'активных стримов (KS-4842). Показывает живучесть пула.',
      registers: [metrics.registry],
    });
  }

  recordCycle(kind: 'full' | 'pinned', result: 'ok' | 'err' | 'skipped'): void {
    this.broadcastSyncCyclesTotal.inc({ kind, result });
  }

  observeDuration(kind: 'full' | 'pinned', durationSec: number): void {
    this.broadcastSyncDurationSeconds.observe({ kind }, durationSec);
  }

  recordFailure(kind: 'full' | 'pinned', reason: string): void {
    this.broadcastSyncFailuresTotal.inc({ kind, reason });
  }

  /**
   * Регистрирует одну `upsertBroadcast`-операцию в coverage-метрику.
   * `host` опционален — публикуется только для `unsupported` (см.
   * `crosstableUnsupportedSourceTotal`).
   */
  recordCrosstableCoverage(
    status: 'matched' | 'unsupported' | 'missing',
    host: string | null,
  ): void {
    this.crosstableCoverageTotal.inc({ status });
    if (status === 'unsupported' && host) {
      this.crosstableUnsupportedSourceTotal.inc({ host });
    }
  }

  /** KS-4832 / ADR-155 §2.4.6. Инкремент по итогу одной pending-проверки. */
  recordPendingCheck(
    result: 'promoted' | 'still_pending' | 'not_found' | 'err',
  ): void {
    this.broadcastSyncPendingChecksTotal.inc({ result });
  }

  /**
   * KS-4832 / ADR-155 §2.4.6. Наблюдение задержки промоушена. `delaySec`
   * может быть отрицательным (промотили раньше объявленного startsAt) —
   * в этом случае наблюдение пропускается, чтобы не портить гистограмму.
   */
  observePendingPromotionDelay(delaySec: number): void {
    if (delaySec < 0) return;
    this.broadcastSyncPendingPromotionDelaySeconds.observe(delaySec);
  }

  /** KS-4832 / ADR-156 §2.3. Установить текущее число активных стримов. */
  setStreamsActive(count: number): void {
    this.broadcastStreamsActive.set(count);
  }

  /** KS-4832 / ADR-156 §2.3. Инкремент по итогу вызова startStream(). */
  recordStreamStarted(
    result: 'ok' | 'capacity_full' | 'error' | 'already_active',
  ): void {
    this.broadcastStreamsStartedTotal.inc({ result });
  }

  /** KS-4832 / ADR-156 §2.3, KS-4842 §1/§3. Инкремент при завершении стрима. */
  recordStreamEnded(
    reason:
      | 'round_finished'
      | 'aborted'
      | 'error'
      | 'rate_limit_429'
      | 'watchdog_stale'
      | 'rotation',
  ): void {
    this.broadcastStreamsEndedTotal.inc({ reason });
  }

  /**
   * KS-4842 §Метрики. Установить максимум `Date.now() - lastByteAt` по
   * активным стримам (в секундах). Вызывается каждые 5 сек рядом с
   * `setStreamsActive`.
   */
  setStreamsWatchdogMaxAge(seconds: number): void {
    this.broadcastStreamsWatchdogMaxAge.set(seconds);
  }

  /** KS-4832 / ADR-156 §2.3. Наблюдение длительности сессии стрима. */
  observeStreamDuration(durationSec: number): void {
    if (durationSec < 0) return;
    this.broadcastStreamDurationSeconds.observe(durationSec);
  }
}
