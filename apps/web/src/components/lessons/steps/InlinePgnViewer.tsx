import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { MemoChessboard } from '../../MemoChessboard';
import {
  extractLeadingComment,
  parseAnnotatedPgn,
} from '../../../review/utils/PgnDeserializer';
import { ReviewMoveList } from '../../../review/components/ReviewMoveList';
import { useReviewState } from '../../../review/useReviewState';
import type { ChessMove } from '../../../review/types';

/**
 * Интерактивный просмотрщик PGN внутри `GameReviewStep`.
 *
 * # KS-2040: общий движок с AnalysisPage
 *
 * Раньше у компонента был свой локальный `ply: number` state. После
 * KS-2040 под капотом используется тот же `useReviewState` хук, что и
 * на странице анализа партии (`AnalysisPage.tsx`) — единое ядро для
 * навигации, истории ходов и текущей позиции. Это даёт:
 *
 *   - идентичную семантику навигации (`gotoFirst`/`gotoPrevious`/
 *     `gotoNext`/`gotoLast`/`gotoMove`) — поведение в уроке совпадает
 *     с поведением на странице анализа;
 *   - поддержку вариаций «из коробки» (если в будущем PGN-разборы
 *     будут содержать `(...)` варианты, ReviewMoveList рендерит их
 *     корректно);
 *   - переиспользуемые компоненты UI: `MemoChessboard`,
 *     `ReviewMoveList` (в read-only режиме — KS-2005).
 *
 * Что компонент НЕ делает (по задаче KS-2040 §3):
 *   - не подключает Stockfish/WASM (это разбор партии, не анализ);
 *   - не редактирует PGN, не позволяет вводить ходы;
 *   - не показывает eval bar/graph и engine settings.
 *
 * # Авторские примечания (KS-2032 / KS-2035)
 *
 * - Pre-game комментарий PGN (`{...}` между tag-pair'ами и `1.<move>`)
 *   рендерится активной выноской НАД доской на ply=0;
 *   `extractLeadingComment` в `PgnDeserializer.ts`.
 * - Inline-комментарий выбранного хода рендерится выноской ПОД доской
 *   при ply≥1 в том же визуальном стиле.
 * - Нотация чистая — `{...}`-комментарии не дублируются в листе ходов
 *   (см. `movesWithoutInlineComments`). NAG-аннотации (`!`, `?`, `$N`)
 *   сохраняются — это часть SAN.
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const LAST_MOVE_HIGHLIGHT = 'rgba(255, 213, 0, 0.55)';

interface ParsedPgn {
  ok: true;
  startFen: string;
  moves: ChessMove[];
  /** KS-2035: leading-комментарий перед первым ходом (`{...}` между
   * tag-pair'ами и `1.<move>`). Если в PGN такого блока нет — undefined. */
  leadingComment?: string;
}

interface ParsedPgnError {
  ok: false;
}

function parseInlinePgn(pgn: string): ParsedPgn | ParsedPgnError {
  if (!pgn || !pgn.trim()) return { ok: false };
  try {
    const moves = parseAnnotatedPgn(pgn);
    const leadingComment = extractLeadingComment(pgn);
    // `parseAnnotatedPgn` стартует с FEN из `[FEN "..."]` либо со
    // стандартной начальной позиции. `before` первого хода — это и есть
    // стартовый FEN. Если ходов нет (например, headers + result), fall
    // back на FEN из заголовка либо стандартный.
    const fenMatch = pgn.match(/\[FEN\s+"([^"]+)"\]/);
    const headerFen = fenMatch?.[1];
    const startFen = moves[0]?.before ?? headerFen ?? INITIAL_FEN;
    if (moves.length === 0 && !headerFen) {
      // Ни одного хода и нет SetUp — считаем PGN бесполезным, показываем
      // ошибку парсинга, чтобы пользователь не получил пустую доску.
      return { ok: false };
    }
    return { ok: true, startFen, moves, leadingComment };
  } catch {
    return { ok: false };
  }
}

interface InlinePgnViewerProps {
  pgn: string;
  /** Опц. ориентация доски. По умолчанию white. */
  orientation?: 'white' | 'black';
  /** Размер доски. По умолчанию 360px. */
  boardSize?: number;
  /** testid корневого элемента. По умолчанию `inline-pgn-viewer`. */
  testId?: string;
}

export function InlinePgnViewer({
  pgn,
  orientation = 'white',
  boardSize = 360,
  testId = 'inline-pgn-viewer',
}: InlinePgnViewerProps) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseInlinePgn(pgn), [pgn]);
  const rootRef = useRef<HTMLDivElement>(null);

  // KS-2040: общий движок с AnalysisPage. `useReviewState` держит
  // history/currentMove/currentFen и навигацию. При смене PGN
  // переинициализируем initialFen и заливаем moves.
  const {
    history,
    currentMove,
    currentGlobalIndex,
    currentFen,
    setInitialFen,
    loadFromPgn,
    gotoMove,
    gotoFirst,
    gotoPrevious,
    gotoNext,
    gotoLast,
  } = useReviewState();

  useEffect(() => {
    if (!parsed.ok) return;
    // setInitialFen ВСЕГДА сбрасывает history → loadFromPgn после.
    setInitialFen(parsed.startFen);
    loadFromPgn(parsed.moves);
    // После loadFromPgn `currentMove` встаёт на последний ход
    // (стандартное поведение AnalysisPage). Для урока хочется
    // стартовать с позиции ДО первого хода — отдельным dispatch'ем
    // ниже через `gotoFirst`.
    gotoFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !parsed.ok) return;
    const onKey = (e: KeyboardEvent) => {
      // Срабатываем только когда фокус внутри viewer'а — иначе любая
      // стрелка на странице будет двигать ходы. Проверяем `contains`.
      const active = document.activeElement;
      if (!active || !root.contains(active)) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        gotoNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gotoPrevious();
      } else if (e.key === 'Home') {
        e.preventDefault();
        gotoFirst();
      } else if (e.key === 'End') {
        e.preventDefault();
        gotoLast();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [parsed, gotoNext, gotoPrevious, gotoFirst, gotoLast]);

  // KS-2035 (final): нотация «чистая» — без `{...}`-комментариев.
  // Авторские примечания живут только в активной выноске возле доски.
  // NAG-аннотации сохраняются — это часть SAN-нотации.
  // KS-2034: useMemo вызывается ДО early return по `parsed.ok`
  // (rules-of-hooks). Хук должен вызываться в одном и том же порядке
  // при каждом рендере.
  const movesWithoutInlineComments = useMemo(
    () => history.map((m) => ({ ...m, comment: undefined })),
    [history],
  );

  if (!parsed.ok) {
    return (
      <div
        className="inline-pgn-viewer inline-pgn-viewer--error"
        data-testid={testId}
        data-state="error"
      >
        <p className="inline-pgn-viewer__error">
          {t(
            'lessons.gameReview.pgnParseError',
            'Could not parse the game.',
          )}
        </p>
      </div>
    );
  }

  const { leadingComment } = parsed;
  // history после loadFromPgn содержит main-line moves курса. Counter
  // показывает позицию в main-line (как раньше "ply / total"). Если
  // currentMove сидит в вариации — globalIndex может быть вне
  // [0..history.length-1]; зажимаем для отображения counter'а.
  const total = history.length;
  const safePly = currentMove
    ? Math.min(total, Math.max(0, currentGlobalIndex + 1))
    : 0;
  const fen = currentFen;
  const squareStyles = currentMove
    ? {
        [currentMove.from]: { backgroundColor: LAST_MOVE_HIGHLIGHT },
        [currentMove.to]: { backgroundColor: LAST_MOVE_HIGHLIGHT },
      }
    : undefined;

  // Disabled-флаги: на ply=0 нет смысла first/prev; в конце линии —
  // next/last (учитываем что в конце currentMove !== null && !currentMove.next).
  const atStart = currentMove === null;
  const atEnd = currentMove !== null && !currentMove.next;

  // ReviewMoveList использует `globalIndex` как "номер текущего хода
  // в плоской истории" (0..N-1). Если currentMove === null — sentinel
  // (-1), не совпадёт ни с одним globalIndex.
  const reviewCurrentIndex = currentMove ? currentMove.globalIndex : -1;
  const handleMoveClick = (move: ChessMove) => {
    gotoMove(move);
  };

  return (
    <div
      ref={rootRef}
      className="inline-pgn-viewer"
      data-testid={testId}
      data-state="ready"
      data-ply={safePly}
      tabIndex={0}
    >
      {/* KS-2035: leading-комментарий PGN — авторское вступление к
          партии. На ply=0 (доска в стартовой позиции) показываем его
          активной выноской НАД доской. На ply≥1 этот слот пустой
          (схлопывается до 0), под доской работает обычный
          `__current-comment-slot` с комментарием выбранного хода. */}
      <div className="inline-pgn-viewer__leading-slot">
        {atStart && leadingComment && (
          <p
            className="inline-pgn-viewer__current-comment"
            data-testid="inline-pgn-viewer-leading-comment-above-board"
          >
            {leadingComment}
          </p>
        )}
      </div>

      <div
        className="inline-pgn-viewer__board"
        style={{ width: boardSize, maxWidth: '100%' }}
      >
        <MemoChessboard
          options={{
            position: fen,
            boardOrientation: orientation,
            allowDragging: false,
            showNotation: true,
            animationDurationInMs: 0,
            squareStyles,
          }}
        />
      </div>

      {/* KS-2008/KS-2035: блок-обёртка `__current-comment-slot`
          держит фиксированный min-height, чтобы доска не «прыгала»
          между ходами с комментариями разной длины. На ply=0 слот
          пустой — leading живёт в `__leading-slot` ВЫШЕ доски. */}
      <div className="inline-pgn-viewer__current-comment-slot">
        {currentMove?.comment && (
          <p
            className="inline-pgn-viewer__current-comment"
            data-testid="inline-pgn-viewer-current-comment"
          >
            {currentMove.comment}
          </p>
        )}
      </div>

      <div
        className="inline-pgn-viewer__controls"
        role="group"
        aria-label={t('lessons.gameReview.navLabel', 'Move navigation')}
      >
        <button
          type="button"
          className="inline-pgn-viewer__btn"
          data-testid="inline-pgn-viewer-first"
          onClick={gotoFirst}
          disabled={atStart}
          aria-label={t('lessons.gameReview.first', 'First')}
        >
          ⏮
        </button>
        <button
          type="button"
          className="inline-pgn-viewer__btn"
          data-testid="inline-pgn-viewer-prev"
          onClick={gotoPrevious}
          disabled={atStart}
          aria-label={t('lessons.gameReview.prev', 'Previous')}
        >
          ◀
        </button>
        <span
          className="inline-pgn-viewer__counter"
          data-testid="inline-pgn-viewer-counter"
          aria-live="polite"
        >
          {safePly}/{total}
        </span>
        <button
          type="button"
          className="inline-pgn-viewer__btn"
          data-testid="inline-pgn-viewer-next"
          onClick={gotoNext}
          disabled={atEnd}
          aria-label={t('lessons.gameReview.next', 'Next')}
        >
          ▶
        </button>
        <button
          type="button"
          className="inline-pgn-viewer__btn"
          data-testid="inline-pgn-viewer-last"
          onClick={gotoLast}
          disabled={atEnd}
          aria-label={t('lessons.gameReview.last', 'Last')}
        >
          ⏭
        </button>
      </div>

      <div
        className="inline-pgn-viewer__moves"
        data-testid="inline-pgn-viewer-moves"
      >
        <ReviewMoveList
          history={movesWithoutInlineComments}
          currentGlobalIndex={reviewCurrentIndex}
          onMoveClick={handleMoveClick}
          readOnly
        />
      </div>
    </div>
  );
}
