/**
 * KS-3391: трёхцветная горизонтальная полоса шансов W/D/L для режима
 * тренировки точности (PlayVsEngineRunner). Заменяет вертикальный
 * градусник (EvalBar) на /precision.
 *
 * Сегменты слева направо: победа (зелёный) → ничья (нейтральный серый)
 * → поражение (красный). Ширина каждого сегмента пропорциональна доле
 * W/D/L. Перерисовывается в реальном времени по мере поступления оценки
 * Stockfish (caller передаёт `latestWdl`).
 *
 * POV: компонент агностичен к стороне — он рисует то, что ему передали.
 * Семантика «победа решателя» обеспечивается вызывающей стороной: в
 * PlayVsEngineRunner `latestWdl` уже приведён к POV решателя (на
 * post-analyze FEN'е, где ходит соперник, делается `flipWdl`). Это важно
 * для preventive-задач за чёрных — шансы показываются с точки зрения
 * того, кто решает, а не абсолютные «за белых».
 *
 * Цвета — базовые semantic-переменные (`--c-success` / нейтраль /
 * `--c-danger`) с hex-фолбэками. Финальная полировка контраста и тёмной
 * темы — отдельной layout-задачей при необходимости (см. acceptance
 * KS-3391).
 */

import { useTranslation } from 'react-i18next';
import type { WdlDistribution } from '../utils/engineAdapter';

export interface WdlChancesBarProps {
  /**
   * WDL POV решателя в промилле (0..1000). `null` — оценка ещё не
   * получена (initial/loading): рисуем нейтральную полосу без скачков.
   */
  wdl: WdlDistribution | null;
  /** data-testid для контейнера. По умолчанию — `wdl-chances-bar`. */
  testId?: string;
}

export interface WdlShares {
  /** Доля побед в процентах (0..100). */
  w: number;
  /** Доля ничьих в процентах. */
  d: number;
  /** Доля поражений в процентах. */
  l: number;
}

/**
 * KS-3391: WDL (промилле, сумма ≈ 1000) → доли в процентах, нормированные
 * так, чтобы w+d+l = 100 (Stockfish иногда отдаёт сумму чуть ≠ 1000 из-за
 * округления). При нулевой/отрицательной сумме — полностью нейтральная
 * ничья (защита от деления на ноль).
 */
export function wdlShares(wdl: WdlDistribution): WdlShares {
  const total = wdl.w + wdl.d + wdl.l;
  if (total <= 0) return { w: 0, d: 100, l: 0 };
  return {
    w: (wdl.w / total) * 100,
    d: (wdl.d / total) * 100,
    l: (wdl.l / total) * 100,
  };
}

/** Порог в %, начиная с которого внутри сегмента показываем подпись. */
const LABEL_MIN_WIDTH = 14;

export function WdlChancesBar({
  wdl,
  testId = 'wdl-chances-bar',
}: WdlChancesBarProps) {
  const { t } = useTranslation();
  const shares = wdl ? wdlShares(wdl) : null;

  const winLabel = t('puzzle.engine.summary.win', 'Win');
  const drawLabel = t('puzzle.engine.summary.draw', 'Draw');
  const lossLabel = t('puzzle.engine.summary.loss', 'Loss');

  // Loading/initial: нейтральная серая полоса целиком, без числовых
  // значений — не даём «прыжков» до первой оценки.
  if (!shares) {
    return (
      <div
        className="wdl-chances-bar"
        data-testid={testId}
        data-loading="true"
        role="img"
        aria-label={t('precision.wdlBar.loading', 'Evaluating position…')}
      >
        <div className="wdl-chances-bar__seg wdl-chances-bar__seg--loading" />
      </div>
    );
  }

  const w = Math.round(shares.w);
  const d = Math.round(shares.d);
  const l = Math.round(shares.l);

  return (
    <div
      className="wdl-chances-bar"
      data-testid={testId}
      data-loading="false"
      data-w={String(w)}
      data-d={String(d)}
      data-l={String(l)}
      role="img"
      aria-label={`${winLabel} ${w}%, ${drawLabel} ${d}%, ${lossLabel} ${l}%`}
    >
      <div
        className="wdl-chances-bar__seg wdl-chances-bar__seg--win"
        style={{ width: `${shares.w}%` }}
        data-testid="wdl-chances-bar-win"
        title={`${winLabel}: ${w}%`}
      >
        {shares.w >= LABEL_MIN_WIDTH && (
          <span className="wdl-chances-bar__label">{w}%</span>
        )}
      </div>
      <div
        className="wdl-chances-bar__seg wdl-chances-bar__seg--draw"
        style={{ width: `${shares.d}%` }}
        data-testid="wdl-chances-bar-draw"
        title={`${drawLabel}: ${d}%`}
      >
        {shares.d >= LABEL_MIN_WIDTH && (
          <span className="wdl-chances-bar__label">{d}%</span>
        )}
      </div>
      <div
        className="wdl-chances-bar__seg wdl-chances-bar__seg--loss"
        style={{ width: `${shares.l}%` }}
        data-testid="wdl-chances-bar-loss"
        title={`${lossLabel}: ${l}%`}
      >
        {shares.l >= LABEL_MIN_WIDTH && (
          <span className="wdl-chances-bar__label">{l}%</span>
        )}
      </div>
    </div>
  );
}
