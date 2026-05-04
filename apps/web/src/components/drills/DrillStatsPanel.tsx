import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TacticDrillStatsResponse,
  TacticDrillType,
} from '@kingside/shared';

import { api } from '../../api';

/**
 * KS-2236 (ADR-035 §7, E3) — панель статистики тренажёров для
 * собственного профиля.
 *
 * Загружает `GET /tactic-drill/stats/me` (требует JWT) и рендерит:
 *   • summary-блок «Попыток / Решено / Точность» из total;
 *   • таблицу по drill-типам (8 строк) с колонками
 *     accuracy / avg time / count + бейджем unlocked/locked;
 *   • опционально CTA «Открыть тренажёр» (`/drills`) — навигация
 *     обратно в лобби.
 *
 * Контракт виден только владельцу аккаунта (endpoint `/me`). Гостевой
 * рендер чужого профиля не должен подключать этот компонент — он
 * упадёт 401-кой и покажет error-стейт.
 *
 * # Контракт DOM
 *
 *   <section class="drill-stats-panel" data-testid="drill-stats-panel"
 *            data-state="loading|empty|loaded|error">
 *     <h2 class="drill-stats-panel__heading">…</h2>
 *     <div class="drill-stats-panel__summary">…</div>
 *     <table class="drill-stats-panel__table">
 *       <thead>…</thead>
 *       <tbody>
 *         <tr data-drill-type="<id>" data-unlocked="true|false">…</tr>
 *         …
 *       </tbody>
 *     </table>
 *   </section>
 */

const DRILL_ORDER: TacticDrillType[] = [
  'count-attackers',
  'find-loose-piece',
  'find-hanging-piece',
  'find-all-checks',
  'find-pin',
  'find-fork',
  'find-undefended-attack',
];

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function formatAccuracy(v: number): string {
  // 0..1 → проценты с одной десятой (если ≥ 10%) или integer.
  const pct = v * 100;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct > 0) return `${pct.toFixed(1)}%`;
  return '—';
}

function formatAvgTime(ms: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  return sec < 10 ? `${sec.toFixed(1)} s` : `${Math.round(sec)} s`;
}

function formatIou(v: number | undefined): string {
  if (v === undefined || v === null) return '—';
  return v.toFixed(2);
}

export interface DrillStatsPanelProps {
  /**
   * Опциональный CTA-link «Открыть тренажёр» — показывается, если задан
   * `lobbyHref` (по умолчанию — `/drills`). Передай `null`, чтобы скрыть
   * кнопку (например, для embedded-сценария).
   */
  lobbyHref?: string | null;
}

export function DrillStatsPanel({ lobbyHref = '/drills' }: DrillStatsPanelProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<TacticDrillStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // KS-2236: используем `.then(success, fail)` вместо `.then().catch()`
    // — fail-handler привязан к исходному promise напрямую, без
    // промежуточного rejected-promise в чейне. Без этого vitest 4 в
    // тестовом окружении считает rejected-promise unhandled (даже если
    // .catch повешен на следующий tick).
    api.get<TacticDrillStatsResponse>('/tactic-drill/stats/me').then(
      (r) => {
        if (!cancelled) setData(r);
      },
      () => {
        if (!cancelled) setError('loadFailed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Сортируем byType по фиксированному порядку освоения (methodology §4).
  // Если backend вернул не все 8 — строки заполняются нулями (защита от
  // расхождения версий).
  const rows = useMemo(() => {
    if (!data) return [];
    const map = new Map(data.byType.map((it) => [it.drillType, it]));
    return DRILL_ORDER.map((type) => {
      const fallback = {
        drillType: type,
        attempts: 0,
        solved: 0,
        accuracy: 0,
        avgTimeMs: 0,
        avgIou: undefined,
      };
      return map.get(type) ?? fallback;
    });
  }, [data]);

  const unlockedSet = useMemo(
    () => new Set(data?.unlocked ?? []),
    [data?.unlocked],
  );

  if (error) {
    return (
      <section
        className="drill-stats-panel drill-stats-panel--error"
        data-testid="drill-stats-panel"
        data-state="error"
      >
        <h2 className="drill-stats-panel__heading">
          {t('drills.stats.heading', 'Drill stats')}
        </h2>
        <p className="drill-stats-panel__error">
          {t('drills.stats.loadFailed', 'Could not load drill stats.')}
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section
        className="drill-stats-panel drill-stats-panel--loading"
        data-testid="drill-stats-panel"
        data-state="loading"
      >
        <h2 className="drill-stats-panel__heading">
          {t('drills.stats.heading', 'Drill stats')}
        </h2>
        <p>{t('drills.loading', 'Loading drills…')}</p>
      </section>
    );
  }

  if (data.total.attempts === 0) {
    return (
      <section
        className="drill-stats-panel drill-stats-panel--empty"
        data-testid="drill-stats-panel"
        data-state="empty"
      >
        <h2 className="drill-stats-panel__heading">
          {t('drills.stats.heading', 'Drill stats')}
        </h2>
        <p className="drill-stats-panel__empty">
          {t(
            'drills.stats.empty',
            'No drill attempts yet. Open the trainer to start.',
          )}
        </p>
        {lobbyHref && (
          <Link
            to={lobbyHref}
            className="drill-stats-panel__cta"
            data-testid="drill-stats-panel-cta"
          >
            {t('drills.stats.openLobby', 'Open trainer')}
          </Link>
        )}
      </section>
    );
  }

  return (
    <section
      className="drill-stats-panel"
      data-testid="drill-stats-panel"
      data-state="loaded"
    >
      <h2 className="drill-stats-panel__heading">
        {t('drills.stats.heading', 'Drill stats')}
      </h2>

      <div
        className="drill-stats-panel__summary"
        data-testid="drill-stats-panel-summary"
      >
        <div className="drill-stats-panel__summary-card">
          <span className="drill-stats-panel__summary-label">
            {t('drills.stats.totalAttempts', 'Attempts')}
          </span>
          <span
            className="drill-stats-panel__summary-value"
            data-testid="drill-stats-panel-total-attempts"
          >
            {data.total.attempts}
          </span>
        </div>
        <div className="drill-stats-panel__summary-card">
          <span className="drill-stats-panel__summary-label">
            {t('drills.stats.totalSolved', 'Solved')}
          </span>
          <span
            className="drill-stats-panel__summary-value"
            data-testid="drill-stats-panel-total-solved"
          >
            {data.total.solved}
          </span>
        </div>
        <div className="drill-stats-panel__summary-card">
          <span className="drill-stats-panel__summary-label">
            {t('drills.stats.totalAccuracy', 'Accuracy')}
          </span>
          <span
            className="drill-stats-panel__summary-value"
            data-testid="drill-stats-panel-total-accuracy"
          >
            {formatAccuracy(data.total.accuracy)}
          </span>
        </div>
      </div>

      <table className="drill-stats-panel__table">
        <thead>
          <tr>
            <th>{t('drills.stats.col.type', 'Type')}</th>
            <th>{t('drills.stats.col.attempts', 'Attempts')}</th>
            <th>{t('drills.stats.col.solved', 'Solved')}</th>
            <th>{t('drills.stats.col.accuracy', 'Accuracy')}</th>
            <th>{t('drills.stats.col.avgTime', 'Avg time')}</th>
            <th>{t('drills.stats.col.iou', 'Avg IoU')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const unlocked = unlockedSet.has(row.drillType);
            const camel = kebabToCamel(row.drillType);
            return (
              <tr
                key={row.drillType}
                data-drill-type={row.drillType}
                data-unlocked={unlocked ? 'true' : 'false'}
                className={
                  unlocked
                    ? 'drill-stats-panel__row drill-stats-panel__row--unlocked'
                    : 'drill-stats-panel__row drill-stats-panel__row--locked'
                }
              >
                <td className="drill-stats-panel__cell-type">
                  {t(`drills.types.${camel}`)}{' '}
                  <span
                    className={
                      unlocked
                        ? 'drill-stats-panel__badge drill-stats-panel__badge--unlocked'
                        : 'drill-stats-panel__badge drill-stats-panel__badge--locked'
                    }
                    data-testid={`drill-stats-panel-badge-${row.drillType}`}
                  >
                    {unlocked
                      ? t('drills.stats.unlockedLabel', 'Unlocked')
                      : t('drills.stats.lockedLabel', 'Locked')}
                  </span>
                </td>
                <td>{row.attempts}</td>
                <td>{row.solved}</td>
                <td>{formatAccuracy(row.accuracy)}</td>
                <td>{formatAvgTime(row.avgTimeMs)}</td>
                <td>{formatIou(row.avgIou)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
