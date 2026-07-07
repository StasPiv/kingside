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
   * KS-4846 / ADR-157 §2.4.1. Счётчик исходящих запросов к Lichess,
   * инкремент в единой точке `lichessFetch()`. После KS-4859 / ADR-159
   * label `round_stream_open` больше не пишется (стримов нет).
   *  - `endpoint` ∈ {`broadcasts_list`, `round_metadata`, `round_pgn`,
   *    `round_stream_open`, `pending_metadata`}.
   *  - `status` ∈ {`200`, `400`, `401`, `404`, `429`, `5xx`, `timeout`,
   *    `abort`, `err`} — низкая кардинальность.
   */
  readonly broadcastLichessRequestsTotal: Counter<'endpoint' | 'status'>;
  /**
   * KS-4846 / ADR-157 §2.4.2. Число активных WS-подписок на комнату
   * `broadcast:<roundId>` (агрегировано по репликам через Redis-хеш
   * `broadcast:ws-subs`). Обновляется периодически из `runFastPollTick`.
   * Label `round` = `lichessRoundId`. Удаляется при переходе раунда в
   * `finished` (или суточным сбросом).
   */
  readonly broadcastWsActiveSubscriptions: Gauge<'round'>;

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

    this.broadcastLichessRequestsTotal = new Counter({
      name: 'broadcast_lichess_requests_total',
      help: 'Количество исходящих запросов к Lichess по endpoint и HTTP-статусу ' +
        '(ADR-157 §2.4.1). Единая точка инкремента в lichessFetch и на open в runStream.',
      labelNames: ['endpoint', 'status'] as const,
      registers: [metrics.registry],
    });

    this.broadcastWsActiveSubscriptions = new Gauge({
      name: 'broadcast_ws_active_subscriptions',
      help: 'Число активных WS-подписок на раунд (ADR-157 §2.4.2). ' +
        'Агрегировано по репликам через Redis-хеш broadcast:ws-subs.',
      labelNames: ['round'] as const,
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

  /** KS-4846 / ADR-157 §2.4.1. Один исходящий запрос к Lichess. */
  recordLichessRequest(
    endpoint:
      | 'broadcasts_list'
      | 'round_metadata'
      | 'round_pgn'
      | 'round_stream_open'
      | 'pending_metadata',
    status:
      | '200'
      | '400'
      | '401'
      | '404'
      | '429'
      | '5xx'
      | 'timeout'
      | 'abort'
      | 'err',
  ): void {
    this.broadcastLichessRequestsTotal.inc({ endpoint, status });
  }

  /** KS-4846 / ADR-157 §2.4.2. Установить gauge WS-подписок для раунда. */
  setWsActiveSubscriptions(round: string, count: number): void {
    this.broadcastWsActiveSubscriptions.set({ round }, count);
  }

  /** KS-4846 / ADR-157 §2.4.2. Удалить gauge WS-подписок (раунд завершён). */
  removeWsActiveSubscription(round: string): void {
    this.broadcastWsActiveSubscriptions.remove({ round });
  }

}
