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
  squaresForMetric,
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
 * KS-4043 follow-up: значения от нашего Stockfish-trace `eval json`
 * приходят уже в пешках (X.XX), а не в сантипешках. Показываем как
 * есть с точностью до сотых — это совпадает с разрешающей способностью
 * движка и с привычной шкалой основной оценки в панели движка.
 *
 * Промежуточный шаг с делением на 100 (думал, что приходят сантипешки)
 * давал «0.00» везде на живых данных — откатил.
 */
function formatPawns(pawns: number): string {
  return pawns.toFixed(2);
}

function formatPawnsSigned(pawns: number): string {
  const sign = pawns >= 0 ? '+' : '';
  return `${sign}${pawns.toFixed(2)}`;
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
  /** KS-4043 follow-up: true, если блок раскрыт (виден список подкомпонент). */
  expanded: boolean;
  /** KS-4043 follow-up: клик-обработчик для раскрытия/сворачивания блока. */
  onToggle: () => void;
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
function BarRow({ row, mode, maxAbs, expanded, onToggle, t }: BarRowProps) {
  const selected = expanded;
  const onSelect = onToggle;
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

/**
 * KS-4043 follow-up: одна сырая подкомпонента блока, кликабельная.
 * При клике вызывается `onSelect(id)` — родитель подсвечивает клетки.
 */
interface ContributionRowProps {
  contribution: MetricBlockRow['contributions'][number];
  mode: CurrentPositionMetricsMode;
  maxAbs: number;
  selected: boolean;
  onSelect: () => void;
}

function ContributionRow({
  contribution,
  mode,
  maxAbs,
  selected,
  onSelect,
}: ContributionRowProps) {
  const ratio = maxAbs > 0 ? Math.min(1, Math.abs(contribution.diff) / maxAbs) : 0;
  const pct = (ratio * 50).toFixed(2);
  const isWhite = contribution.diff >= 0;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  const raw = isRawUnitContribution(contribution.id);
  return (
    <div
      className={`current-metrics-row current-metrics-row--contribution${
        selected ? ' current-metrics-row--selected' : ''
      }${mode === 'parallel' ? ' current-metrics-row--parallel' : ' current-metrics-row--diff'}`}
      data-testid={`current-metrics-contribution-${contribution.id}`}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
    >
      <span
        className="current-metrics-row__label"
        title={contribution.id + (raw ? ' (raw units)' : '')}
        tabIndex={-1}
      >
        {contribution.id}
        {raw ? ' *' : ''}
      </span>
      {mode === 'diff' ? (
        <>
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
          <span className="current-metrics-row__value">
            {formatPawnsSigned(contribution.diff)}
          </span>
        </>
      ) : (
        <div className="current-metrics-row__bars-stack">
          <div className="current-metrics-row__bars-stack-row" data-side="white">
            <span
              className="current-metrics-row__bar current-metrics-row__bar--white"
              style={{
                width: `${
                  maxAbs > 0
                    ? (Math.min(1, contribution.white / maxAbs) * 100).toFixed(2)
                    : 0
                }%`,
              }}
            />
            <span className="current-metrics-row__value current-metrics-row__value--inline">
              {formatPawns(contribution.white)}
            </span>
          </div>
          <div className="current-metrics-row__bars-stack-row" data-side="black">
            <span
              className="current-metrics-row__bar current-metrics-row__bar--black"
              style={{
                width: `${
                  maxAbs > 0
                    ? (Math.min(1, contribution.black / maxAbs) * 100).toFixed(2)
                    : 0
                }%`,
              }}
            />
            <span className="current-metrics-row__value current-metrics-row__value--inline">
              {formatPawns(contribution.black)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * KS-4043 follow-up: блок-строка + раскрываемый список подкомпонент.
 * Клик по самой строке-блоку — toggle раскрытия (подсветка клеток НЕ
 * включается). Клик по подкомпоненте — подсвечивает её клетки.
 */
interface BlockWithContributionsProps {
  row: MetricBlockRow;
  mode: CurrentPositionMetricsMode;
  maxAbs: number;
  expanded: boolean;
  selectedContributionId: string | null;
  onToggle: () => void;
  onSelectContribution: (id: string) => void;
  t: (key: string, def?: string) => string;
  /**
   * KS-4044. Если LLM вернула трактовку для этого блока — `verdict` и
   * `comment` рисуются под строкой блока. Если поле не задано (LLM
   */
}

function BlockWithContributions({
  row,
  mode,
  maxAbs,
  expanded,
  selectedContributionId,
  onToggle,
  onSelectContribution,
  t,
}: BlockWithContributionsProps) {
  return (
    <div className="current-metrics-block" data-testid={`current-metrics-block-${row.key}`}>
      <BarRow
        row={row}
        mode={mode}
        maxAbs={maxAbs}
        expanded={expanded}
        onToggle={onToggle}
        t={t}
      />
      {expanded && row.contributions.length > 0 && (
        <div
          className="current-metrics-block__contributions"
          data-testid={`current-metrics-block-contributions-${row.key}`}
          role="group"
        >
          {row.contributions.map((c) => (
            <ContributionRow
              key={c.id}
              contribution={c}
              mode={mode}
              maxAbs={maxAbs}
              selected={selectedContributionId === c.id}
              onSelect={() => onSelectContribution(c.id)}
            />
          ))}
        </div>
      )}
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
  // KS-4043 follow-up: двойная вложенность. Клик на строку-блок только
  // раскрывает/сворачивает его, ПОДСВЕТКУ клеток НЕ включает (блок —
  // агрегат, у него нет одной осмысленной выборки клеток). Подсветка
  // включается кликом на сырую подкомпоненту внутри раскрытого блока.
  const [expandedBlockKey, setExpandedBlockKey] =
    useState<MetricBlockKey | null>(null);
  // KS-4033 follow-up: id выбранной сырой подкомпоненты, по которой
  // подсвечены клетки. `null` — подсветки нет.
  const [selectedContributionId, setSelectedContributionId] = useState<
    string | null
  >(null);


  // При смене позиции снимаем подсветку и сворачиваем блок.
  const lastFenRef = useRef<string | null>(null);
  if (metrics.fenForSubterms !== lastFenRef.current) {
    lastFenRef.current = metrics.fenForSubterms;
    if (selectedContributionId !== null) {
      setSelectedContributionId(null);
      onHighlightSquares?.(null);
    }
    if (expandedBlockKey !== null) {
      setExpandedBlockKey(null);
    }
  }

  const handleBlockToggle = (blockKey: MetricBlockKey) => {
    setExpandedBlockKey((prev) => (prev === blockKey ? null : blockKey));
    // Сворачивание / переключение блока снимает подсветку — она была
    // привязана к подкомпоненте, которая теперь скрыта.
    if (selectedContributionId !== null) {
      setSelectedContributionId(null);
      onHighlightSquares?.(null);
    }
  };

  const handleContributionSelect = (contributionId: string) => {
    if (selectedContributionId === contributionId) {
      setSelectedContributionId(null);
      onHighlightSquares?.(null);
      return;
    }
    setSelectedContributionId(contributionId);
    const subterms = metrics.subterms ?? [];
    // KS-4038: передаём FEN — для `pawn_connected` хелпер расширяет
    // подсветку до полной связанной группы по правилу Stockfish-connected.
    const squares = squaresForMetric(subterms, contributionId, {
      fen: metrics.fenForSubterms,
    });
    onHighlightSquares?.({ id: contributionId, squares });
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
          <BlockWithContributions
            key={row.key}
            row={row}
            mode={mode}
            maxAbs={maxAbs}
            expanded={expandedBlockKey === row.key}
            selectedContributionId={selectedContributionId}
            onToggle={() => handleBlockToggle(row.key)}
            onSelectContribution={handleContributionSelect}
            t={tForLabel}
          />
        ))}
      </div>
    </div>
  );
}
