/**
 * KS-4033. Вкладка «Метрики» в окне анализа — версия «текущая позиция».
 *
 * До KS-4033 вкладка показывала тот же график изменения метрик по
 * партии, что и отдельная страница `/analyses/:id/metrics`. Жалоба
 * пользователя: дубль бесполезен. Новая вкладка показывает столбиками
 * метрики только для позиции, которая сейчас на доске анализа.
 *
 * Состав:
 *  - Шапка с переключателем режима (Разница / Параллельно).
 *  - Список метрик: каждая строка — `id` слева и горизонтальный
 *    столбик-бар справа. Сортировка — по убыванию `|diff|`
 *    (`score` в `CurrentPositionMetricRow`).
 *  - Состояние loading (пока WASM считает) — показываем placeholder,
 *    предыдущие строки оставляем под полупрозрачной плёнкой, чтобы
 *    UI не «прыгал» при перемотке.
 *  - Состояние error — показываем текст ошибки от движка.
 *
 * Источник данных: хук `useCurrentPositionMetrics(fen)` + чистый
 * агрегатор `buildCurrentPositionMetricRows`. Хук пересчитывает
 * `evalTrace(fen)` при каждой смене `fen` с debounce 200мс.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useCurrentPositionMetrics,
  type CurrentPositionMetricsState,
} from '../../hooks/useCurrentPositionMetrics';
import {
  buildCurrentPositionMetricRows,
  squaresForMetric,
  type CurrentPositionMetricRow,
  type MetricSquares,
} from '../../lib/review/currentPositionMetricRows';
import type { MetricPhase } from '../../lib/review/positionalMetrics';

export type CurrentPositionMetricsMode = 'diff' | 'parallel';

export interface CurrentPositionMetricsPanelProps {
  /** FEN текущей позиции на доске анализа. */
  fen: string | null | undefined;
  /**
   * Активна ли вкладка / панель. По умолчанию `true`. Если `false` —
   * хук не запускает `evalTrace` (экономит WASM, когда пользователь не
   * смотрит вкладку).
   */
  enabled?: boolean;
  /**
   * Опциональная ссылка в шапке — например, на отдельную страницу
   * `/analyses/:id/metrics` с графиком всей партии. Совместимость с
   * существующей вкладкой (KS-4027).
   */
  headerLink?: { label: string; href: string };
  /**
   * Фаза tapered eval. По умолчанию `mix` — среднее `value_mg` и
   * `value_eg`. На сейчас в UI не вынесена в переключатель, оставлена
   * как проп — на случай, если потребуется отдельной задачей.
   */
  phase?: MetricPhase;
  /**
   * Тестовый override: позволяет передать готовое состояние без
   * запуска WASM-движка. Используется в `AnalysisMetricsTabPreviewPage`
   * (dev) и в unit-тестах.
   */
  metricsOverride?: CurrentPositionMetricsState;
  /**
   * KS-4033 follow-up. Колбэк подсветки доски: при клике на строку
   * метрики передаются клетки, на которых Stockfish заполнил `square`
   * для этой подкомпоненты. Повторный клик по той же строке снимает
   * выделение (`info=null`). Если для подкомпоненты нет привязки к
   * клеткам (агрегаты вроде `material`, `king_attackers_count` целиком)
   * — `info.white`/`info.black` будут пустыми массивами; вызывающий
   * код может молча игнорировать такой клик.
   */
  onHighlightSquares?: (
    info: { id: string; squares: MetricSquares } | null,
  ) => void;
}

/** Длинный полу-предсказуемый список меток для UI. Без перевода: id
 *  Stockfish — это код метрики, отображается as-is (Latin) — совпадает
 *  с тем, что показывает отладочная таблица `__ksPositionalDiff()`.
 *  Отдельная задача по локализации меток — KS-followup. */
function formatLabel(id: CurrentPositionMetricRow['id']): string {
  return id;
}

/**
 * KS-4036: поповер с полным названием метрики при наведении / фокусе.
 * До этого тикета длинные id обрезались троеточием (`king_attackers_co...`),
 * и понять, что это за метрика, было невозможно. Поповер — компактная
 * подсказка: полный идентификатор Stockfish + (опц.) перевод из i18n.
 *
 * Реализован без сторонних библиотек, через CSS `:hover` / `:focus-within`
 * родительского `.current-metrics-row__label-wrap` — работает на десктопе.
 * На мобильных устройствах (где hover нет) показывается нативный
 * браузерный tooltip через `title` атрибут — он отрабатывает на long-press.
 *
 * `t` нужен только если в i18n появятся переводы (TODO i18n — не
 * блокирующая мелочь). Сейчас словарь пустой, поповер показывает один
 * технический id.
 */
const METRIC_LABEL_I18N_PREFIX = 'analysis.metrics.label.';

interface MetricLabelWithPopoverProps {
  id: CurrentPositionMetricRow['id'];
  t: (key: string, def?: string) => string;
}

function MetricLabelWithPopover({ id, t }: MetricLabelWithPopoverProps) {
  const technical = formatLabel(id);
  // TODO i18n: ключ `analysis.metrics.label.<id>` для перевода
  // конкретной метрики. Если ключ не задан — `t` вернёт default
  // (пустую строку), и подзаголовок локализации не рендерится.
  const localized = t(`${METRIC_LABEL_I18N_PREFIX}${id}`, '').trim();
  const titleAttr = localized ? `${technical} — ${localized}` : technical;
  return (
    <span
      className="current-metrics-row__label-wrap"
      data-testid={`current-metrics-row-label-wrap-${id}`}
    >
      <span
        className="current-metrics-row__label"
        title={titleAttr}
        tabIndex={0}
      >
        {technical}
      </span>
      <span
        className="current-metrics-row__popover"
        role="tooltip"
        data-testid={`current-metrics-row-popover-${id}`}
      >
        <span className="current-metrics-row__popover-id">{technical}</span>
        {localized && (
          <span className="current-metrics-row__popover-localized">
            {localized}
          </span>
        )}
      </span>
    </span>
  );
}

interface BarRowProps {
  row: CurrentPositionMetricRow;
  mode: CurrentPositionMetricsMode;
  maxAbs: number;
  /** KS-4033 follow-up: true, если строка сейчас выбрана (подсвечивает доску). */
  selected: boolean;
  /** KS-4033 follow-up: клик-обработчик для toggle подсветки. */
  onSelect: () => void;
  /** KS-4036: `t` для попытки локализовать имя метрики. */
  t: (key: string, def?: string) => string;
}

/**
 * Одна строка-метрика. В режиме `diff` — единая полоса со сдвигом
 * влево (преимущество чёрных) или вправо (белых). В режиме `parallel`
 * — две полосы: верхняя «белая», нижняя «чёрная».
 *
 * Длины нормированы к `maxAbs` — наибольшему `score` в текущем
 * наборе. Это даёт пропорциональную картинку и не зависит от
 * абсолютной величины (psqt в сотнях, threat_hanging в десятках).
 */
function BarRow({ row, mode, maxAbs, selected, onSelect, t }: BarRowProps) {
  const ratio = maxAbs > 0 ? Math.min(1, row.score / maxAbs) : 0;
  const pct = (ratio * 50).toFixed(2); // половина ширины — на сторону
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  if (mode === 'diff') {
    const isWhite = row.diff >= 0;
    return (
      <div
        className={`current-metrics-row current-metrics-row--diff${
          selected ? ' current-metrics-row--selected' : ''
        }`}
        data-testid={`current-metrics-row-${row.id}`}
        data-side={isWhite ? 'white' : 'black'}
        data-selected={selected ? 'true' : 'false'}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
      >
        <MetricLabelWithPopover id={row.id} t={t} />
        <div className="current-metrics-row__bar-track">
          <span
            className="current-metrics-row__bar-axis"
            aria-hidden="true"
          />
          <span
            className={`current-metrics-row__bar current-metrics-row__bar--${isWhite ? 'white' : 'black'}`}
            style={{
              width: `${pct}%`,
              [isWhite ? 'left' : 'right']: '50%',
            }}
          />
        </div>
        <span
          className="current-metrics-row__value"
          data-testid={`current-metrics-row-value-${row.id}`}
        >
          {row.diff >= 0 ? '+' : ''}
          {row.diff.toFixed(1)}
        </span>
      </div>
    );
  }

  // parallel
  const whiteRatio = maxAbs > 0 ? Math.min(1, row.white / maxAbs) : 0;
  const blackRatio = maxAbs > 0 ? Math.min(1, row.black / maxAbs) : 0;
  return (
    <div
      className={`current-metrics-row current-metrics-row--parallel${
        selected ? ' current-metrics-row--selected' : ''
      }`}
      data-testid={`current-metrics-row-${row.id}`}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
    >
      <MetricLabelWithPopover id={row.id} t={t} />
      <div className="current-metrics-row__bars-stack">
        <div
          className="current-metrics-row__bars-stack-row"
          data-side="white"
        >
          <span
            className="current-metrics-row__bar current-metrics-row__bar--white"
            style={{ width: `${(whiteRatio * 100).toFixed(2)}%` }}
          />
          <span
            className="current-metrics-row__value current-metrics-row__value--inline"
            data-testid={`current-metrics-row-white-${row.id}`}
          >
            {row.white.toFixed(1)}
          </span>
        </div>
        <div
          className="current-metrics-row__bars-stack-row"
          data-side="black"
        >
          <span
            className="current-metrics-row__bar current-metrics-row__bar--black"
            style={{ width: `${(blackRatio * 100).toFixed(2)}%` }}
          />
          <span
            className="current-metrics-row__value current-metrics-row__value--inline"
            data-testid={`current-metrics-row-black-${row.id}`}
          >
            {row.black.toFixed(1)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function CurrentPositionMetricsPanel({
  fen,
  enabled = true,
  headerLink,
  phase = 'mix',
  metricsOverride,
  onHighlightSquares,
}: CurrentPositionMetricsPanelProps) {
  const hookState = useCurrentPositionMetrics({ fen, enabled });
  const metrics = metricsOverride ?? hookState;
  // KS-4036: `t` для попытки локализовать имя метрики через
  // `analysis.metrics.label.<id>`. Подпись `as` — `t` из i18n возвращает
  // `string | ResourceKey`, в нашем случае второй аргумент-default
  // всегда `string`, поэтому суживаем тип под `MetricLabelWithPopover`.
  const { t } = useTranslation();
  const tForLabel = t as unknown as (key: string, def?: string) => string;

  const [mode, setMode] = useState<CurrentPositionMetricsMode>('diff');
  // Скрывать метрики с почти нулевой разницей (опциональное усмотрение
  // из задачи). По умолчанию выключено — пользователь должен сам
  // решить, нужен ли ему фильтр.
  const [hideTiny, setHideTiny] = useState(false);
  // KS-4033 follow-up: какая строка-метрика сейчас выбрана для подсветки
  // доски. `null` — ничего не подсвечено. Повторный клик по той же
  // строке снимает выделение.
  const [selectedMetricId, setSelectedMetricId] = useState<string | null>(
    null,
  );

  // При смене позиции снимаем выделение — клетки прошлой позиции не
  // имеют смысла для новой расстановки. Реагируем на `fenForSubterms`,
  // т.к. оно обновляется ровно когда новый набор subterms готов.
  const lastFenRef = useRef<string | null>(null);
  if (
    metrics.fenForSubterms !== lastFenRef.current &&
    selectedMetricId !== null
  ) {
    lastFenRef.current = metrics.fenForSubterms;
    setSelectedMetricId(null);
    onHighlightSquares?.(null);
  } else if (metrics.fenForSubterms !== lastFenRef.current) {
    lastFenRef.current = metrics.fenForSubterms;
  }

  const handleSelect = (rowId: string) => {
    if (selectedMetricId === rowId) {
      setSelectedMetricId(null);
      onHighlightSquares?.(null);
      return;
    }
    setSelectedMetricId(rowId);
    const subterms = metrics.subterms ?? [];
    const squares = squaresForMetric(subterms, rowId);
    onHighlightSquares?.({ id: rowId, squares });
  };

  const rows = useMemo(() => {
    if (!metrics.subterms) return [] as CurrentPositionMetricRow[];
    const all = buildCurrentPositionMetricRows(metrics.subterms, phase);
    // KS-4033 follow-up: `psqt_*` (psqt_pawn / psqt_knight / psqt_bishop /
    // psqt_rook / psqt_queen / psqt_king) — техническое разложение
    // позиционной таблицы фигур, без шахматной семантики. По запросу
    // пользователя скрываем их из UI вкладки «Метрики» в окне анализа.
    // Доступны через отладочную консоль (`window.__ksPositionalDiff`,
    // KS-4017 / KS-4021) и на отдельной странице метрик.
    const visible = all.filter((r) => !(r.id as string).startsWith('psqt_'));
    if (!hideTiny) return visible;
    return visible.filter((r) => r.score >= 1);
  }, [metrics.subterms, phase, hideTiny]);

  const maxAbs = rows.length > 0 ? rows[0].score : 0;

  const isLoading =
    metrics.status === 'loading' && rows.length === 0;
  const showError =
    metrics.status === 'error' && rows.length === 0;

  return (
    <div
      className="current-metrics-panel"
      data-testid="current-metrics-panel"
      data-mode={mode}
      data-status={metrics.status}
    >
      <div className="current-metrics-panel__header">
        <div className="current-metrics-panel__mode-switch" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'diff'}
            className={`current-metrics-panel__mode-btn${
              mode === 'diff'
                ? ' current-metrics-panel__mode-btn--active'
                : ''
            }`}
            onClick={() => setMode('diff')}
            data-testid="current-metrics-mode-diff"
          >
            Разница
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'parallel'}
            className={`current-metrics-panel__mode-btn${
              mode === 'parallel'
                ? ' current-metrics-panel__mode-btn--active'
                : ''
            }`}
            onClick={() => setMode('parallel')}
            data-testid="current-metrics-mode-parallel"
          >
            Параллельно
          </button>
        </div>
        <label className="current-metrics-panel__filter">
          <input
            type="checkbox"
            checked={hideTiny}
            onChange={(e) => setHideTiny(e.target.checked)}
            data-testid="current-metrics-hide-tiny"
          />
          <span>Скрыть малозначимые</span>
        </label>
        {headerLink && (
          <a
            className="current-metrics-panel__link"
            href={headerLink.href}
            data-testid="current-metrics-header-link"
          >
            {headerLink.label}
          </a>
        )}
      </div>

      {isLoading && (
        <div
          className="current-metrics-panel__status current-metrics-panel__status--loading"
          data-testid="current-metrics-loading"
        >
          Считаю позицию через Stockfish…
        </div>
      )}

      {showError && (
        <div
          className="current-metrics-panel__status current-metrics-panel__status--error"
          data-testid="current-metrics-error"
        >
          Не удалось получить метрики: {metrics.error}
        </div>
      )}

      {rows.length === 0 && metrics.status === 'ready' && (
        <div
          className="current-metrics-panel__status"
          data-testid="current-metrics-empty"
        >
          Для этой позиции Stockfish не вернул подкомпонент.
        </div>
      )}

      <div
        className={`current-metrics-panel__rows${
          metrics.status === 'loading' && rows.length > 0
            ? ' current-metrics-panel__rows--stale'
            : ''
        }`}
        data-testid="current-metrics-rows"
      >
        {rows.map((row) => (
          <BarRow
            key={row.id}
            row={row}
            mode={mode}
            maxAbs={maxAbs}
            selected={selectedMetricId === row.id}
            onSelect={() => handleSelect(row.id)}
            t={tForLabel}
          />
        ))}
      </div>
    </div>
  );
}
