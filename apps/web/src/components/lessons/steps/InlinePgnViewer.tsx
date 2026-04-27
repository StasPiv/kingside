import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MemoChessboard } from '../../MemoChessboard';
import {
  extractLeadingComment,
  parseAnnotatedPgn,
} from '../../../review/utils/PgnDeserializer';
import { ReviewMoveList } from '../../../review/components/ReviewMoveList';
import type { ChessMove } from '../../../review/types';

/**
 * KS-1999 / KS-2005: интерактивный просмотрщик PGN внутри `GameReviewStep`.
 *
 * Что делает:
 *  - парсит PGN через `parseAnnotatedPgn` (`apps/web/src/review/utils/`):
 *    извлекает ходы вместе с PGN-комментариями (`{...}`) и
 *    NAG-аннотациями (`!`, `?`, `!?`, `$N`),
 *  - показывает доску (`<MemoChessboard>`) для текущего ply'а,
 *  - под доской — нотацию через переиспользуемый `<ReviewMoveList>`
 *    (read-only режим — KS-2005). NAG-символы рендерятся рядом с ходом,
 *    встроенные комментарии — после хода в том же блоке,
 *  - кнопки навигации `«|<` / `<` / `>` / `>|`,
 *  - клик по ходу в нотации → прыжок на эту позицию,
 *  - стрелки клавиатуры ←/→ — листают ходы (focus на корне viewer'а).
 *  - комментарий к текущему ply'у дублируется отдельным блоком под доской
 *    (если у хода в PGN был `{...}`-комментарий) — для крупного видного
 *    текста авторских примечаний в уроке.
 *
 * Что НЕ делает (по задаче):
 *  - не подключает Stockfish/WASM,
 *  - не редактирует PGN,
 *  - не показывает сырой PGN текстом.
 *
 * Если PGN нечитаемый или пустой — рендерит фолбэк «не получилось
 * разобрать партию». Никаких unhandled-ошибок наружу.
 *
 * # KS-2005 — переход на ReviewMoveList
 *
 * До KS-2005 здесь был свой простой `<ol>`-список SAN-кнопок без поддержки
 * комментариев и NAG'ов — и собственный мини-парсер на `chess.js`. Это не
 * подходило для уроков-разборов Капабланки, где у каждого хода есть
 * текстовое примечание. Чтобы не плодить второй вьювер, переключились на
 * существующий `ReviewMoveList` из AnalysisPage (`review/components/`),
 * добавив ему опциональный `readOnly`-режим. Парсинг PGN тоже взяли из
 * `review/utils/PgnDeserializer` — `parseAnnotatedPgn` уже умеет
 * `{comments}` и `$NAG`/`!`/`?`-аннотации, а `chess.js` теряет и то и то.
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
  // ply: 0 = до первого хода (стартовая позиция); N = после N-го хода.
  const [ply, setPly] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // При смене PGN сбрасываем индекс — иначе старый ply будет вне диапазона.
  useEffect(() => {
    setPly(0);
  }, [pgn]);

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
        setPly((p) => Math.min(parsed.moves.length, p + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPly((p) => Math.max(0, p - 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setPly(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setPly(parsed.moves.length);
      }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [parsed]);

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

  const { startFen, moves, leadingComment } = parsed;
  const total = moves.length;
  const safePly = Math.max(0, Math.min(total, ply));
  const currentMove = safePly === 0 ? null : moves[safePly - 1];
  const fen = currentMove ? currentMove.after : startFen;
  const squareStyles = currentMove
    ? {
        [currentMove.from]: { backgroundColor: LAST_MOVE_HIGHLIGHT },
        [currentMove.to]: { backgroundColor: LAST_MOVE_HIGHLIGHT },
      }
    : undefined;

  const goFirst = () => setPly(0);
  const goPrev = () => setPly((p) => Math.max(0, p - 1));
  const goNext = () => setPly((p) => Math.min(total, p + 1));
  const goLast = () => setPly(total);

  // ReviewMoveList использует `globalIndex` как "номер текущего хода
  // в плоской истории" (0..N-1). У нас `ply` 0 — стартовая позиция,
  // поэтому при ply=0 передаём sentinel (-1), который не совпадёт ни
  // с одним globalIndex и список останется без подсветки текущего.
  const reviewCurrentIndex = currentMove ? currentMove.globalIndex : -1;
  const handleMoveClick = (move: ChessMove) => {
    setPly(move.globalIndex + 1);
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

      {/* KS-2005: «крупный» блок примечания к текущему ходу — под доской,
          чтобы авторский комментарий из PGN был сразу виден без скролла
          до нотации. В нотации он тоже остаётся (через ReviewMoveList).

          KS-2008: блок-обёртка `__current-comment-slot` рендерится ВСЕГДА
          и держит фиксированный min-height, чтобы доска не «прыгала»
          между ходами с комментариями разной длины. Внутренний `<p>` с
          testid'ом по-прежнему рендерится условно — тестовые querySelectors
          через `queryByTestId` остаются работоспособными.

          KS-2035: при ply=0 (доска в стартовой позиции) в этом же слоте
          дублируем leading-комментарий PGN — авторское вступление к
          партии. Это «комментарий к ходу 0»: переключение на следующий
          ход подменяет содержимое на комментарий к выбранному ходу.
          Параллельно тот же leading-комментарий отдельным блоком
          рендерится над списком ходов (см. ниже) — он там виден
          независимо от текущего ply. Дублирование преднамеренное:
          под доской — активный контекст, над нотацией — постоянный
          анонс партии. */}
      <div className="inline-pgn-viewer__current-comment-slot">
        {currentMove?.comment && (
          <p
            className="inline-pgn-viewer__current-comment"
            data-testid="inline-pgn-viewer-current-comment"
          >
            {currentMove.comment}
          </p>
        )}
        {!currentMove && leadingComment && (
          <p
            className="inline-pgn-viewer__current-comment"
            data-testid="inline-pgn-viewer-leading-comment-under-board"
          >
            {leadingComment}
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
          onClick={goFirst}
          disabled={safePly === 0}
          aria-label={t('lessons.gameReview.first', 'First')}
        >
          ⏮
        </button>
        <button
          type="button"
          className="inline-pgn-viewer__btn"
          data-testid="inline-pgn-viewer-prev"
          onClick={goPrev}
          disabled={safePly === 0}
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
          onClick={goNext}
          disabled={safePly === total}
          aria-label={t('lessons.gameReview.next', 'Next')}
        >
          ▶
        </button>
        <button
          type="button"
          className="inline-pgn-viewer__btn"
          data-testid="inline-pgn-viewer-last"
          onClick={goLast}
          disabled={safePly === total}
          aria-label={t('lessons.gameReview.last', 'Last')}
        >
          ⏭
        </button>
      </div>

      {/* KS-2035: leading-комментарий PGN — авторское вступление к
          партии (`{...}` между tag-pair'ами и `1.<move>`). Рендерим
          отдельным блоком над листом ходов: его смысл описывает партию
          в целом, а не конкретный ход, и он виден всегда — независимо
          от текущего ply. */}
      {leadingComment && (
        <p
          className="inline-pgn-viewer__leading-comment"
          data-testid="inline-pgn-viewer-leading-comment"
        >
          {leadingComment}
        </p>
      )}

      <div
        className="inline-pgn-viewer__moves"
        data-testid="inline-pgn-viewer-moves"
      >
        <ReviewMoveList
          history={moves}
          currentGlobalIndex={reviewCurrentIndex}
          onMoveClick={handleMoveClick}
          readOnly
        />
      </div>
    </div>
  );
}
