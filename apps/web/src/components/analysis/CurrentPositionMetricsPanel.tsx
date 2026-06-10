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
  buildMetricBlockRows,
  isRawUnitContribution,
  squaresForMetricBlock,
  type MetricBlockRow,
  type MetricSquares,
} from '../../lib/review/currentPositionMetricRows';
import type { MetricPhase } from '../../lib/review/positionalMetrics';
import type { MetricBlockKey } from '../../lib/review/metricBlocks';

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

/**
 * KS-4036 / KS-4043: поповер с расшифровкой блока при наведении / фокусе.
 * На вкладке «Метрики» теперь рендерится одна строка-блок (KS-4043),
 * поповер показывает локализованное имя блока + перечень подкомпонент
 * Stockfish, реально дававших вклад в позицию. Подкомпоненты с
 * пометкой `isRawUnitContribution` (king_safe_check_*, king_attackers_*)
 * в поповере подсвечены — у них шкала не cp, а сырые единицы.
 *
 * Реализован без сторонних библиотек: CSS `:hover` / `:focus-within`
 * на родительском `.current-metrics-row__label-wrap`. На мобильном
 * браузер показывает нативный tooltip через `title` (long-press).
 */
interface MetricLabelWithPopoverProps {
  block: MetricBlockRow;
  t: (key: string, def?: string) => string;
}

/**
 * KS-4043: значения от Stockfish-trace приходят в сантипешках
 * (целые/дробные после tapered и нашего `mix=(mg+eg)/2`). В UI
 * показываем в пешках с точностью до сотых — это совпадает с
 * разрешающей способностью движка (1 cp = 0.01 пешки) и с шкалой
 * основной оценки в панели движка.
 */
function formatPawns(cp: number): string {
  return (cp / 100).toFixed(2);
}

function formatPawnsSigned(cp: number): string {
  const sign = cp >= 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(2)}`;
}

function MetricLabelWithPopover({ block, t }: MetricLabelWithPopoverProps) {
  const localized = t(block.i18nKey, '').trim() || block.key;
  const technical = block.key;
  const contributionsLine = block.contributions.length
    ? block.contributions.map((c) => c.id).join(', ')
    : '';
  const titleAttr = contributionsLine
    ? `${localized} (${contributionsLine})`
    : localized;
  return (
    <span
      className="current-metrics-row__label-wrap"
      data-testid={`current-metrics-row-label-wrap-${block.key}`}
    >
      <span
        className="current-metrics-row__label"
        title={titleAttr}
        tabIndex={0}
      >
        {localized}
      </span>
      <span
        className="current-metrics-row__popover"
        role="tooltip"
        data-testid={`current-metrics-row-popover-${block.key}`}
      >
        <span className="current-metrics-row__popover-id">{localized}</span>
        <span className="current-metrics-row__popover-localized">
          {technical}
        </span>
        {block.contributions.length > 0 && (
          <span
            className="current-metrics-row__popover-localized"
            data-testid={`current-metrics-row-popover-contributions-${block.key}`}
          >
            {block.contributions
              .map(
                (c) =>
                  `${c.id}${isRawUnitContribution(c.id) ? ' *' : ''}: ${formatPawnsSigned(c.diff)}`,
              )
              .join('\n')}
          </span>
        )}
      </span>
    </span>
  );
}

interface BarRowProps {
  row: MetricBlockRow;
  mode: CurrentPositionMetricsMode;
  maxAbs: number;
  /** KS-4033 follow-up: true, если строка сейчас выбрана (подсвечивает доску). */
  selected: boolean;
  /** KS-4033 follow-up: клик-обработчик для toggle подсветки. */
  onSelect: () => void;
  /** KS-4036: `t` для локализации имени блока. */
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
        data-testid={`current-metrics-row-${row.key}`}
        data-side={isWhite ? 'white' : 'black'}
        data-selected={selected ? 'true' : 'false'}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
      >
        <MetricLabelWithPopover block={row} t={t} />
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
          data-testid={`current-metrics-row-value-${row.key}`}
        >
          {formatPawnsSigned(row.diff)}
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
      data-testid={`current-metrics-row-${row.key}`}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
    >
      <MetricLabelWithPopover block={row} t={t} />
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
            data-testid={`current-metrics-row-white-${row.key}`}
          >
            {formatPawns(row.white)}
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
            data-testid={`current-metrics-row-black-${row.key}`}
          >
            {formatPawns(row.black)}
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
  // KS-4033 follow-up / KS-4043: какой блок сейчас выбран для подсветки
  // доски. `null` — ничего не подсвечено. Повторный клик по той же
  // строке снимает выделение.
  const [selectedMetricId, setSelectedMetricId] =
    useState<MetricBlockKey | null>(null);

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

  const handleSelect = (blockKey: MetricBlockKey) => {
    if (selectedMetricId === blockKey) {
      setSelectedMetricId(null);
      onHighlightSquares?.(null);
      return;
    }
    setSelectedMetricId(blockKey);
    const subterms = metrics.subterms ?? [];
    // KS-4038: передаём FEN текущей позиции — для `pawn_connected`
    // SF выдаёт `square` не для каждой пешки цепочки, и хелпер по FEN
    // дополняет подсветку всеми пешками связанной группы.
    // KS-4043: на клик подсвечиваем клетки ВСЕХ подкомпонент блока
    // (объединение по `block.ids`).
    const squares = squaresForMetricBlock(subterms, blockKey, {
      fen: metrics.fenForSubterms,
    });
    onHighlightSquares?.({ id: blockKey, squares });
  };

  const rows = useMemo(() => {
    if (!metrics.subterms) return [] as MetricBlockRow[];
    // KS-4043: вкладка теперь показывает агрегированные блоки, а не
    // строки по id. Подкомпоненты вне 7 блоков (`space`, `king_attackers_*`,
    // `king_safe_check_*`, любые `psqt_*`) сознательно отбрасываются —
    // см. `metricBlocks.ts` и описание задачи.
    const all = buildMetricBlockRows(metrics.subterms, phase);
    // Сортировка: блоки с непустым весом по убыванию `|diff|`; пустые
    // (`score===0`) сохраняют исходный порядок Gherkin'а (материал →
    // структура → … → проходные).
    const nonEmpty = all
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    const empty = all.filter((r) => r.score === 0);
    const ordered = [...nonEmpty, ...empty];
    if (!hideTiny) return ordered;
    return ordered.filter((r) => r.score >= 1);
  }, [metrics.subterms, phase, hideTiny]);

  const maxAbs = rows.length > 0 ? Math.max(...rows.map((r) => r.score)) : 0;

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
            key={row.key}
            row={row}
            mode={mode}
            maxAbs={maxAbs}
            selected={selectedMetricId === row.key}
            onSelect={() => handleSelect(row.key)}
            t={tForLabel}
          />
        ))}
      </div>
    </div>
  );
}
