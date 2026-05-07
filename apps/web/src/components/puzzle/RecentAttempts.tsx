import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';

/**
 * KS-2498 / ADR-046 §5.8.
 *
 * Recent Attempts на /puzzles/stats. До этого тикета весь блок жил
 * inline в PuzzleStatsPage; единственный клик по строке всегда вёл на
 * /analysis с PGN решения. Для play-vs-engine пазлов это ломалось —
 * у них `moves=''`, и /analysis открывался пустым.
 *
 * Поведение по KS-2498:
 *  - Основной клик по строке → `/puzzle/:id`. Для play-vs-engine —
 *    `/puzzle/:id?source=precision` (KS-2547, ADR-048 §5; тот же query,
 *    что в листе PrecisionPage). Старый `?source=play-vs-engine`
 *    остаётся как silent backward-compat — читатели обязаны принимать
 *    оба значения.
 *  - Иконка «Анализ» (отдельная кнопка справа) рендерится только если
 *    `attempt.puzzle.solutionMode !== 'play-vs-engine'`. Клик собирает
 *    PGN из `puzzle.fen + puzzle.moves` и навигирует на /analysis с
 *    state — старое поведение, без регрессий.
 *
 * Источник `solutionMode` — KS-2494 (BE rev:120): `GET /puzzles/attempts`
 * теперь отдаёт `puzzle.solutionMode` для каждого attempt. Старый клиент
 * без поля интерпретируется как forced-line (default-кейс ниже), чтобы
 * не сломать рендер на mid-deploy окне.
 */

export type RecentAttempt = {
  id: string;
  puzzleId: string;
  solved: boolean;
  timeMs: number;
  ratingBefore: number;
  ratingAfter: number;
  createdAt: string;
  puzzle?: {
    fen?: string;
    moves?: string | string[];
    /** KS-2494 (BE rev:120). Отсутствует у старого api → forced-line. */
    solutionMode?: 'forced-line' | 'play-vs-engine';
  };
};

const PAGE_SIZE = 20;

export interface RecentAttemptsProps {
  attempts: RecentAttempt[];
}

export function RecentAttempts({ attempts }: RecentAttemptsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(attempts.length / PAGE_SIZE));
  const pageAttempts = attempts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const openPuzzleAnalysis = useCallback(
    async (puzzleId: string) => {
      try {
        const puzzle = await api.get<{ fen: string; moves: string | string[] }>(
          `/puzzles/${puzzleId}`,
        );
        const moves = Array.isArray(puzzle.moves)
          ? puzzle.moves
          : puzzle.moves.split(/\s+/).filter(Boolean);
        const { Chess } = await import('chess.js');
        const replay = new Chess(puzzle.fen);
        const sanMoves: string[] = [];
        for (const uci of moves) {
          try {
            const mv = replay.move({
              from: uci.slice(0, 2),
              to: uci.slice(2, 4),
              promotion: uci.length > 4 ? uci[4] : undefined,
            });
            if (mv) sanMoves.push(mv.san);
            else break;
          } catch {
            break;
          }
        }
        let pgn = '';
        const fenParts = puzzle.fen.split(' ');
        const startMoveNum = parseInt(fenParts[5] || '1', 10);
        const isBlackFirst = fenParts[1] === 'b';
        sanMoves.forEach((san, i) => {
          const moveNum = startMoveNum + Math.floor((i + (isBlackFirst ? 1 : 0)) / 2);
          if (i === 0 && isBlackFirst) pgn += `${moveNum}... `;
          else if ((i + (isBlackFirst ? 1 : 0)) % 2 === 0) pgn += `${moveNum}. `;
          pgn += san + ' ';
        });
        const fullPgn = `[FEN "${puzzle.fen}"]\n\n${pgn.trim()}`;
        navigate('/analysis', {
          state: { pgn: fullPgn, title: `Puzzle #${puzzleId.slice(0, 6)}` },
        });
      } catch {
        navigate(`/puzzle/${puzzleId}`);
      }
    },
    [navigate],
  );

  if (attempts.length === 0) return null;

  return (
    <div className="puzzle-stats-section" data-testid="recent-attempts">
      <h2>{t('puzzleStats.recentAttempts', 'Recent Attempts')}</h2>
      <div className="puzzle-stats-attempts">
        {pageAttempts.map((a) => {
          const isPvE = a.puzzle?.solutionMode === 'play-vs-engine';
          // KS-2547 / ADR-048 §5: канон `?source=precision`. Старый
          // `?source=play-vs-engine` остаётся как silent backward-compat
          // для уже разосланных ссылок (читатели обязаны принимать оба).
          const href = isPvE
            ? `/puzzle/${a.puzzleId}?source=precision`
            : `/puzzle/${a.puzzleId}`;
          return (
            <div
              key={a.id}
              className={`puzzle-stats-attempt${a.solved ? ' solved' : ' failed'}`}
              data-testid={`recent-attempts-row-${a.id}`}
              data-mode={isPvE ? 'play-vs-engine' : 'forced-line'}
            >
              <Link
                to={href}
                className="puzzle-stats-attempt__link"
                data-testid={`recent-attempts-link-${a.id}`}
              >
                #{a.puzzleId.slice(0, 6)}
              </Link>
              <span
                className={`puzzle-stats-attempt__result${a.solved ? ' correct' : ' wrong'}`}
              >
                {a.solved ? '✓' : '✗'}
              </span>
              <span className="puzzle-stats-attempt__time">
                {Math.round(a.timeMs / 1000)}s
              </span>
              <span className="puzzle-stats-attempt__rating">
                {Math.round(a.ratingBefore)} → {Math.round(a.ratingAfter)}
              </span>
              <span className="puzzle-stats-attempt__date">
                {new Date(a.createdAt).toLocaleDateString()}
              </span>
              {!isPvE && (
                <button
                  type="button"
                  className="puzzle-stats-attempt__analyze"
                  onClick={() => {
                    void openPuzzleAnalysis(a.puzzleId);
                  }}
                  data-testid={`recent-attempts-analyze-${a.id}`}
                  aria-label={t('puzzleStats.analyze', 'Analyze')}
                  title={t('puzzleStats.analyze', 'Analyze')}
                >
                  🔍
                </button>
              )}
            </div>
          );
        })}
      </div>
      {totalPages > 1 && (
        <div className="puzzle-pagination">
          <button disabled={page <= 0} onClick={() => setPage(page - 1)}>
            {t('puzzleBrowser.prev', 'Prev')}
          </button>
          <span className="puzzle-pagination__info">
            {page + 1} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
          >
            {t('puzzleBrowser.next', 'Next')}
          </button>
        </div>
      )}
    </div>
  );
}
