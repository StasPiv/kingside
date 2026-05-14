import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  PrecisionAttemptDetail,
  PrecisionMoveDto,
  PuzzleDto,
} from '@kingside/shared';
import { api } from '../api';
import { puzzleApi } from '../api-puzzle';
import { PuzzleBoard } from '../components/PuzzleBoard';
// KS-2754: вместо PostGameReview (требует WDL distribution, которой
// у PrecisionMoveDto нет) — собственный компонент с полной аннотацией
// партии (user + engine), классификацией и сильнейшими ходами.
import { PrecisionAttemptReview } from '../components/precision/PrecisionAttemptReview';
// KS-3003 (ADR-065 §5.1.1, F2): 5-балльная плашка над разбором заменяет
// бывшую бинарную «Preserved/Lost» Result-cell в summary.
import { PrecisionScoreBlock } from '../components/precision/PrecisionScoreBlock';
import type { MoveClass } from '../utils/moveClassification';
// KS-3040: «Потери преимущества» = net drop в win-probability,
// клемпнутый в [0..100]%. Раньше это была сумма drops без клемпы.
import { computeAdvantageLossPct } from '../utils/precisionAdvantageLoss';

/**
 * KS-2719 F4 / KS-2741 / ADR-056 §3.4 + §5. Detail-страница одной
 * precision-попытки.
 *
 * Источник:
 *  - `GET /precision/attempts/:attemptId` — основной snapshot
 *    (KS-2718, контракт `PrecisionAttemptDetail` из @kingside/shared).
 *  - `GET /puzzles/:id` — дополнительно тянем стартовый `fen` пазла:
 *    backend KS-2718 НЕ возвращает `initialFen` в детали попытки, а
 *    `PostGameReview` от него зависит. KS-2741: до фикса фронт ожидал
 *    `data.initialFen/playedSans/userSide` и падал на `data.playedSans
 *    is undefined` в `useMemo finalFen` после `setData(res)`.
 *
 * # Реконструкция playedSans / userSide
 *  - `userSide` — берём из FEN'а пазла (side-to-move на старте после
 *    blunder'а соперника = решатель).
 *  - `playedSans` — реконструируем из `moves[].playedUci` (только
 *    user-ходы; engine-ходы не приходят, поэтому SAN-нотация показывает
 *    только полуходы решающего, без ответных). Это ОК для PostGameReview
 *    в режиме detail-страницы — основная цель видеть свои ходы и их
 *    оценки. Лучше иметь частичный список, чем краш.
 *
 * # Состояния
 *  - loading: skeleton (спиннер).
 *  - error: 404/401/5xx → блок «попытка не найдена».
 *  - ready: summary + sparkline + bar-chart classifications + PostGameReview.
 */

type PageState = 'loading' | 'ready' | 'error';

const CLASS_COLORS: Record<MoveClass, string> = {
  best: '#27ae60',
  good: '#7fbf7f',
  inaccuracy: '#f1c40f',
  mistake: '#e67e22',
  blunder: '#c0392b',
};

const CLASS_ORDER: MoveClass[] = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
];

/**
 * KS-2754 follow-up: собираем PGN-строку попытки для открытия в
 * мастерской / `/analysis/:id`. Старт = `puzzle.fen` через
 * `[SetUp "1"][FEN "..."]`. Полуходы — пара user playedUci + engineUci
 * (engineUci может быть null на последнем user-ходе или legacy-попытке;
 * тогда engine-полуход не добавляется).
 */
function buildAttemptPgn(
  initialFen: string,
  moves: PrecisionMoveDto[],
  meta: { event: string; site: string; attemptId: string },
): string {
  const c = new Chess(initialFen);
  const sans: string[] = [];
  for (const m of moves) {
    try {
      const userMv = c.move({
        from: m.playedUci.slice(0, 2),
        to: m.playedUci.slice(2, 4),
        promotion: m.playedUci.length > 4 ? m.playedUci[4] : undefined,
      });
      if (!userMv) break;
      sans.push(userMv.san);
      if (m.engineUci) {
        const engineMv = c.move({
          from: m.engineUci.slice(0, 2),
          to: m.engineUci.slice(2, 4),
          promotion:
            m.engineUci.length > 4 ? m.engineUci[4] : undefined,
        });
        if (engineMv) sans.push(engineMv.san);
      }
    } catch {
      break;
    }
  }
  // movetext с нумерацией от исходной позиции (chess.js знает счётчик
  // полных ходов из FEN-стартового состояния и подставит правильный
  // префикс через `pgn()`).
  const headers = [
    `[Event "${meta.event}"]`,
    `[Site "${meta.site}"]`,
    `[Round "${meta.attemptId.slice(0, 8)}"]`,
    `[Result "*"]`,
    `[SetUp "1"]`,
    `[FEN "${initialFen}"]`,
  ].join('\n');
  // Chess.js может сам отдать PGN, но он завязан на внутреннее состояние;
  // здесь нам важна стабильность с initial-FEN, поэтому собираем вручную.
  // Move-numbering на парсере /analysis восстанавливается из FEN+SAN.
  const startParts = initialFen.split(' ');
  const startMvNum = parseInt(startParts[5] || '1', 10);
  const startIsWhite = startParts[1] === 'w';
  const movetext: string[] = [];
  for (let i = 0; i < sans.length; i++) {
    // Полуход относительно стартовой позиции.
    const halfFromStart = i; // 0-based
    const totalHalf = halfFromStart + (startIsWhite ? 0 : 1);
    const fullMv = startMvNum + Math.floor(totalHalf / 2);
    const isWhiteHalf = totalHalf % 2 === 0;
    if (i === 0 && !startIsWhite) {
      movetext.push(`${fullMv}...`);
    } else if (isWhiteHalf) {
      movetext.push(`${fullMv}.`);
    }
    movetext.push(sans[i]);
  }
  movetext.push('*');
  return `${headers}\n\n${movetext.join(' ')}`;
}

function sideFromFen(fen: string): 'w' | 'b' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'b' : 'w';
}

export function PrecisionAttemptPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();

  const [state, setState] = useState<PageState>('loading');
  const [openingAnalysis, setOpeningAnalysis] = useState(false);
  const [data, setData] = useState<PrecisionAttemptDetail | null>(null);
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const [reviewFen, setReviewFen] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!id) {
      setState('error');
      return;
    }
    setState('loading');
    try {
      const detail = await api.get<PrecisionAttemptDetail>(
        `/precision/attempts/${encodeURIComponent(id)}`,
      );
      // Дальше тянем puzzle для FEN/userSide. Если 404/5xx — деградируем
      // до error-state. Запрос отдельный, ошибка не должна валить весь
      // экран если detail успел.
      const pz = await puzzleApi
        .getById(detail.puzzleId)
        .catch(() => null as PuzzleDto | null);
      setData(detail);
      setPuzzle(pz);
      setState('ready');
    } catch {
      setData(null);
      setPuzzle(null);
      setState('error');
    }
  }, [id]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const initialFen = puzzle?.fen ?? '';
  const userSide: 'w' | 'b' = puzzle ? sideFromFen(puzzle.fen) : 'w';

  // Доска: при выбранном reviewFen — он, иначе финальная позиция
  // (играем user-ход с последнего fenBefore — promежуточный engine-ход
  // не нужен на этом представлении, итоговая доска приблизительна).
  const finalFen = (() => {
    if (!data || data.moves.length === 0) return initialFen;
    const last = data.moves[data.moves.length - 1];
    try {
      const c = new Chess(last.fenBefore);
      c.move({
        from: last.playedUci.slice(0, 2),
        to: last.playedUci.slice(2, 4),
        promotion:
          last.playedUci.length > 4 ? last.playedUci[4] : undefined,
      });
      return c.fen();
    } catch {
      return last.fenBefore;
    }
  })();

  if (state === 'loading') {
    return (
      <div
        className="precision-attempt-page"
        data-testid="precision-attempt-page"
        data-state="loading"
      >
        <p>{t('common.loading', 'Loading…')}</p>
      </div>
    );
  }

  if (state === 'error' || !data) {
    return (
      <div
        className="precision-attempt-page"
        data-testid="precision-attempt-page"
        data-state="error"
      >
        <p>
          {t(
            'precisionAttempt.notFound',
            'Attempt not found or no longer available.',
          )}
        </p>
        <Link to="/precision" data-testid="precision-attempt-back">
          ← {t('precision.backToAll', 'All puzzles')}
        </Link>
      </div>
    );
  }

  const orientation: 'white' | 'black' = userSide === 'w' ? 'white' : 'black';
  const accuracyText = `${Math.round(data.accuracyPercent)}%`;
  // KS-3040: «Потери преимущества» — раньше выводили `wdlLeakSum * 100`,
  // где `wdlLeakSum` — кумулятивная сумма per-move drops в signed
  // WDL-scale [0..2N]. Для многоходовых попыток с большими просадками
  // сумма превышала 1.0 → UI показывал «122%», что математически
  // невалидно для процента «насколько просело преимущество».
  // Перешли на net drop `(wdlAtStart - wdlAtEnd) / 2` (см.
  // `computeAdvantageLossPct` — там же unit-тесты).
  const wdlLeakText = `${computeAdvantageLossPct(data.wdlAtStart, data.wdlAtEnd)}%`;

  // KS-3003 (ADR-065 §5.1.1): бинарная «Preserved/Lost/Aborted» Result-cell
  // удалена. Её заменил `<PrecisionScoreBlock>` сверху раздела «Разбор».
  // `data-result` на корне страницы оставляем для e2e/аналитики — это
  // чистый mapping `solved + endReason`, UI-плашки больше нет.
  const resultKey: 'preserved' | 'lost' | 'aborted' =
    data.endReason === 'aborted'
      ? 'aborted'
      : data.solved
        ? 'preserved'
        : 'lost';

  // Sparkline:
  // - Первая точка = СТАРТ (wdlBefore первого user-хода) — позиция,
  //   которую дала задача. По ней пользователь видит цель: «удержать
  //   выигрыш» (если W>>L), «удержать ничью» (D доминирует) и т.п.
  // - Последующие точки = wdlAfter каждого user-хода (POV user).
  // Подпись точки = PGN-нотация + W/D/L% (для старта — «Старт»).
  const firstMove = data.moves[0];
  type SparkPoint = {
    label: string;
    /** y в [0..1] (win-chance), либо null если данных нет — точка
     *  не рисуется, линия рвётся. */
    y: number | null;
  };
  const startPoint: SparkPoint = (() => {
    const startWdl =
      firstMove?.wdlBefore && typeof firstMove.wdlBefore === 'object'
        ? firstMove.wdlBefore
        : null;
    const y = startWdl
      ? Math.max(0, Math.min(1, startWdl.w / 1000))
      : null;
    const wdlText = startWdl
      ? `${Math.round(startWdl.w / 10)}/${Math.round(startWdl.d / 10)}/${Math.round(startWdl.l / 10)}%`
      : null;
    const moveLabel = t('precisionAttempt.sparkline.start', 'Start');
    return {
      label: wdlText ? `${moveLabel} — ${wdlText}` : moveLabel,
      y,
    };
  })();
  const movePoints: SparkPoint[] = data.moves.map((m) => {
    let san: string = m.playedUci;
    try {
      const c = new Chess(m.fenBefore);
      const mv = c.move({
        from: m.playedUci.slice(0, 2),
        to: m.playedUci.slice(2, 4),
        promotion: m.playedUci.length > 4 ? m.playedUci[4] : undefined,
      });
      if (mv) san = mv.san;
    } catch {
      /* fallback: показываем UCI */
    }
    // KS-2754 follow-up: подпись точки = стандартная PGN-нотация +
    // полная WDL-тройка из wdlAfter (W/D/L%). Белые: `N. SAN — W/D/L%`,
    // чёрные: `N... SAN — W/D/L%`. movenum и сторона из FEN.
    const parts = m.fenBefore.split(' ');
    const mvNum = parseInt(parts[5] || '1', 10);
    const isWhite = parts[1] === 'w';
    const moveLabel = isWhite ? `${mvNum}. ${san}` : `${mvNum}... ${san}`;
    const wdl = m.wdlAfter && typeof m.wdlAfter === 'object' ? m.wdlAfter : null;
    // Линия sparkline по win-chance — главная компонента из W/D/L.
    const y = wdl ? Math.max(0, Math.min(1, wdl.w / 1000)) : null;
    const wdlText = wdl
      ? `${Math.round(wdl.w / 10)}/${Math.round(wdl.d / 10)}/${Math.round(wdl.l / 10)}%`
      : null;
    const label = wdlText ? `${moveLabel} — ${wdlText}` : moveLabel;
    return { label, y };
  });
  const sparkPoints: SparkPoint[] = [startPoint, ...movePoints];

  // Bar-chart distribution: shared-контракт = `classCounts`.
  const totalClassified = CLASS_ORDER.reduce(
    (sum, c) => sum + (data.classCounts[c] ?? 0),
    0,
  );

  const handleSelect = ({ fenBefore }: { fenBefore: string }) =>
    setReviewFen(fenBefore);

  return (
    <div
      className="precision-attempt-page"
      data-testid="precision-attempt-page"
      data-state="ready"
      data-result={resultKey}
      data-half-moves={String(data.halfMovesPlayed)}
    >
      <header className="precision-attempt-page__header">
        <Link
          to="/precision"
          className="precision-attempt-page__back"
          data-testid="precision-attempt-back"
        >
          ← {t('precision.backToAll', 'All puzzles')}
        </Link>
        <h1>
          {t('precisionAttempt.title', 'Attempt #{{id}}', {
            id: data.attemptId.slice(0, 8),
          })}
        </h1>
        {/* KS-2754 follow-up: переход в мастерскую для глубокого
            анализа разобранной попытки В НОВОЙ ВКЛАДКЕ. Сначала
            POST /analyses создаёт запись с PGN, затем window.open
            на /analysis/:id. Кнопка скрыта пока initialFen не пришёл
            (puzzleApi.getById ещё в полёте) — без него PGN неполный. */}
        {initialFen && data.moves.length > 0 && (
          <button
            type="button"
            className="precision-attempt-page__open-workshop"
            data-testid="precision-attempt-open-workshop"
            disabled={openingAnalysis}
            onClick={async () => {
              if (openingAnalysis) return;
              setOpeningAnalysis(true);
              const pgn = buildAttemptPgn(initialFen, data.moves, {
                event: t('precisionAttempt.title', 'Attempt #{{id}}', {
                  id: data.attemptId.slice(0, 8),
                }),
                site: 'kingside.site',
                attemptId: data.attemptId,
              });
              const title = t(
                'precisionAttempt.title',
                'Attempt #{{id}}',
                { id: data.attemptId.slice(0, 8) },
              );
              try {
                const created = await api.post<{ id: string }>(
                  '/analyses',
                  { pgn, title, category: 'analysis' },
                );
                window.open(`/analysis/${created.id}`, '_blank');
              } catch {
                /* ignore — UI не упадёт */
              } finally {
                setOpeningAnalysis(false);
              }
            }}
          >
            {openingAnalysis
              ? t('common.loading', 'Loading…')
              : t(
                  'precisionAttempt.openInWorkshop',
                  'Open in workshop →',
                )}
          </button>
        )}
      </header>

      <section
        className="precision-attempt-page__summary"
        data-testid="precision-attempt-summary"
      >
        {/* KS-3003 (ADR-065 §5.1.1, F2): Result-cell удалён. 5-балльная
            оценка теперь живёт в `<PrecisionScoreBlock>` над разделом
            «Разбор партии». В summary остаются числовые показатели. */}
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.halfMoves', 'Half-moves')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {data.halfMovesPlayed}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.accuracy', 'Accuracy')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {accuracyText}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.wdlLeakSum', 'WDL leak total')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {wdlLeakText}
          </div>
        </div>
      </section>

      {sparkPoints.length > 0 && (
        <section
          className="precision-attempt-page__chart"
          data-testid="precision-attempt-sparkline"
        >
          <h2 className="precision-attempt-page__chart-title">
            {t('precisionAttempt.sparkline.title', 'WDL trajectory')}
          </h2>
          {/* Лейаут: подписи оси Y слева, график справа. flex-row. */}
          <div
            className="precision-attempt-page__sparkline-wrap"
            style={{ display: 'flex', alignItems: 'stretch', gap: '0.5rem' }}
          >
            <div
              className="precision-attempt-page__sparkline-yaxis"
              data-testid="precision-attempt-sparkline-yaxis"
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                fontSize: '0.7rem',
                opacity: 0.7,
                minWidth: '2.5em',
                textAlign: 'right',
              }}
            >
              <span>100%</span>
              <span>50%</span>
              <span>0%</span>
            </div>
            <svg
              className="precision-attempt-page__sparkline"
              viewBox="0 0 100 40"
              preserveAspectRatio="none"
              role="img"
              style={{ flex: 1 }}
              aria-label={t(
                'precisionAttempt.sparkline.aria',
                'WDL trajectory across half-moves',
              )}
            >
            <line
              x1="0"
              y1="20"
              x2="100"
              y2="20"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="0.5"
            />
            {(() => {
              const segs: string[] = [];
              let path = '';
              const n = Math.max(1, sparkPoints.length);
              sparkPoints.forEach((p, i) => {
                if (p.y == null) {
                  if (path) segs.push(path);
                  path = '';
                  return;
                }
                const x = (i / (n - 1 || 1)) * 100;
                const y = 40 - p.y * 40;
                path += path
                  ? ` L ${x.toFixed(2)} ${y.toFixed(2)}`
                  : `M ${x.toFixed(2)} ${y.toFixed(2)}`;
              });
              if (path) segs.push(path);
              return segs.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke="#4ea1f7"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              ));
            })()}
            {/* KS-2754 follow-up: дискретные точки в каждом полуходе, чтобы
                на короткой линии (2-4 ходов) было видно где какой ход
                сидит. preserveAspectRatio="none" растягивает SVG —
                поэтому рисуем эллипсами, чтобы кружки не сплющивались
                по X. */}
            {sparkPoints.map((p, i) => {
              if (p.y == null) return null;
              const n = Math.max(1, sparkPoints.length);
              const x = (i / (n - 1 || 1)) * 100;
              const y = 40 - p.y * 40;
              return (
                <ellipse
                  key={`pt-${i}`}
                  cx={x}
                  cy={y}
                  rx={1.5}
                  ry={3}
                  fill="#4ea1f7"
                  stroke="#0b1623"
                  strokeWidth={0.4}
                  data-testid={`precision-attempt-sparkline-point-${i}`}
                />
              );
            })}
            </svg>
          </div>
          {/* Подписи под точками. Слева оставляем margin под Y-axis. */}
          <div
            className="precision-attempt-page__sparkline-labels"
            data-testid="precision-attempt-sparkline-labels"
            style={{
              position: 'relative',
              height: '1.6em',
              marginTop: '0.25rem',
              marginLeft: '3em',
              fontSize: '0.75rem',
            }}
          >
            {sparkPoints.map((p, i) => {
              const n = Math.max(1, sparkPoints.length);
              const left = (i / (n - 1 || 1)) * 100;
              return (
                <span
                  key={`lbl-${i}`}
                  className="precision-attempt-page__sparkline-label"
                  data-testid={`precision-attempt-sparkline-label-${i}`}
                  style={{
                    position: 'absolute',
                    left: `${left}%`,
                    transform: 'translateX(-50%)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.label}
                </span>
              );
            })}
          </div>
        </section>
      )}

      {totalClassified > 0 && (
        <section
          className="precision-attempt-page__chart"
          data-testid="precision-attempt-bars"
        >
          <h2 className="precision-attempt-page__chart-title">
            {t(
              'precisionAttempt.classifications.title',
              'Move classifications',
            )}
          </h2>
          <ul className="precision-attempt-page__bars">
            {CLASS_ORDER.map((cls) => {
              const count = data.classCounts[cls] ?? 0;
              const pct = (count / totalClassified) * 100;
              return (
                <li
                  key={cls}
                  className="precision-attempt-page__bars-row"
                  data-testid={`precision-attempt-bar-${cls}`}
                  data-count={String(count)}
                >
                  <span className="precision-attempt-page__bars-label">
                    {t(
                      `precisionAttempt.classifications.${cls}`,
                      cls.charAt(0).toUpperCase() + cls.slice(1),
                    )}
                  </span>
                  <span className="precision-attempt-page__bars-track">
                    <span
                      className="precision-attempt-page__bars-fill"
                      style={{
                        width: `${pct.toFixed(1)}%`,
                        background: CLASS_COLORS[cls],
                      }}
                    />
                  </span>
                  <span className="precision-attempt-page__bars-count">
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* KS-3003 (ADR-065 §5.1.1, F2): 5-балльная плашка над разбором.
          Заменяет старую бинарную «Preserved/Lost» Result-cell в summary.
          Для legacy attempt'ов без WDL/cp (`score===null`) блок рисует
          null-state «—» с подписью «Score unavailable». */}
      <PrecisionScoreBlock
        score={data.score ?? null}
        scorePct={data.scorePct ?? null}
      />

      <section className="precision-attempt-page__review">
        <PuzzleBoard
          game={new Chess(reviewFen ?? finalFen ?? initialFen)}
          boardOrientation={orientation}
          enabled={false}
          onPieceDrop={() => false}
          lastMoveUci={null}
          status={resultKey === 'preserved' ? 'correct' : 'incorrect'}
        />
        {/* KS-2754: «Разбор партии» — полная аннотация партии (user
            + engine) c классификацией и сильнейшими ходами. Работает
            только когда есть initialFen (получили из puzzleApi.getById).
            Без него скрываем — не падаем. */}
        {initialFen && data.moves.length > 0 && (
          <PrecisionAttemptReview
            initialFen={initialFen}
            moves={data.moves}
            userSide={userSide}
            onSelectMove={handleSelect}
          />
        )}
      </section>
    </div>
  );
}
