/**
 * KS-4024 / ADR-122 §5. Корневая панель «Метрики» в окне анализа.
 *
 * Состав:
 *   - MetricToolbar — переключатель режима (по стороне / разница) +
 *     фаза (mg/eg/mix).
 *   - MetricGroupCheckboxes — раскладка по 8 разделам ADR-122 §4.
 *   - MetricRunner — прогресс расчёта + кнопка отмены.
 *   - MetricsChart — линии по выбранным метрикам с осью X = ply,
 *     hover-tooltip, клик по точке → переход на ply через колбэк
 *     `onPlySelect`.
 *
 * Для MVP график — лёгкий SVG-renderer без uPlot. Lazy-импорт uPlot
 * можно подключить отдельной задачей (ADR-122 §5.2), когда станет
 * нужна интерактивность и зум.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PositionalSubterm } from '@kingside/shared';
import {
  METRIC_GROUPS,
  buildMetricSeries,
  type MetricMode,
  type MetricPhase,
  type MetricSeries,
} from '../../lib/review/positionalMetrics';
import type { UsePositionalTraceState } from '../../hooks/usePositionalTrace';

export interface PositionalMetricsPanelProps {
  /** Результат хука `usePositionalTrace`. */
  trace: UsePositionalTraceState;
  /** Список ходов партии в UCI для запуска расчёта. */
  uciMoves: ReadonlyArray<string>;
  /** Колбэк: пользователь кликнул на точку графика — перейти на ply. */
  onPlySelect?: (ply: number) => void;
  /** Текущий ply (для подсветки на графике). */
  currentPly?: number;
  /**
   * KS-4027. Опциональная кнопка-ссылка в шапке панели — например,
   * «↗ Открыть аналитику на отдельной странице». Рендерится только
   * когда передан `headerLink`.
   */
  headerLink?: { label: string; href: string };
  /**
   * KS-4027. Высота графика. Меньшая для боковой вкладки (220 по
   * умолчанию), большая — для отдельной страницы (например, 420).
   */
  chartHeight?: number;
  /** KS-4027. Ключ для сохранения пользовательского выбора метрик в localStorage. */
  selectionStorageKey?: string;
  /**
   * KS-4027. Раскладка панели:
   *   - `'sidebar'` (по умолчанию) — флажки в боковой колонке 200px
   *     справа от графика. Для узкой вкладки в правой колонке анализа.
   *   - `'fullpage'` — флажки вынесены в свёртываемое меню «Настройки
   *     метрик» над графиком; график занимает всю ширину контейнера.
   */
  layout?: 'sidebar' | 'fullpage';
  /**
   * KS-4027. SAN-ходы (алгебраическая нотация: `e4`, `Nf3`, `O-O`),
   * по одному на каждый полуход партии (длина = `uciMoves.length`).
   * Подписи оси X на графике формируются из них (вместо номеров
   * полуходов). Если не передано — на оси X номера ходов.
   */
  sanMoves?: ReadonlyArray<string>;
}

const COLORS = {
  white: '#1976d2',
  black: '#c62828',
  diff: '#2e7d32',
} as const;

/** Сетка цветов по индексу для нескольких серий одного варианта. */
const SERIES_PALETTE = [
  '#1976d2',
  '#c62828',
  '#2e7d32',
  '#f57c00',
  '#6a1b9a',
  '#00838f',
  '#5d4037',
  '#455a64',
];

function colorForSeries(s: MetricSeries, idx: number): string {
  if (s.variant === 'w') return COLORS.white;
  if (s.variant === 'b') return COLORS.black;
  return SERIES_PALETTE[idx % SERIES_PALETTE.length];
}

interface MetricsChartProps {
  series: ReadonlyArray<MetricSeries>;
  width: number;
  height: number;
  onPlySelect?: (ply: number) => void;
  currentPly?: number;
  /** KS-4027. Сообщение когда нет данных (отличается от «нет выбора»). */
  noDataMessage?: string;
  /**
   * KS-4027. SAN-ходы для подписей оси X. `sanMoves[i]` — ход на
   * полуходе `i+1` (нумерация с нуля). Длина обычно `plyCount - 1`.
   */
  sanMoves?: ReadonlyArray<string>;
}

/**
 * Простой SVG-график с линиями. Не использует uPlot/recharts — ради
 * лёгкости. Точки кликабельны (передают ply наверх).
 */
export function MetricsChart({
  series,
  width,
  height,
  onPlySelect,
  currentPly,
  noDataMessage,
  sanMoves,
}: MetricsChartProps) {
  const { t } = useTranslation();
  const padding = { top: 12, right: 8, bottom: 28, left: 36 };
  const plotW = Math.max(40, width - padding.left - padding.right);
  const plotH = Math.max(40, height - padding.top - padding.bottom);
  // KS-4027. Hover-state: какой ply сейчас под курсором. При наведении
  // показываем вертикальную линию, маркеры точек и tooltip со значениями
  // выбранных метрик в этом ply.
  const [hoverPly, setHoverPly] = useState<number | null>(null);

  const { plyCount, minY, maxY } = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    let n = 0;
    for (const s of series) {
      if (s.data.length > n) n = s.data.length;
      for (const v of s.data) {
        if (v == null || !Number.isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
      mn = -1;
      mx = 1;
    } else if (mn === mx) {
      mn -= 0.5;
      mx += 0.5;
    }
    return { plyCount: n, minY: mn, maxY: mx };
  }, [series]);

  function xFor(ply: number): number {
    if (plyCount <= 1) return padding.left + plotW / 2;
    return padding.left + (ply / (plyCount - 1)) * plotW;
  }
  function yFor(v: number): number {
    const t = (v - minY) / (maxY - minY);
    return padding.top + (1 - t) * plotH;
  }

  if (series.length === 0) {
    return (
      <div
        data-testid="metrics-chart-empty"
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#999',
          fontSize: 13,
          textAlign: 'center',
          padding: 12,
        }}
      >
        {noDataMessage ?? t('analysis.metrics.chartEmpty', 'Select at least one metric in the list on the right.')}
      </div>
    );
  }

  return (
    <svg
      data-testid="metrics-chart"
      width={width}
      height={height}
      style={{ display: 'block' }}
    >
      {/* Ось Y и сетка */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = padding.top + t * plotH;
        const v = maxY - t * (maxY - minY);
        return (
          <g key={t}>
            <line
              x1={padding.left}
              y1={y}
              x2={padding.left + plotW}
              y2={y}
              stroke="#eee"
              strokeWidth={1}
            />
            <text x={4} y={y + 4} fontSize={10} fill="#888">
              {v.toFixed(1)}
            </text>
          </g>
        );
      })}
      {/* Ось X */}
      <line
        x1={padding.left}
        y1={padding.top + plotH}
        x2={padding.left + plotW}
        y2={padding.top + plotH}
        stroke="#bbb"
      />
      {/* KS-4027: подписи по оси X — SAN-ходы партии. Идём по полуходам
          с равным шагом 1 (каждый полуход — своя подпись), чтобы
          расстояние между метками было одинаковым: пользователь
          жаловался, что между белым/чёрным одной пары интервал маленький,
          а между парами — большой. На очень длинных партиях, где плотность
          точек мала, шаг увеличивается до целочисленного N. Чёрные ходы
          показываем коротко (только SAN, без номера хода) — иначе при
          18px на полуход метки наезжают друг на друга. */}
      {(() => {
        if (plyCount <= 1) return null;
        const moveLabelFor = (ply: number): string => {
          const moveNo = Math.ceil(ply / 2);
          const san = sanMoves && sanMoves[ply - 1];
          if (!san) return String(moveNo);
          // Белые: «1.e4», «2.Nf3», … — с номером хода.
          // Чёрные: «e5», «Nc6», … — только SAN, без номера: для
          // одинакового шага между метками компактная подпись.
          return ply % 2 === 1 ? `${moveNo}.${san}` : san;
        };
        // Минимум 16px между метками — иначе перекрывают друг друга.
        const stepPx = plotW / Math.max(1, plyCount - 1);
        const step = Math.max(1, Math.ceil(16 / stepPx));
        const labels: Array<{ ply: number; text: string }> = [
          { ply: 0, text: t('analysis.metrics.plyStartShort', 'start') },
        ];
        for (let ply = step; ply <= plyCount - 1; ply += step) {
          labels.push({ ply, text: moveLabelFor(ply) });
        }
        const last = plyCount - 1;
        if (labels[labels.length - 1].ply !== last) {
          labels.push({ ply: last, text: moveLabelFor(last) });
        }
        return labels.map((t, idx) => (
          <g key={`xt-${idx}-${t.ply}`}>
            <line
              x1={xFor(t.ply)}
              y1={padding.top + plotH}
              x2={xFor(t.ply)}
              y2={padding.top + plotH + 4}
              stroke="#bbb"
            />
            <text
              x={xFor(t.ply)}
              y={padding.top + plotH + 16}
              fontSize={10}
              fill="#888"
              textAnchor="middle"
            >
              {t.text}
            </text>
          </g>
        ));
      })()}
      {/* Подсветка currentPly */}
      {typeof currentPly === 'number' && currentPly < plyCount && (
        <line
          x1={xFor(currentPly)}
          y1={padding.top}
          x2={xFor(currentPly)}
          y2={padding.top + plotH}
          stroke="#f4b400"
          strokeWidth={2}
          strokeDasharray="4 4"
        />
      )}
      {/* Линии */}
      {series.map((s, idx) => {
        const color = colorForSeries(s, idx);
        const points: string[] = [];
        for (let i = 0; i < s.data.length; i += 1) {
          const v = s.data[i];
          if (v == null || !Number.isFinite(v)) continue;
          points.push(`${xFor(i)},${yFor(v)}`);
        }
        return (
          <polyline
            key={`${s.id}-${s.variant}-${idx}`}
            points={points.join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={1.6}
            opacity={0.85}
          />
        );
      })}
      {/* KS-4027. Hover-подсветка: вертикальная линия + точки на сериях
          + tooltip с названиями метрик и значениями в этом ply. */}
      {hoverPly != null && hoverPly < plyCount && (
        <g pointerEvents="none">
          <line
            x1={xFor(hoverPly)}
            y1={padding.top}
            x2={xFor(hoverPly)}
            y2={padding.top + plotH}
            stroke="#555"
            strokeWidth={1}
            opacity={0.6}
          />
          {series.map((s, idx) => {
            const v = s.data[hoverPly];
            if (v == null || !Number.isFinite(v)) return null;
            return (
              <circle
                key={`hover-dot-${s.id}-${s.variant}-${idx}`}
                cx={xFor(hoverPly)}
                cy={yFor(v)}
                r={3.5}
                fill={colorForSeries(s, idx)}
                stroke="#fff"
                strokeWidth={1}
              />
            );
          })}
          {(() => {
            // Tooltip-блок: подпись хода + значения серий. Ставим справа
            // от вертикальной линии, либо слева — если упирается в правый
            // край области графика.
            const lines: Array<{ label: string; value: string; color: string }> = [];
            for (let idx = 0; idx < series.length; idx += 1) {
              const s = series[idx];
              const v = s.data[hoverPly];
              if (v == null || !Number.isFinite(v)) continue;
              lines.push({
                label: s.label,
                value: v.toFixed(2),
                color: colorForSeries(s, idx),
              });
            }
            const headerSan = sanMoves && hoverPly >= 1 ? sanMoves[hoverPly - 1] : null;
            const headerText =
              hoverPly === 0
                ? t('analysis.metrics.startPos', 'start position')
                : t('analysis.metrics.movePrefix', 'move {{n}}{{sep}}{{san}}', {
                    n: Math.ceil(hoverPly / 2),
                    sep: hoverPly % 2 === 1 ? '.' : '…',
                    san: headerSan ?? '',
                  });
            const lineH = 14;
            const padX = 6;
            const padY = 6;
            const boxW = 170;
            const boxH = padY * 2 + lineH * (1 + lines.length);
            const xRight = xFor(hoverPly) + 8;
            const fitsRight = xRight + boxW <= padding.left + plotW;
            const boxX = fitsRight ? xRight : xFor(hoverPly) - 8 - boxW;
            const boxY = Math.max(
              padding.top,
              Math.min(padding.top + plotH - boxH, padding.top + 4),
            );
            return (
              <g>
                <rect
                  x={boxX}
                  y={boxY}
                  width={boxW}
                  height={boxH}
                  rx={4}
                  ry={4}
                  fill="rgba(255,255,255,0.96)"
                  stroke="#bbb"
                  strokeWidth={1}
                />
                <text
                  x={boxX + padX}
                  y={boxY + padY + 10}
                  fontSize={11}
                  fontWeight={600}
                  fill="#222"
                >
                  {headerText}
                </text>
                {lines.map((l, i) => (
                  <g key={`tt-${i}`}>
                    <rect
                      x={boxX + padX}
                      y={boxY + padY + lineH * (i + 1) + 2}
                      width={8}
                      height={8}
                      fill={l.color}
                    />
                    <text
                      x={boxX + padX + 14}
                      y={boxY + padY + lineH * (i + 1) + 10}
                      fontSize={11}
                      fill="#333"
                    >
                      {l.label}
                    </text>
                    <text
                      x={boxX + boxW - padX}
                      y={boxY + padY + lineH * (i + 1) + 10}
                      fontSize={11}
                      fill="#333"
                      textAnchor="end"
                      fontFamily="monospace"
                    >
                      {l.value}
                    </text>
                  </g>
                ))}
              </g>
            );
          })()}
        </g>
      )}
      {/* Зоны для hover + клика. Hover работает всегда (даже без
          onPlySelect) — пользователю важна подсветка значений. */}
      {Array.from({ length: plyCount }).map((_, i) => (
        <rect
          key={i}
          x={xFor(i) - 4}
          y={padding.top}
          width={8}
          height={plotH}
          fill="transparent"
          style={{ cursor: onPlySelect ? 'pointer' : 'default' }}
          onClick={onPlySelect ? () => onPlySelect(i) : undefined}
          onMouseEnter={() => setHoverPly(i)}
          onMouseLeave={() => setHoverPly((prev) => (prev === i ? null : prev))}
        >
          <title>ply {i}</title>
        </rect>
      ))}
    </svg>
  );
}

interface MetricGroupCheckboxesProps {
  selectedIds: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}

export function MetricGroupCheckboxes({
  selectedIds,
  onChange,
}: MetricGroupCheckboxesProps) {
  const toggleId = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const toggleGroup = (ids: ReadonlyArray<string>, on: boolean) => {
    const next = new Set(selectedIds);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  };
  return (
    <div
      data-testid="metric-group-checkboxes"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontSize: 12,
        color: '#333',
        maxHeight: '50vh',
        overflowY: 'auto',
        padding: '0 4px',
      }}
    >
      {METRIC_GROUPS.map((g) => {
        const groupSelected = g.ids.every((id) => selectedIds.has(id));
        const groupNone = g.ids.every((id) => !selectedIds.has(id));
        return (
          <div key={g.key} data-testid={`metric-group-${g.key}`}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontWeight: 600,
              }}
            >
              <input
                type="checkbox"
                checked={groupSelected}
                ref={(el) => {
                  if (el) el.indeterminate = !groupSelected && !groupNone;
                }}
                onChange={() => toggleGroup(g.ids, !groupSelected)}
              />
              {g.label}
            </label>
            <div
              style={{
                paddingLeft: 18,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {g.ids.map((id) => (
                <label
                  key={id}
                  style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(id)}
                    onChange={() => toggleId(id)}
                    data-testid={`metric-id-${id}`}
                  />
                  <span style={{ fontFamily: 'monospace' }}>{id}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface MetricToolbarProps {
  mode: MetricMode;
  phase: MetricPhase;
  onModeChange: (m: MetricMode) => void;
  onPhaseChange: (p: MetricPhase) => void;
}

export function MetricToolbar({
  mode,
  phase,
  onModeChange,
  onPhaseChange,
}: MetricToolbarProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="metric-toolbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '6px 8px',
        fontSize: 12,
        background: '#f5f5f5',
        borderRadius: 6,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{t('analysis.metrics.toolbar.modeLabel', 'Mode:')}</span>
        <select
          data-testid="metric-toolbar-mode"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as MetricMode)}
          style={{ fontSize: 12, padding: '2px 4px' }}
        >
          <option value="by-side">{t('analysis.metrics.toolbar.modeBySide', 'By side')}</option>
          <option value="diff">{t('analysis.metrics.toolbar.modeDiff', 'Difference W−B')}</option>
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{t('analysis.metrics.toolbar.phaseLabel', 'Phase:')}</span>
        <select
          data-testid="metric-toolbar-phase"
          value={phase}
          onChange={(e) => onPhaseChange(e.target.value as MetricPhase)}
          style={{ fontSize: 12, padding: '2px 4px' }}
        >
          <option value="mg">{t('analysis.metrics.toolbar.phaseMg', 'Middlegame (mg)')}</option>
          <option value="eg">{t('analysis.metrics.toolbar.phaseEg', 'Endgame (eg)')}</option>
          <option value="mix">{t('analysis.metrics.toolbar.phaseMix', 'Mix')}</option>
        </select>
      </div>
    </div>
  );
}

interface MetricRunnerProps {
  trace: UsePositionalTraceState;
  uciMoves: ReadonlyArray<string>;
}

export function MetricRunner({ trace, uciMoves }: MetricRunnerProps) {
  const { t } = useTranslation();
  const { status, computedPlies, totalPlies, error, start, cancel } = trace;
  const pct =
    totalPlies > 0 ? Math.min(100, Math.round((computedPlies / totalPlies) * 100)) : 0;

  // KS-4025: заглушки для случаев, когда расчёт не имеет смысла.
  if (trace.idle) {
    return (
      <div
        data-testid="metric-runner-idle-no-id"
        style={{
          padding: '8px 10px',
          fontSize: 12,
          color: '#555',
          background: '#f5f5f5',
          borderRadius: 6,
        }}
      >
        {t('analysis.metrics.runner.idleNoId', 'Save the analysis to unlock metrics.')}
      </div>
    );
  }
  if (uciMoves.length === 0) {
    return (
      <div
        data-testid="metric-runner-no-moves"
        style={{
          padding: '8px 10px',
          fontSize: 12,
          color: '#555',
          background: '#f5f5f5',
          borderRadius: 6,
        }}
      >
        {t('analysis.metrics.runner.noMoves', 'Make at least one move to see the metrics trend.')}
      </div>
    );
  }
  if (status === 'synced' || status === 'computed') {
    return (
      <div
        data-testid="metric-runner-done"
        style={{ padding: '6px 8px', fontSize: 12, color: '#2e7d32' }}
      >
        {t('analysis.metrics.runner.doneLine', 'Done · {{plies}} ply · {{where}}', {
          plies: computedPlies,
          where:
            status === 'synced'
              ? t('analysis.metrics.runner.synced', 'synced')
              : t('analysis.metrics.runner.local', 'local'),
        })}
      </div>
    );
  }
  if (status === 'computing' || status === 'syncing') {
    return (
      <div
        data-testid="metric-runner-progress"
        style={{
          padding: '6px 8px',
          fontSize: 12,
          background: '#fff8e1',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>
          {status === 'syncing'
            ? t('analysis.metrics.runner.syncing', 'Uploading to server…')
            : t('analysis.metrics.runner.progress', 'Computing: {{pct}}% ({{done}}/{{total}})', {
                pct,
                done: computedPlies,
                total: totalPlies,
              })}
        </span>
        {status === 'computing' && (
          <button
            type="button"
            data-testid="metric-runner-cancel"
            onClick={cancel}
            style={{
              padding: '2px 8px',
              fontSize: 11,
              background: '#fff',
              border: '1px solid #ccc',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {t('analysis.metrics.runner.cancel', 'Cancel')}
          </button>
        )}
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div
        data-testid="metric-runner-error"
        style={{
          padding: '6px 8px',
          fontSize: 12,
          background: '#fdecea',
          color: '#8a1f1f',
          borderRadius: 6,
        }}
      >
        {t('analysis.metrics.runner.errorPrefix', 'Error:')} {error}
      </div>
    );
  }
  // idle / loading-server
  return (
    <div
      data-testid="metric-runner-idle"
      style={{
        padding: '6px 8px',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span>
        {status === 'loading-server'
          ? t('analysis.metrics.runner.loadingServer', 'Loading from server…')
          : t('analysis.metrics.runner.notComputed', 'Metrics not computed.')}
      </span>
      {status === 'idle' && (
        <button
          type="button"
          data-testid="metric-runner-start"
          onClick={() => start(uciMoves)}
          disabled={uciMoves.length === 0}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: '#1e88e5',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: uciMoves.length === 0 ? 'not-allowed' : 'pointer',
            opacity: uciMoves.length === 0 ? 0.6 : 1,
          }}
        >
          {t('analysis.metrics.runner.start', 'Start computation')}
        </button>
      )}
    </div>
  );
}

/**
 * KS-4027 / ADR-122 §3. Стартовый набор метрик при первом открытии
 * (когда у пользователя ещё нет сохранённого выбора в localStorage).
 * Самые «говорящие» подкомпоненты SF для быстрого взгляда на партию.
 */
const DEFAULT_SELECTED_IDS: ReadonlyArray<string> = [
  'king_danger',
  'material',
  'space',
  'passed_rank',
  'threat_hanging',
];

function loadSelectionFromStorage(key: string | undefined): Set<string> | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed.filter((x): x is string => typeof x === 'string');
    return new Set(cleaned);
  } catch {
    return null;
  }
}

function saveSelectionToStorage(
  key: string | undefined,
  ids: ReadonlySet<string>,
): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch {
    /* quota / private mode — игнорируем */
  }
}

export function PositionalMetricsPanel({
  trace,
  uciMoves,
  onPlySelect,
  currentPly,
  headerLink,
  chartHeight = 220,
  selectionStorageKey,
  layout = 'sidebar',
  sanMoves,
}: PositionalMetricsPanelProps) {
  const { t } = useTranslation();
  // KS-4027: на отдельной странице меню флажков по умолчанию свёрнуто
  // (график сразу занимает всю высоту), на боковой вкладке флажки
  // всегда видны рядом справа (selectorOpen не используется).
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [mode, setMode] = useState<MetricMode>('diff');
  const [phase, setPhase] = useState<MetricPhase>('mix');
  // KS-4027. При первом открытии — стартовый набор (ADR-122 §3); если
  // в localStorage есть сохранённый выбор — используем его.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const saved = loadSelectionFromStorage(selectionStorageKey);
    if (saved && saved.size > 0) return saved;
    return new Set<string>(DEFAULT_SELECTED_IDS);
  });
  // Сохраняем выбор при каждом изменении.
  useEffect(() => {
    saveSelectionToStorage(selectionStorageKey, selectedIds);
  }, [selectionStorageKey, selectedIds]);

  const subtermsPerPly: ReadonlyArray<{
    ply: number;
    subterms: ReadonlyArray<PositionalSubterm>;
  }> = useMemo(() => trace.data?.plies ?? [], [trace.data]);

  const series = useMemo(
    () => buildMetricSeries(subtermsPerPly, selectedIds, mode, phase),
    [subtermsPerPly, selectedIds, mode, phase],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Размер графика. Ширина — фактическая ширина контейнера через
  // ResizeObserver. KS-4027: раньше ResizeObserver был внутри useMemo,
  // который не вызывает cleanup и не перезапускается на mount;
  // contentWidth оставался начальным 360 — график не растягивался на
  // отдельной странице. Переехало в useEffect — ширина теперь
  // считается на mount и пересчитывается при resize окна.
  const [chartWidth, setChartWidth] = useState(360);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.floor(e.contentRect.width);
        if (w > 0) setChartWidth(w);
      }
    });
    const el = containerRef.current;
    if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      data-testid="positional-metrics-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        // KS-4027: для fullpage убираем внутренний padding, чтобы график
        // действительно растягивался на всю ширину окна без пустот.
        padding: layout === 'fullpage' ? 0 : 8,
        fontFamily: 'system-ui, sans-serif',
        minHeight: 0,
        width: '100%',
      }}
    >
      {headerLink && (
        <a
          data-testid="positional-metrics-header-link"
          href={headerLink.href}
          style={{
            fontSize: 12,
            color: '#1e88e5',
            textDecoration: 'none',
            padding: '4px 6px',
            background: '#e3f2fd',
            borderRadius: 4,
            alignSelf: 'flex-start',
          }}
        >
          {headerLink.label}
        </a>
      )}
      <MetricToolbar
        mode={mode}
        phase={phase}
        onModeChange={setMode}
        onPhaseChange={setPhase}
      />
      <MetricRunner trace={trace} uciMoves={uciMoves} />
      {/* KS-4027. На полноэкранной странице — флажки в свёртываемом
          меню над графиком, чтобы график занимал всю ширину. На боковой
          вкладке — рядом с графиком в правой колонке 200px. */}
      {layout === 'fullpage' && (
        <div>
          <button
            type="button"
            data-testid="metric-selector-toggle"
            onClick={() => setSelectorOpen((v) => !v)}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              background: '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: 4,
              cursor: 'pointer',
              marginBottom: 6,
            }}
          >
            {selectorOpen
              ? t('analysis.metrics.hideSettings', 'Hide metrics settings (selected: {{count}})', {
                  count: selectedIds.size,
                })
              : t('analysis.metrics.showSettings', 'Metrics settings (selected: {{count}})', {
                  count: selectedIds.size,
                })}
          </button>
          {selectorOpen && (
            <div
              style={{
                border: '1px solid #eee',
                borderRadius: 6,
                padding: 8,
                marginBottom: 8,
                background: '#fafafa',
              }}
            >
              <MetricGroupCheckboxes
                selectedIds={selectedIds}
                onChange={setSelectedIds}
              />
            </div>
          )}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          minHeight: 0,
        }}
      >
        <div ref={containerRef} style={{ flex: 1, minWidth: 0 }}>
          {/* KS-4027: ФИКСИРОВАННОЕ расстояние между ходами (32px на
              полуход). Ширина SVG зависит только от числа ходов, а не
              от ширины контейнера — при сужении окна график не
              сжимается, а появляется горизонтальная прокрутка.
              Если ходов нет (пустой анализ) — fallback на ширину
              контейнера, чтобы отрисовать заглушку. */}
          {(() => {
            const PX_PER_PLY = 32;
            const minByPlies =
              uciMoves.length > 0 ? (uciMoves.length + 1) * PX_PER_PLY : 0;
            const desiredWidth = minByPlies > 0 ? minByPlies : chartWidth;
            return (
              <div style={{ width: '100%', overflowX: 'auto' }}>
                <MetricsChart
                  series={series}
                  width={desiredWidth}
                  height={chartHeight}
                  onPlySelect={onPlySelect}
                  currentPly={currentPly}
                  sanMoves={sanMoves}
                  noDataMessage={
                    selectedIds.size === 0
                      ? t(
                          'analysis.metrics.noSelected',
                          'Select at least one metric in the metrics settings.',
                        )
                      : !trace.data || trace.data.plies.length === 0
                      ? t(
                          'analysis.metrics.notStarted',
                          'Computation has not been started. Click "Start computation" above.',
                        )
                      : undefined
                  }
                />
              </div>
            );
          })()}
          {/* Легенда */}
          {series.length > 0 && (
            <div
              data-testid="metrics-chart-legend"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                fontSize: 11,
                marginTop: 6,
                color: '#555',
              }}
            >
              {series.map((s, idx) => (
                <span
                  key={`${s.id}-${s.variant}-${idx}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 2,
                      background: colorForSeries(s, idx),
                    }}
                  />
                  {s.label}
                </span>
              ))}
            </div>
          )}
        </div>
        {layout === 'sidebar' && (
          <div
            style={{
              width: 200,
              flexShrink: 0,
              borderLeft: '1px solid #eee',
              paddingLeft: 6,
            }}
          >
            <MetricGroupCheckboxes
              selectedIds={selectedIds}
              onChange={setSelectedIds}
            />
          </div>
        )}
      </div>
    </div>
  );
}
