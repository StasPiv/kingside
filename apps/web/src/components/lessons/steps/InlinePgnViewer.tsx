import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';

import { MemoChessboard } from '../../MemoChessboard';

/**
 * KS-1999: интерактивный просмотрщик PGN внутри `GameReviewStep`.
 *
 * Что делает:
 *  - парсит PGN через `chess.js` (`new Chess(); chess.loadPgn(pgn)`),
 *  - строит цепочку ходов `{ san, from, to, fenAfter }`,
 *  - показывает доску (`<MemoChessboard>`) для текущего ply'а,
 *  - под доской — список ходов с подсветкой активного,
 *  - кнопки навигации `«|<` / `<` / `>` / `>|`,
 *  - клик по ходу в списке → прыжок на эту позицию,
 *  - стрелки клавиатуры ←/→ — листают ходы (focus на корне viewer'а).
 *
 * Что НЕ делает (по задаче):
 *  - не подключает Stockfish/WASM,
 *  - не редактирует PGN,
 *  - не показывает сырой PGN текстом.
 *
 * Если PGN нечитаемый или пустой — рендерит фолбэк «не получилось
 * разобрать партию». Никаких unhandled-ошибок наружу.
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const LAST_MOVE_HIGHLIGHT = 'rgba(255, 213, 0, 0.55)';

interface ParsedMove {
  san: string;
  from: string;
  to: string;
  fenAfter: string;
}

interface ParsedPgn {
  ok: true;
  startFen: string;
  moves: ParsedMove[];
}

interface ParsedPgnError {
  ok: false;
}

function parsePgn(pgn: string): ParsedPgn | ParsedPgnError {
  if (!pgn || !pgn.trim()) return { ok: false };
  try {
    const game = new Chess();
    game.loadPgn(pgn);
    const headers = game.getHeaders();
    const setup = headers.SetUp === '1' && typeof headers.FEN === 'string';
    const startFen = setup ? headers.FEN : INITIAL_FEN;
    const replay = new Chess(startFen);
    const moves: ParsedMove[] = [];
    for (const verbose of game.history({ verbose: true })) {
      const applied = replay.move({
        from: verbose.from,
        to: verbose.to,
        promotion: verbose.promotion,
      });
      if (!applied) {
        // chess.js дал нам ход, но replay не принял — корраптный PGN.
        // Возвращаем то что собрали; UI всё равно покажет хоть что-то.
        break;
      }
      moves.push({
        san: applied.san,
        from: applied.from,
        to: applied.to,
        fenAfter: replay.fen(),
      });
    }
    return { ok: true, startFen, moves };
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
  const parsed = useMemo(() => parsePgn(pgn), [pgn]);
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

  const { startFen, moves } = parsed;
  const total = moves.length;
  const safePly = Math.max(0, Math.min(total, ply));
  const fen = safePly === 0 ? startFen : moves[safePly - 1].fenAfter;
  const lastMove = safePly === 0 ? null : moves[safePly - 1];
  const squareStyles = lastMove
    ? {
        [lastMove.from]: { backgroundColor: LAST_MOVE_HIGHLIGHT },
        [lastMove.to]: { backgroundColor: LAST_MOVE_HIGHLIGHT },
      }
    : undefined;

  const goFirst = () => setPly(0);
  const goPrev = () => setPly((p) => Math.max(0, p - 1));
  const goNext = () => setPly((p) => Math.min(total, p + 1));
  const goLast = () => setPly(total);

  // Группируем ходы парами «N. white black» для вывода. SAN-список
  // строим как массив пар; для нечётных — пустая ячейка чёрного.
  const pairs: { number: number; white: ParsedMove | null; black: ParsedMove | null; whiteIdx: number; blackIdx: number }[] = [];
  for (let i = 0; i < total; i += 2) {
    pairs.push({
      number: i / 2 + 1,
      white: moves[i],
      black: moves[i + 1] ?? null,
      whiteIdx: i,
      blackIdx: i + 1,
    });
  }

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

      <ol
        className="inline-pgn-viewer__moves"
        data-testid="inline-pgn-viewer-moves"
      >
        {pairs.map(({ number, white, black, whiteIdx, blackIdx }) => (
          <li key={number} className="inline-pgn-viewer__move-row">
            <span className="inline-pgn-viewer__move-number">
              {number}.
            </span>
            {white && (
              <button
                type="button"
                className={`inline-pgn-viewer__move${
                  safePly === whiteIdx + 1
                    ? ' inline-pgn-viewer__move--current'
                    : ''
                }`}
                data-testid={`inline-pgn-viewer-move-${whiteIdx}`}
                data-current={safePly === whiteIdx + 1 ? 'true' : 'false'}
                onClick={() => setPly(whiteIdx + 1)}
              >
                {white.san}
              </button>
            )}
            {black && (
              <button
                type="button"
                className={`inline-pgn-viewer__move${
                  safePly === blackIdx + 1
                    ? ' inline-pgn-viewer__move--current'
                    : ''
                }`}
                data-testid={`inline-pgn-viewer-move-${blackIdx}`}
                data-current={safePly === blackIdx + 1 ? 'true' : 'false'}
                onClick={() => setPly(blackIdx + 1)}
              >
                {black.san}
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
