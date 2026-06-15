/**
 * KS-4161 + KS-4163 (ADR-128 §5): публичная страница демо-репертуара
 * Opening Trainer. Доступна гостю и авторизованному.
 *
 * Загружает репертуар через `GET /opening-trainer/demo/:id` (формат —
 * `OpeningRepertoireDetailDto`, тот же, что у личных). SRS-сессия
 * проигрывается полностью локально:
 *   - `chess.js` валидирует ход и держит позицию;
 *   - `tree.nodes[fen].edges[*].moveUci` — ожидаемые ходы юзера;
 *   - бот-ходы тоже берутся из `edges` (детерминистично, первый edge);
 *   - прогресс пишется в `localStorage` (ключ
 *     `kingside.openingTrainer.demo.<id>`), восстанавливается при
 *     возвращении на страницу.
 *
 * Никаких POST-запросов: серверной сессии нет, лидерборд не пишется.
 * Гость видит CTA «Войдите, чтобы сохранять прогресс между устройствами
 * и видеть статистику». До появления seed-контента backend отдаёт 404 —
 * страница показывает заглушку «coming soon».
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { ApiError } from '../../ApiError';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import { PuzzleBoard } from '../../components/PuzzleBoard';
import { useSounds, soundEventFromSan } from '../../hooks/useSounds';
import { useAuth } from '../../context/AuthContext';
import type {
  OpeningRepertoireDetailDto,
  RepertoireEdge,
  RepertoireNode,
} from '@kingside/shared';

type Feedback =
  | { kind: 'correct' }
  | { kind: 'wrong'; expected: RepertoireEdge[] }
  | { kind: 'line-complete' }
  | { kind: 'hint'; moveSan: string }
  | null;

interface LocalProgress {
  score: number;
  correctMoves: number;
  wrongMoves: number;
  hintsUsed: number;
  learnedFens: string[];
}

const EMPTY_PROGRESS: LocalProgress = {
  score: 0,
  correctMoves: 0,
  wrongMoves: 0,
  hintsUsed: 0,
  learnedFens: [],
};

const BOT_DELAY_MS = 420;

function storageKey(id: string): string {
  return `kingside.openingTrainer.demo.${id}`;
}

function readProgress(id: string): LocalProgress {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return { ...EMPTY_PROGRESS };
    const parsed = JSON.parse(raw) as Partial<LocalProgress>;
    return {
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      correctMoves:
        typeof parsed.correctMoves === 'number' ? parsed.correctMoves : 0,
      wrongMoves:
        typeof parsed.wrongMoves === 'number' ? parsed.wrongMoves : 0,
      hintsUsed: typeof parsed.hintsUsed === 'number' ? parsed.hintsUsed : 0,
      learnedFens: Array.isArray(parsed.learnedFens)
        ? parsed.learnedFens.filter((f): f is string => typeof f === 'string')
        : [],
    };
  } catch {
    return { ...EMPTY_PROGRESS };
  }
}

function writeProgress(id: string, progress: LocalProgress): void {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(progress));
  } catch {
    /* ignore quota errors */
  }
}

function isPromotionAttempt(chess: Chess, from: string, to: string): boolean {
  const piece = chess.get(from as never);
  if (!piece || piece.type !== 'p') return false;
  const targetRank = to[1];
  return (
    (piece.color === 'w' && targetRank === '8') ||
    (piece.color === 'b' && targetRank === '1')
  );
}

export function OpeningTrainerDemoPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const isGuest = !user;
  const { playSound } = useSounds();

  const [demo, setDemo] = useState<OpeningRepertoireDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [chess, setChess] = useState<Chess | null>(null);
  const [currentFen, setCurrentFen] = useState<string | null>(null);
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [progress, setProgress] = useState<LocalProgress>(EMPTY_PROGRESS);
  const [submitting, setSubmitting] = useState(false);

  const learnedSetRef = useRef<Set<string>>(new Set());

  // Загрузка демо.
  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    openingTrainerApi
      .getDemoRepertoire(id)
      .then((data) => {
        if (cancelled) return;
        // Контракт KS-4162: на /demo/:id backend возвращает тот же
        // OpeningRepertoireDetailDto, что и на /repertoires/:id.
        setDemo(data as unknown as OpeningRepertoireDetailDto);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        const msg =
          err instanceof ApiError
            ? err.message
            : t(
                'openingTrainer.errors.demoLoadFailed',
                'Failed to load demo repertoire',
              );
        setLoadError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  // Bootstrap: позиция и прогресс из localStorage.
  useEffect(() => {
    if (!demo || !id) return;
    try {
      const game = new Chess(demo.tree.rootFen);
      setChess(game);
      setCurrentFen(demo.tree.rootFen);
      setLastMoveUci(null);
      setFeedback(null);
      const saved = readProgress(id);
      setProgress(saved);
      learnedSetRef.current = new Set(saved.learnedFens);
    } catch {
      setLoadError(
        t('openingTrainer.errors.invalidFen', 'Invalid position from server'),
      );
    }
  }, [demo, id, t]);

  const side = demo?.side ?? 'white';

  const currentNode: RepertoireNode | null = useMemo(() => {
    if (!demo || !currentFen) return null;
    return demo.tree.nodes[currentFen] ?? null;
  }, [demo, currentFen]);

  const persist = useCallback(
    (next: LocalProgress) => {
      if (!id) return;
      setProgress(next);
      writeProgress(id, next);
    },
    [id],
  );

  // Авто-ход бота: когда сейчас НЕ ход юзера и в дереве есть продолжение.
  useEffect(() => {
    if (!chess || !currentNode) return undefined;
    const turn: 'white' | 'black' = chess.turn() === 'w' ? 'white' : 'black';
    if (turn === side) return undefined;
    if (currentNode.edges.length === 0) return undefined;
    const edge = currentNode.edges[0];
    let cancelled = false;
    const tm = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const next = new Chess(chess.fen());
        const promotion =
          edge.moveUci.length > 4 ? (edge.moveUci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
        const move = next.move({
          from: edge.moveUci.slice(0, 2),
          to: edge.moveUci.slice(2, 4),
          promotion,
        });
        if (!move) return;
        setChess(next);
        setCurrentFen(edge.childFen);
        setLastMoveUci(edge.moveUci);
        playSound(soundEventFromSan(move.san));
      } catch {
        /* ignore */
      }
    }, BOT_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(tm);
    };
  }, [chess, currentNode, side, playSound]);

  const onPieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare || !chess || !currentNode || submitting) return false;
      const turn: 'white' | 'black' = chess.turn() === 'w' ? 'white' : 'black';
      if (turn !== side) return false;

      const promotion = isPromotionAttempt(chess, sourceSquare, targetSquare)
        ? 'q'
        : undefined;
      const test = new Chess(chess.fen());
      const moved = test.move({
        from: sourceSquare,
        to: targetSquare,
        promotion,
      });
      if (!moved) return false;
      const uci = sourceSquare + targetSquare + (promotion ?? '');
      playSound(soundEventFromSan(moved.san));

      const expectedEdge = currentNode.edges.find((e) => e.moveUci === uci);
      if (expectedEdge) {
        // Корректный ход — переход по дереву.
        setChess(test);
        setCurrentFen(expectedEdge.childFen);
        setLastMoveUci(uci);
        setFeedback({ kind: 'correct' });
        const wasLearned = learnedSetRef.current.has(currentNode.fen);
        if (!wasLearned) learnedSetRef.current.add(currentNode.fen);
        const next: LocalProgress = {
          ...progress,
          score: progress.score + 10,
          correctMoves: progress.correctMoves + 1,
          learnedFens: Array.from(learnedSetRef.current),
        };
        persist(next);
        playSound('puzzle-correct');
        // Финиш: если в новой позиции у юзера нет продолжений и нет
        // ответов бота — линия завершена.
        const after = demo?.tree.nodes[expectedEdge.childFen];
        if (after && after.edges.length === 0) {
          window.setTimeout(() => setFeedback({ kind: 'line-complete' }), 200);
        }
        return true;
      }

      // Неверный ход: показываем ожидаемые, откатываем доску.
      setSubmitting(true);
      setFeedback({ kind: 'wrong', expected: currentNode.edges });
      playSound('puzzle-incorrect');
      const wrongNext: LocalProgress = {
        ...progress,
        wrongMoves: progress.wrongMoves + 1,
      };
      persist(wrongNext);
      window.setTimeout(() => {
        try {
          setChess(new Chess(currentFen ?? demo!.tree.rootFen));
        } catch {
          /* ignore */
        }
        setSubmitting(false);
      }, 600);
      return true;
    },
    [
      chess,
      currentNode,
      submitting,
      side,
      playSound,
      progress,
      persist,
      currentFen,
      demo,
    ],
  );

  const handleHint = useCallback(() => {
    if (!currentNode || currentNode.edges.length === 0) return;
    const first = currentNode.edges[0];
    setFeedback({ kind: 'hint', moveSan: first.moveSan });
    const next: LocalProgress = {
      ...progress,
      hintsUsed: progress.hintsUsed + 1,
    };
    persist(next);
  }, [currentNode, progress, persist]);

  const handleRestart = useCallback(() => {
    if (!demo) return;
    try {
      setChess(new Chess(demo.tree.rootFen));
      setCurrentFen(demo.tree.rootFen);
      setLastMoveUci(null);
      setFeedback(null);
    } catch {
      /* ignore */
    }
  }, [demo]);

  const handleResetProgress = useCallback(() => {
    if (!id) return;
    learnedSetRef.current = new Set();
    persist({ ...EMPTY_PROGRESS });
    handleRestart();
  }, [id, persist, handleRestart]);

  const boardEnabled = useMemo(
    () => Boolean(chess && !submitting && feedback?.kind !== 'line-complete'),
    [chess, submitting, feedback],
  );

  return (
    <div
      className="opening-trainer-demo-page"
      data-testid="opening-trainer-demo-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <header className="opening-trainer-demo-page__header">
        <Link
          to="/opening-trainer"
          className="opening-trainer-demo-page__back"
          data-testid="opening-trainer-demo-back"
        >
          &larr; {t('openingTrainer.demo.back', 'Back to lobby')}
        </Link>
        <h1>
          {demo?.title ?? t('openingTrainer.demo.title', 'Demo repertoire')}
        </h1>
        {demo?.description && (
          <p className="opening-trainer-demo-page__description">
            {demo.description}
          </p>
        )}
      </header>

      {loading && (
        <div className="loading" data-testid="opening-trainer-demo-loading">
          {t('common.loading')}
        </div>
      )}

      {!loading && notFound && (
        <section
          className="empty-state"
          data-testid="opening-trainer-demo-empty"
        >
          <p>
            {t(
              'openingTrainer.demo.empty',
              'Demo repertoires are coming soon — check back later.',
            )}
          </p>
          <Link to="/opening-trainer" className="btn">
            {t('openingTrainer.demo.backCta', 'Back to lobby')}
          </Link>
        </section>
      )}

      {!loading && !notFound && loadError && (
        <div className="error" data-testid="opening-trainer-demo-error">
          {loadError}
        </div>
      )}

      {!loading && !notFound && !loadError && demo && chess && (
        <section
          className="opening-trainer-demo-page__body"
          data-testid="opening-trainer-demo-body"
        >
          <div className="opening-trainer-demo-page__counters">
            <span data-testid="opening-trainer-demo-score">
              {t('openingTrainer.session.score', 'Score')}:{' '}
              <b>{progress.score}</b>
            </span>
            <span>
              ✓ <b>{progress.correctMoves}</b>
            </span>
            <span>
              ✗ <b>{progress.wrongMoves}</b>
            </span>
            <span>
              💡 <b>{progress.hintsUsed}</b>
            </span>
          </div>

          <div className="opening-trainer-demo-page__board">
            <PuzzleBoard
              game={chess}
              boardOrientation={side}
              enabled={boardEnabled}
              onPieceDrop={onPieceDrop}
              lastMoveUci={lastMoveUci}
              status={
                feedback?.kind === 'correct'
                  ? 'correct'
                  : feedback?.kind === 'wrong'
                    ? 'incorrect'
                    : null
              }
            />
          </div>

          <aside className="opening-trainer-demo-page__sidebar">
            {feedback?.kind === 'correct' && (
              <div className="opening-trainer-feedback opening-trainer-feedback--correct">
                ✓ {t('openingTrainer.session.correct', 'Correct')}
              </div>
            )}
            {feedback?.kind === 'wrong' && (
              <div
                className="opening-trainer-feedback opening-trainer-feedback--wrong"
                data-testid="opening-trainer-demo-wrong"
              >
                ✗ {t('openingTrainer.session.wrong', 'Not in the repertoire')}
                {feedback.expected.length > 0 && (
                  <div className="opening-trainer-feedback__expected">
                    {t('openingTrainer.session.expected', 'Expected')}:{' '}
                    {feedback.expected.map((m) => m.moveSan).join(', ')}
                  </div>
                )}
              </div>
            )}
            {feedback?.kind === 'line-complete' && (
              <div
                className="opening-trainer-feedback opening-trainer-feedback--done"
                data-testid="opening-trainer-demo-line-complete"
              >
                🏁{' '}
                {t(
                  'openingTrainer.session.lineComplete',
                  'Line completed',
                )}
              </div>
            )}
            {feedback?.kind === 'hint' && (
              <div className="opening-trainer-feedback opening-trainer-feedback--hint">
                💡 {t('openingTrainer.session.hint', 'Hint')}:{' '}
                {feedback.moveSan}
              </div>
            )}

            <div className="opening-trainer-demo-page__controls">
              <button
                type="button"
                className="btn"
                onClick={handleHint}
                disabled={
                  submitting ||
                  !currentNode ||
                  currentNode.edges.length === 0 ||
                  (chess.turn() === 'w' ? 'white' : 'black') !== side
                }
                data-testid="opening-trainer-demo-hint"
              >
                💡 {t('openingTrainer.session.hintBtn', 'Hint')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleRestart}
                data-testid="opening-trainer-demo-restart"
              >
                ↻{' '}
                {t(
                  'openingTrainer.demo.restart',
                  'Restart line',
                )}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleResetProgress}
                data-testid="opening-trainer-demo-reset"
              >
                {t(
                  'openingTrainer.demo.resetProgress',
                  'Reset progress',
                )}
              </button>
            </div>

            {isGuest && (
              <div
                className="opening-trainer-demo-page__guest"
                data-testid="opening-trainer-demo-guest-cta"
              >
                <p>
                  {t(
                    'openingTrainer.demo.guest.message',
                    'Sign in to keep progress across devices and see your statistics.',
                  )}
                </p>
                <Link
                  to="/login"
                  className="btn btn-primary"
                  data-testid="opening-trainer-demo-guest-cta-link"
                >
                  {t('openingTrainer.demo.guest.cta', 'Sign in')}
                </Link>
              </div>
            )}
          </aside>
        </section>
      )}
    </div>
  );
}
