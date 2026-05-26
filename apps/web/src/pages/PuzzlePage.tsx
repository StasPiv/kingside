import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import { puzzleApi } from '../api-puzzle';
import { PuzzleBoard } from '../components/PuzzleBoard';
import { PromotionPicker, type PromotionPiece } from '../components/PromotionPicker';
import { HelpButton } from '../components/HelpButton';
import { MistakesDiaryHint } from '../components/puzzle/MistakesDiaryHint';
// KS-2488: блок «Из партии» (sourceGame) под доской пазла.
import { PuzzleSourceGame } from '../components/puzzle/PuzzleSourceGame';
import {
  PlayVsEngineRunner,
  type PlayVsEngineSubmit,
} from '../components/puzzle/PlayVsEngineRunner';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { useAuth } from '../context/AuthContext';
import type { PuzzleDto } from '@kingside/shared';
import { WasmEngineAdapter } from '../utils/engineAdapter';
import { openAnalysis } from '../utils/openAnalysis';
import { buildPuzzleAnalysisPgn } from '../utils/buildPuzzleAnalysisPgn';
import {
  buildBackUrl,
  buildPrecisionNextParams,
  detectPuzzleSection,
} from '../utils/puzzleNav';
// KS-3349 / KS-3350 (ADR-079 §3.4–3.5). API для авто-подбора +
// текущего precision-рейтинга (для дельты).
import { precisionApi } from '../api/precisionApi';

type PuzzleStatus = 'thinking' | 'checking' | 'correct' | 'incorrect';

export function PuzzlePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { playSound } = useSounds();
  const { user } = useAuth();
  const { id: puzzleId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  // KS-2657: ссылки из `/precision` всегда несут `?source=precision` —
  // это раздел «Тренировка точности», где ожидается PlayVsEngineRunner.
  // Используем как defensive-сигнал на случай, если backend в DTO
  // конкретного пазла отдал `solutionMode: 'forced-line'` (расхождение
  // данных в БД для generated пазлов). Фронт не должен подсовывать
  // студенту обычный SolutionRunner, если он явно зашёл за play-vs-
  // engine. Backend-фикс несоответствия `solution_mode` оформлен
  // отдельной задачей.
  // KS-2688: secition / backUrl используются для динамического заголовка,
  // хлебных крошек и кнопок возврата (раньше всё хардкодилось на
  // `/puzzles`, что уводило юзера со draft-фильтра precision).
  const section = detectPuzzleSection(searchParams);
  const fromPrecision = section === 'precision';
  const backUrl = useMemo(() => buildBackUrl(searchParams), [searchParams]);
  const sectionTitle = fromPrecision
    ? t('precision.title', 'Precision training')
    : t('puzzle.title', 'Puzzles');
  const sectionBackLabel = fromPrecision
    ? t('puzzle.backToPrecision', '← Back to Precision')
    : t('puzzle.backToPuzzles');
  const sectionBackButtonLabel = fromPrecision
    ? t('puzzle.backToPrecisionShort', 'Back to Precision')
    : t('puzzle.backToPuzzles');
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const isGenerated = (puzzle as unknown as { source?: string })?.source === 'generated';
  const [game, setGame] = useState<Chess | null>(null);
  const [status, setStatus] = useState<PuzzleStatus>('thinking');
  const [moveIndex, setMoveIndex] = useState(0);
  const [puzzleMoves, setPuzzleMoves] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [streak, setStreak] = useState(0);
  const [totalSolved, setTotalSolved] = useState(0);
  const [solutionMove, setSolutionMove] = useState<string | null>(null);
  const [altMoveMsg, setAltMoveMsg] = useState<string | null>(null);
  // KS-2034: setter не используется (флаг не выставляется в коде); сейчас
  // allSolved всегда false. Префикс `_` помечает осознанно
  // неиспользуемый элемент destructure.
  const [allSolved] = useState(false);
  const [ratingChange, setRatingChange] = useState<{ before: number; after: number } | null>(null);
  // KS-3349 (ADR-079 §3.5). Дельта precision-рейтинга (Glicko-1) после
  // PVE-попытки. Снимаем before на mount страницы пазла (когда
  // fromPrecision && user), after — после успешного submitAttempt.
  // `null` → блок не рендерится (гость / ещё не загружено / fetch упал).
  const [precisionRatingBefore, setPrecisionRatingBefore] = useState<number | null>(null);
  const [precisionRatingChange, setPrecisionRatingChange] = useState<{
    ratingBefore: number;
    ratingAfter: number;
    ratingDelta: number;
  } | null>(null);
  /**
   * KS-2969: модалка выбора фигуры при превращении пешки. До этого
   * forced-line раннер всегда подставлял promotion из expectedMove,
   * и игрок не мог выбрать другую фигуру.
   */
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: Square;
    to: Square;
  } | null>(null);
  const startTimeRef = useRef(Date.now());
  const attemptSubmittedRef = useRef(false);
  const userMovesRef = useRef<string[]>([]);
  const engineRef = useRef<WasmEngineAdapter | null>(null);
  const engineReadyRef = useRef(false);

  // Lazy-init engine on first need
  const getEngine = useCallback(async (): Promise<WasmEngineAdapter> => {
    if (engineRef.current && engineReadyRef.current) return engineRef.current;
    const engine = new WasmEngineAdapter();
    await engine.init();
    engineRef.current = engine;
    engineReadyRef.current = true;
    return engine;
  }, []);

  // Cleanup engine on unmount
  useEffect(() => {
    return () => { engineRef.current?.destroy(); engineRef.current = null; engineReadyRef.current = false; };
  }, []);

  // Track solved generated puzzles in localStorage
  const markSolved = useCallback((id: string) => {
    try {
      const key = 'solvedGeneratedPuzzles';
      const solved: string[] = JSON.parse(localStorage.getItem(key) || '[]');
      if (!solved.includes(id)) {
        solved.push(id);
        localStorage.setItem(key, JSON.stringify(solved));
      }
    } catch { /* ignore */ }
  }, []);

  // KS-2034: legacy `getSolvedIds()` удалён — не вызывался в коде. Сами
  // id хранятся через `markSolved` выше; чтение списка реализовано
  // прямо там, где требуется.

  const boardOrientation = useMemo(() => {
    if (!puzzle || !game) return 'white' as const;
    const setupGame = new Chess(puzzle.fen);
    const gen = (puzzle as unknown as { source?: string })?.source === 'generated';
    if (gen) {
      // Generated puzzles: player IS the side to move (no auto setup)
      return setupGame.turn() === 'w' ? 'white' as const : 'black' as const;
    }
    const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(' ');
    if (moves.length <= 1) {
      return setupGame.turn() === 'w' ? 'white' as const : 'black' as const;
    }
    // Lichess puzzles: setup move plays first, player is opposite side
    return setupGame.turn() === 'w' ? 'black' as const : 'white' as const;
  }, [puzzle, game]);

  const initPuzzle = useCallback((data: PuzzleDto) => {
    setPuzzle(data);
    const moves = Array.isArray(data.moves) ? data.moves : data.moves.split(' ');
    setPuzzleMoves(moves);

    const chess = new Chess(data.fen);
    const gen = (data as unknown as { source?: string }).source === 'generated';
    if (gen) {
      // Generated puzzles: no auto move, player finds moves[0]
      setGame(chess);
      setMoveIndex(0);
    } else if (moves.length > 1) {
      // Lichess puzzles: show pre-move position, then animate setup move
      setGame(chess);
      setMoveIndex(0);
      const uci = moves[0];
      setTimeout(() => {
        const post = new Chess(data.fen);
        const result = post.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        if (result) playSound(soundEventFromSan(result.san));
        setGame(post);
        setMoveIndex(1);
      }, 400);
    } else {
      setGame(chess);
      setMoveIndex(0);
    }
    setStatus('thinking');
    setSolutionMove(null);
    setAltMoveMsg(null);
    setRatingChange(null);
    // KS-2969: закрыть модалку выбора promotion при переключении пазла.
    setPendingPromotion(null);
    startTimeRef.current = Date.now();
    attemptSubmittedRef.current = false;
    userMovesRef.current = [];
  }, [playSound]);

  const loadPuzzle = useCallback(async (specificId?: string) => {
    setLoading(true);
    setError('');
    try {
      let data: PuzzleDto;
      if (specificId) {
        data = await puzzleApi.getById(specificId);
      } else {
        // KS-2732: на /precision «Next» обязан загружать только
        // play-vs-engine пазлы. Без этого фильтра backend `/puzzles/next`
        // возвращал любой пазл (включая forced-line без blunderMove), и
        // PVE-runner показывал «Соперник зевнул ходом ?».
        data = await puzzleApi.getNext(
          fromPrecision ? { solutionMode: 'play-vs-engine' } : undefined,
        );
        // KS-2732 defensive: если backend проигнорировал фильтр и всё
        // равно вернул forced-line пазл (mismatch данных в БД, или
        // backend ещё не выкатил поддержку query) — попробуем ещё раз
        // дёрнуть один-единственный раз, чтобы хотя бы шанс получить
        // правильный пазл. После второй неудачи покажем как есть, а
        // защитный fallback в `PlayVsEngineRunner` заменит «?» на общий
        // текст без UCI.
        if (
          fromPrecision &&
          data &&
          data.solutionMode !== 'play-vs-engine'
        ) {
          try {
            const retry = await puzzleApi.getNext({
              solutionMode: 'play-vs-engine',
            });
            if (retry && retry.solutionMode === 'play-vs-engine') {
              data = retry;
            }
          } catch {
            /* ignore — оставим первый ответ */
          }
        }
      }
      initPuzzle(data);
    } catch {
      setError('Failed to load puzzle');
    } finally {
      setLoading(false);
    }
  }, [fromPrecision, initPuzzle]);

  useEffect(() => {
    loadPuzzle(puzzleId);
  }, [loadPuzzle, puzzleId]);


  const submitAttemptResult = useCallback(async (solved: boolean): Promise<PuzzleDto | null> => {
    if (!puzzle || attemptSubmittedRef.current) return null;
    attemptSubmittedRef.current = true;
    // Skip saving for guests
    if (!user) return null;
    const timeMs = Date.now() - startTimeRef.current;
    const userMoves = userMovesRef.current.join(' ');
    try {
      const response = await puzzleApi.submitAttempt(puzzle.id, { result: solved ? 'solved' : 'failed', timeMs, userMoves });
      if (response.userRatingBefore != null && response.userRatingAfter != null) {
        setRatingChange({ before: response.userRatingBefore, after: response.userRatingAfter });
      }
      return response.nextPuzzle;
    } catch {
      return null;
    }
  }, [puzzle, user]);

  /**
   * KS-2969: определяет, является ли ход превращением пешки на текущей
   * позиции `game`. Используется для перехвата promotion-ходов до их
   * передачи в `processPlayerMove` — игрок должен сам выбрать фигуру.
   */
  const isPromotionMove = useCallback(
    (sourceSquare: string, targetSquare: string): boolean => {
      if (!game) return false;
      const piece = game.get(sourceSquare as Square);
      if (!piece || piece.type !== 'p') return false;
      const targetRank = targetSquare[1];
      return (
        (piece.color === 'w' && targetRank === '8') ||
        (piece.color === 'b' && targetRank === '1')
      );
    },
    [game],
  );

  /**
   * KS-2969: основная логика обработки хода игрока. До рефакторинга это
   * было inline-телом `onPieceDrop`. Вынесли в отдельный коллбэк, чтобы
   * можно было вызвать его после выбора фигуры в `PromotionPicker`.
   *
   * `userPromotion` — выбор фигуры юзером при promotion-ходе. Для
   * не-promotion-ходов параметр игнорируется.
   */
  const processPlayerMove = useCallback(
    (sourceSquare: string, targetSquare: string, userPromotion?: PromotionPiece): boolean => {
      if (!game || !puzzle || status !== 'thinking') return false;
      if (moveIndex >= puzzleMoves.length) return false;

      const expectedMove = puzzleMoves[moveIndex];
      console.log(`[Puzzle] processPlayerMove: moveIndex=${moveIndex} expected=${expectedMove} player=${sourceSquare}${targetSquare}${userPromotion ?? ''} total=${puzzleMoves.length}`);
      const from = expectedMove.slice(0, 2);
      const to = expectedMove.slice(2, 4);
      const promotion = expectedMove.length > 4 ? expectedMove[4] : undefined;

      // For generated puzzles with multiple accepted moves (first move only)
      // KS-2969: playerUci собирается с выбранной promotion-фигурой, чтобы
      // сравнение с expectedMove (b7b8q) работало корректно.
      const playerUci = sourceSquare + targetSquare + (userPromotion ?? '');
      userMovesRef.current.push(playerUci);
      const acceptedList = isGenerated && moveIndex === 0 && (puzzle as unknown as { acceptedMoves?: string }).acceptedMoves
        ? (puzzle as unknown as { acceptedMoves: string }).acceptedMoves.split(' ')
        : null;
      const isAccepted = acceptedList ? acceptedList.some((m) => m.startsWith(playerUci)) : false;

      // KS-2969: сравниваем по полному UCI (с promotion-суффиксом). До
       // фикса сравнивались только from/to, и promotion-ход с фигурой
       // отличной от expected ушёл бы в ветку «правильно», заменяясь
       // на ход из solution.
       if (!isAccepted && playerUci !== expectedMove) {
        // Try alternative move via engine analysis
        const currentFen = game.fen();
        const testCopy = new Chess(currentFen);
        const testMove = testCopy.move({
          from: sourceSquare,
          to: targetSquare,
          // KS-2969: передаём выбранную игроком фигуру (если ход — promotion).
          promotion: userPromotion,
        });
        if (!testMove) {
          // Illegal move
          return false;
        }

        // Show move on board, mark as checking
        setGame(testCopy);
        setStatus('checking');
        playSound(soundEventFromSan(testMove.san));

        // Async engine check
        (async () => {
          const ALT_THRESHOLD = 50; // centipawns tolerance
          try {
            const engine = await getEngine();
            const result = await engine.analyze(currentFen, 16, 5);
            const lines = result.lines.sort((a, b) => {
              const acp = a.score.type === 'mate' ? (a.score.value > 0 ? 10000 : -10000) : a.score.value;
              const bcp = b.score.type === 'mate' ? (b.score.value > 0 ? 10000 : -10000) : b.score.value;
              return bcp - acp; // descending for white, need to consider side
            });

            const solutionLine = lines.find((l) => l.pv[0] === expectedMove);
            const playerLine = lines.find((l) => l.pv[0] === playerUci);
            const bestCp = lines.length > 0 ? (lines[0].score.type === 'mate' ? (lines[0].score.value > 0 ? 10000 : -10000) : lines[0].score.value) : 0;
            const playerCp = playerLine ? (playerLine.score.type === 'mate' ? (playerLine.score.value > 0 ? 10000 : -10000) : playerLine.score.value) : -99999;
            const solutionCp = solutionLine ? (solutionLine.score.type === 'mate' ? (solutionLine.score.value > 0 ? 10000 : -10000) : solutionLine.score.value) : bestCp;

            console.log(`[Puzzle] Engine check: player=${playerUci} cp=${playerCp}, solution=${expectedMove} cp=${solutionCp}, diff=${solutionCp - playerCp}`);

            if (playerLine && Math.abs(solutionCp - playerCp) <= ALT_THRESHOLD) {
              // Good alternative — show message, revert to solution line, apply solution move + opponent
              setAltMoveMsg(t('puzzle.altMoveAccepted', 'Good move! But let\'s follow the main line.'));
              setTimeout(() => {
                setAltMoveMsg(null);
                const replay = new Chess(currentFen);
                try {
                  // Apply solution move
                  const solMove = replay.move({ from, to, promotion });
                  if (solMove) playSound(soundEventFromSan(solMove.san));
                  setGame(new Chess(replay.fen()));
                  setMoveIndex(moveIndex + 1);

                  // Auto-play opponent response after short delay
                  const nextIndex = moveIndex + 1;
                  if (nextIndex < puzzleMoves.length) {
                    setTimeout(() => {
                      const opponentUci = puzzleMoves[nextIndex];
                      const oFrom = opponentUci.slice(0, 2);
                      const oTo = opponentUci.slice(2, 4);
                      const oProm = opponentUci.length > 4 ? opponentUci[4] : undefined;
                      const next = new Chess(replay.fen());
                      const oMove = next.move({ from: oFrom, to: oTo, promotion: oProm });
                      if (oMove) playSound(soundEventFromSan(oMove.san));
                      setGame(next);
                      setMoveIndex(nextIndex + 1);
                      setStatus('thinking');

                      if (nextIndex + 1 >= puzzleMoves.length) {
                        setStatus('correct');
                        playSound('puzzle-correct');
                        setStreak((s) => s + 1);
                        setTotalSolved((n) => n + 1);
                        submitAttemptResult(true);
                      }
                    }, 400);
                  } else {
                    // Solution move was last
                    setStatus('correct');
                    playSound('puzzle-correct');
                    setStreak((s) => s + 1);
                    setTotalSolved((n) => n + 1);
                    submitAttemptResult(true);
                  }
                } catch { /* ignore */ }
              }, 1200);
            } else {
              // Move is too weak — incorrect
              setStatus('incorrect');
              playSound('puzzle-incorrect');
              setStreak(0);
              submitAttemptResult(false);
              setTimeout(() => {
                setSolutionMove(expectedMove);
                setTimeout(() => {
                  const revert = new Chess(currentFen);
                  try {
                    revert.move({ from, to, promotion });
                    setGame(revert);
                    setMoveIndex((idx) => idx + 1);
                  } catch { /* ignore */ }
                }, 800);
              }, 600);
            }
          } catch (err) {
            console.error('[Puzzle] Engine error:', err);
            // Fallback: mark incorrect
            setStatus('incorrect');
            playSound('puzzle-incorrect');
            setStreak(0);
            submitAttemptResult(false);
          }
        })();

        return true; // move applied visually
      }

      const copy = new Chess(game.fen());
      const move = copy.move({ from, to, promotion });
      if (!move) {
        setStatus('incorrect');
        playSound('puzzle-incorrect');
        setStreak(0);
        submitAttemptResult(false);
        return false;
      }

      playSound(soundEventFromSan(move.san));
      setGame(copy);
      const nextIndex = moveIndex + 1;
      setMoveIndex(nextIndex);

      // Check if puzzle is complete — all moves in solution line must be played
      const isSolved = nextIndex >= puzzleMoves.length;
      if (isSolved) {
        setStatus('correct');
        playSound('puzzle-correct');
        setStreak((s) => s + 1);
        setTotalSolved((n) => n + 1);
        submitAttemptResult(true);
        return true;
      }

      // Play the opponent's response after a short delay
      setTimeout(() => {
        console.log(`[Puzzle] Auto-play opponent: index=${nextIndex} move=${puzzleMoves[nextIndex]}`);
        const opponentMove = puzzleMoves[nextIndex];
        const oFrom = opponentMove.slice(0, 2);
        const oTo = opponentMove.slice(2, 4);
        const oPromotion = opponentMove.length > 4 ? opponentMove[4] : undefined;
        const next = new Chess(copy.fen());
        const oMove = next.move({ from: oFrom, to: oTo, promotion: oPromotion });
        if (oMove) playSound(soundEventFromSan(oMove.san));
        setGame(next);
        const afterOpponentIndex = nextIndex + 1;
        setMoveIndex(afterOpponentIndex);

        // If opponent's move was the last move — puzzle is solved
        if (afterOpponentIndex >= puzzleMoves.length) {
          setStatus('correct');
          playSound('puzzle-correct');
          setStreak((s) => s + 1);
          setTotalSolved((n) => n + 1);
          submitAttemptResult(true);
        }
      }, 300);

      return true;
    },
    [game, puzzle, status, moveIndex, puzzleMoves, playSound, submitAttemptResult, getEngine, isGenerated, t],
  );

  /**
   * KS-2969: обёртка над `processPlayerMove` для перехвата promotion-ходов
   * до их применения. Если ход — promotion, открываем `PromotionPicker`
   * и ждём выбор; иначе сразу передаём в обработчик.
   */
  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (!game || status !== 'thinking') return false;
      if (isPromotionMove(sourceSquare, targetSquare)) {
        // Проверим легальность хода ферзём — иначе модалку не открываем.
        const testGame = new Chess(game.fen());
        let testMove: ReturnType<Chess['move']> | null = null;
        try {
          testMove = testGame.move({
            from: sourceSquare,
            to: targetSquare,
            promotion: 'q',
          });
        } catch {
          testMove = null;
        }
        if (!testMove) return false;
        setPendingPromotion({
          from: sourceSquare as Square,
          to: targetSquare as Square,
        });
        return true;
      }
      return processPlayerMove(sourceSquare, targetSquare);
    },
    [game, status, isPromotionMove, processPlayerMove],
  );

  const handlePromotionChoice = useCallback(
    (piece: PromotionPiece) => {
      if (!pendingPromotion) return;
      const { from, to } = pendingPromotion;
      setPendingPromotion(null);
      processPlayerMove(from, to, piece);
    },
    [pendingPromotion, processPlayerMove],
  );

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  const lastMoveUci = solutionMove ?? (moveIndex > 0 && puzzleMoves[moveIndex - 1] ? puzzleMoves[moveIndex - 1] : null);

  const handleNext = useCallback(async () => {
    if (puzzle) markSolved(puzzle.id);
    const nextPuzzle = await submitAttemptResult(status === 'correct');
    if (nextPuzzle) {
      initPuzzle(nextPuzzle);
    } else {
      await loadPuzzle();
    }
  }, [submitAttemptResult, status, initPuzzle, loadPuzzle, puzzle, markSolved]);

  // No auto-advance — user clicks Next manually after any result.

  const handleRetry = () => {
    if (!puzzle) return;
    const moves = Array.isArray(puzzle.moves) ? puzzle.moves : puzzle.moves.split(' ');
    setPuzzleMoves(moves);
    const chess = new Chess(puzzle.fen);
    const gen = (puzzle as unknown as { source?: string })?.source === 'generated';
    if (gen) {
      // Generated: no setup move, player finds moves[0]
      setGame(chess);
      setMoveIndex(0);
    } else if (moves.length > 1) {
      // Lichess: apply setup move, player finds moves[1]
      const uci = moves[0];
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
      setGame(chess);
      setMoveIndex(1);
    } else {
      setGame(chess);
      setMoveIndex(0);
    }
    setStatus('thinking');
    setSolutionMove(null);
    setAltMoveMsg(null);
    // KS-2969: закрыть модалку выбора promotion при retry.
    setPendingPromotion(null);
    userMovesRef.current = [];
    attemptSubmittedRef.current = false;
    startTimeRef.current = Date.now();
  };

  // KS-3349 (ADR-079 §3.5). Снимаем precision-рейтинг ДО попытки —
  // нужно для дельты «X → Y (+N)» после submit. Только для
  // авторизованных и только на /precision-флоу. Тихо игнорируем
  // ошибки fetch'а (блок дельты просто не покажется).
  useEffect(() => {
    if (!fromPrecision || !user) {
      setPrecisionRatingBefore(null);
      return;
    }
    let cancelled = false;
    precisionApi
      .getMyRating()
      .then((r) => {
        if (!cancelled) setPrecisionRatingBefore(Math.round(r.rating));
      })
      .catch(() => {
        if (!cancelled) setPrecisionRatingBefore(null);
      });
    return () => {
      cancelled = true;
    };
    // Перечитываем при смене puzzleId (после «Следующая» — нужен новый baseline).
  }, [fromPrecision, user, puzzleId]);

  // KS-2466 / ADR-044 §5: для пазлов в режиме `play-vs-engine` рендерим
  // отдельный компонент (там своя state-machine + WASM-движок), а
  // forced-line ветка ниже не трогается. Гости — просто без submitAttempt
  // (как в forced-line submitAttemptResult ниже).
  const handlePlayVsEngineSubmit = useCallback(
    async (data: PlayVsEngineSubmit) => {
      if (!puzzle) return;
      if (!user) return;
      try {
        // KS-2719 F1: пробрасываем полный лог user-ходов (UserBestSnapshot[])
        // на backend для server-trust accuracy. Маппинг halfMove → ply
        // (backend ожидает 1-based ply). До выкатки KS-2717 поле просто
        // игнорируется сервером.
        await puzzleApi.submitAttempt(puzzle.id, {
          result: data.solved ? 'solved' : 'failed',
          timeMs: data.timeMs,
          halfMovesPlayed: data.halfMovesPlayed,
          finalWdl: data.finalWdl,
          reason: data.reason,
          moves: data.moves.map((s) => ({
            ply: s.halfMove,
            fenBefore: s.fenBefore,
            playedUci: s.playedUci,
            bestUci: s.bestUci,
            cpBefore: s.cpBefore,
            cpAfter: s.cpAfter,
            wdlBefore: s.wdlBefore,
            wdlAfter: s.wdlAfter,
            depth: s.depth,
            // KS-2754: UCI ответа движка (null для последнего полухода).
            engineUci: s.engineUci,
          })),
        });
        // KS-3349 (ADR-079 §3.5). После submit backend обновил
        // UserPrecisionRating в той же транзакции. Перечитываем — даёт
        // ratingAfter; ratingBefore берём из снимка mount-страницы пазла.
        // Если backend skipped (self-created / hidden / guest), rating
        // не изменится, дельта = 0, всё равно показываем как есть.
        if (fromPrecision) {
          try {
            const after = await precisionApi.getMyRating();
            const afterRounded = Math.round(after.rating);
            if (precisionRatingBefore != null) {
              setPrecisionRatingChange({
                ratingBefore: precisionRatingBefore,
                ratingAfter: afterRounded,
                ratingDelta: afterRounded - precisionRatingBefore,
              });
            }
          } catch {
            /* graceful — пропускаем блок дельты при ошибке fetch'а. */
          }
        }
      } catch {
        /* MVP: молча игнорируем сетевые ошибки submit'а. */
      }
    },
    [puzzle, user, fromPrecision, precisionRatingBefore],
  );

  // KS-3349 (ADR-079 §3.4). «Назад» — навигация на исходный список
  // `/precision?…` с сохранёнными фильтрами (buildBackUrl сам соберёт).
  const handleBack = useCallback(() => {
    navigate(backUrl);
  }, [navigate, backUrl]);

  // KS-3349 (ADR-079 §3.4). «Следующая» — `GET /precision/next` с теми
  // же параметрами, что были при заходе на текущий пазл. На 404
  // (`no_puzzles_available`) — fallback на /precision (пусть user сам
  // увидит сообщение «нет пазлов»).
  const handlePickNext = useCallback(async () => {
    if (!user || !fromPrecision) return;
    try {
      const params = buildPrecisionNextParams(searchParams, true);
      const res = await precisionApi.pickNext(params);
      if (res.puzzleId) {
        // Сохраняем те же query-params на новой странице пазла —
        // buildPrecisionPuzzleQuery работает с любыми URLSearchParams,
        // но здесь у нас уже preserved-набор. Просто перенесём текущие.
        const sp = new URLSearchParams(searchParams);
        sp.set('source', 'precision');
        navigate(`/puzzle/${res.puzzleId}?${sp.toString()}`);
        // Сброс delta — новый пазл, новый baseline (snapshot useEffect
        // перечитает rating).
        setPrecisionRatingChange(null);
      } else {
        // no_puzzles_available → возвращаем на /precision.
        navigate(backUrl);
      }
    } catch {
      // Сеть упала → fallback на /precision.
      navigate(backUrl);
    }
  }, [user, fromPrecision, searchParams, navigate, backUrl]);

  // KS-2688: единый header c хлебными крошками, back-link'ом и заголовком.
  // До тикета все три состояния ниже (allSolved / play-vs-engine /
  // обычный fallback) рендерили один и тот же header inline; KS-2688
  // переезжает на динамический section + dynamic backUrl, поэтому
  // выносим в один renderable блок, чтобы не дублировать логику и
  // случайно не разъехаться по тексту/ссылкам.
  const puzzleShortId = puzzle ? puzzle.id.slice(0, 8) : '';
  const renderHeader = (helpSection: 'puzzles') => (
    <>
      <nav
        className="puzzle-breadcrumbs"
        data-testid="puzzle-breadcrumbs"
        aria-label={t('breadcrumbs.label', 'Breadcrumbs')}
      >
        <Link to="/" className="puzzle-breadcrumbs__link">
          {t('breadcrumbs.home', 'Home')}
        </Link>
        <span className="puzzle-breadcrumbs__sep" aria-hidden="true">
          /
        </span>
        <Link
          to={backUrl}
          className="puzzle-breadcrumbs__link"
          data-testid="puzzle-breadcrumbs-section"
        >
          {sectionTitle}
        </Link>
        {puzzleShortId && (
          <>
            <span className="puzzle-breadcrumbs__sep" aria-hidden="true">
              /
            </span>
            <span
              className="puzzle-breadcrumbs__current"
              data-testid="puzzle-breadcrumbs-current"
            >
              {t('breadcrumbs.puzzleN', 'Puzzle #{{id}}', { id: puzzleShortId })}
            </span>
          </>
        )}
      </nav>
      <Link
        to={backUrl}
        className="back-nav-link"
        data-testid="puzzle-back-link"
      >
        &larr; {sectionBackLabel}
      </Link>
      <h1>
        {sectionTitle}
        <HelpButton section={helpSection} />
      </h1>
    </>
  );

  if (loading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  if (allSolved) {
    return (
      <div className="puzzle-page">
        {renderHeader('puzzles')}
        <div className="puzzle-all-solved">
          <p>{t('puzzle.allSolved', 'All puzzles solved! Generate new ones from PGN.')}</p>
          <Link to={backUrl} className="play-btn" data-testid="puzzle-back-cta">
            {sectionBackButtonLabel}
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="puzzle-page">
        <div className="error">{error}</div>
        <button onClick={() => loadPuzzle()} style={{ marginTop: 16 }}>{t('puzzle.retry')}</button>
      </div>
    );
  }

  // KS-2466: ветка play-vs-engine. Compose: общий header (back-link, title)
  // + специальный runner вместо forced-line UI.
  // KS-2657: дополнительный триггер — `?source=precision` (ссылка из
  // PrecisionPage). Защитная мера на случай data-mismatch'а в БД,
  // когда backend для generated-пазла возвращает `solutionMode:
  // 'forced-line'` вместо ожидаемого 'play-vs-engine'.
  if (
    puzzle &&
    (puzzle.solutionMode === 'play-vs-engine' || fromPrecision)
  ) {
    return (
      <div className="puzzle-page" data-testid="puzzle-page-play-vs-engine">
        {renderHeader('puzzles')}
        {!user && (
          <div className="guest-banner">
            <Link to="/login">{t('auth.loginToSaveProgress', 'Sign in to save your progress')}</Link>
          </div>
        )}
        <PlayVsEngineRunner
          key={puzzle.id}
          puzzle={puzzle}
          onSubmit={handlePlayVsEngineSubmit}
          // KS-3349 (ADR-079 §3.4). На /precision-флоу «Следующая» идёт
          // через `/precision/next` (рейтинг-окно Glicko-1). Снаружи
          // precision-флоу — старое поведение `loadPuzzle()` без id.
          onNext={fromPrecision ? handlePickNext : () => { void loadPuzzle(); }}
          // KS-3349: «Назад» виден только на /precision-флоу. На общем
          // `/puzzles` юзер возвращается через breadcrumbs/back-link.
          onBack={fromPrecision ? handleBack : undefined}
          // KS-3349 (ADR-079 §3.5). Дельта precision-рейтинга — `null`
          // для гостей и до завершения попытки.
          precisionRatingChange={precisionRatingChange}
        />
        {/* KS-2488: блок «Из партии» — headers + ссылки на архив /
            Lichess. Сам компонент возвращает null если sourceGame
            отсутствует или пустой. */}
        <PuzzleSourceGame source={puzzle.sourceGame} />
      </div>
    );
  }

  return (
    <div className="puzzle-page">
      {renderHeader('puzzles')}

      {!user && (
        <div className="guest-banner">
          <Link to="/login">{t('auth.loginToSaveProgress', 'Sign in to save your progress')}</Link>
        </div>
      )}

      <div className="puzzle-stats">
        <span>{t('puzzle.streak', { count: streak })}</span>
        <span>{t('puzzle.totalSolved', { count: totalSolved })}</span>
        {puzzle && <span>{t('puzzle.puzzleRating', { rating: puzzle.rating })}</span>}
        {isGenerated && puzzle && (puzzle as unknown as { acceptedMoves?: string }).acceptedMoves && (
          <span className="puzzle-multi-hint">
            {t('puzzle.findOneOfN', 'Find 1 of {{n}}', { n: ((puzzle as unknown as { acceptedMoves: string }).acceptedMoves.split(' ').length) })}
          </span>
        )}
        {isGenerated && puzzle && (() => {
          const p = puzzle as unknown as { sourceId?: string; sourceMetadata?: { white?: string; black?: string; event?: string; date?: string }; sourceMoveNum?: number };
          if (p.sourceId) {
            return (
              <Link to={`/game/${p.sourceId}/review`} className="puzzle-source-link">
                {t('puzzle.fromGame', 'From game')} →
              </Link>
            );
          }
          if (p.sourceMetadata) {
            const m = p.sourceMetadata;
            const label = m.white && m.black ? `${m.white} vs ${m.black}` : m.event || '';
            return label ? (
              <span className="puzzle-source-info">
                {label}
                {p.sourceMoveNum ? `, move ${p.sourceMoveNum}` : ''}
              </span>
            ) : null;
          }
          return null;
        })()}
      </div>

      <div className="puzzle-board-area">
        <div className="puzzle-info-slot">
          {status === 'thinking' ? (
            <p className="puzzle-hint">{t('puzzle.findBestMove')}</p>
          ) : (status === 'correct' || status === 'incorrect') && isGenerated && puzzle ? (() => {
          const m = (puzzle as unknown as { sourceMetadata?: { bestScore?: number; bestMove?: string; secondBestScore?: number; secondBestMove?: string } }).sourceMetadata;
          if (!m || m.bestScore == null) return null;
          const formatCp = (cp: number) => {
            if (Math.abs(cp) >= 10000) return cp > 0 ? 'M' : '-M';
            return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(1);
          };
          // Convert UCI to SAN using puzzle position
          const uciToSan = (uci: string | undefined): string => {
            if (!uci || uci.length < 4) return uci || '?';
            try {
              const c = new Chess(puzzle.fen);
              const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
              return mv?.san || uci;
            } catch { return uci; }
          };
          return (
            <div className="puzzle-eval-info">
              <span className="puzzle-eval-best">{uciToSan(m.bestMove)} ({formatCp(m.bestScore)})</span>
              {m.secondBestScore != null && (
                <span className="puzzle-eval-second">{uciToSan(m.secondBestMove)} ({formatCp(m.secondBestScore)})</span>
              )}
              <span className="puzzle-eval-gap">{t('puzzle.gap', 'Gap')}: {(puzzle as unknown as { gap?: number }).gap ?? Math.abs((m.bestScore ?? 0) - (m.secondBestScore ?? 0))}cp</span>
            </div>
          );
        })() : <span>&nbsp;</span>}
        {ratingChange && (
          <span className={`puzzle-rating-change ${ratingChange.after >= ratingChange.before ? 'positive' : 'negative'}`}>
            {ratingChange.after >= ratingChange.before ? '+' : ''}{ratingChange.after - ratingChange.before} ({ratingChange.after})
          </span>
        )}
        </div>

        <PuzzleBoard
          game={game}
          boardOrientation={boardOrientation}
          enabled={status === 'thinking'}
          onPieceDrop={onPieceDrop}
          lastMoveUci={lastMoveUci}
          status={status}
        >
          {/* KS-2969: модалка выбора фигуры при превращении пешки. */}
          <PromotionPicker
            pending={pendingPromotion}
            color={pendingPromotion?.to[1] === '8' ? 'w' : 'b'}
            onChoice={handlePromotionChoice}
            onCancel={handlePromotionCancel}
            testId="puzzle-promotion-overlay"
          />
        </PuzzleBoard>

        <div className="puzzle-actions-slot">
          {status === 'checking' && (
            <div className="puzzle-checking-msg">{t('puzzle.checkingAlt', 'Checking alternative move...')}</div>
          )}
          {altMoveMsg && <div className="puzzle-alt-move-msg">{altMoveMsg}</div>}
          {status === 'incorrect' && (
            <button onClick={handleRetry}>{t('puzzle.retry')}</button>
          )}
          <button
            className="puzzle-analyze-btn"
            style={{ visibility: status === 'thinking' ? 'hidden' : 'visible' }}
            onClick={() => {
              if (!puzzle) return;
              // KS-2606 (ADR-051 §4 B4): собираем PGN текущей позиции пазла
              // (FEN-header) + ходов решения и идём в анализ через
              // helper openAnalysis. Helper делает POST /analyses {pgn} →
              // navigate('/analysis/<id>'); puzzleFen/puzzlePgn через
              // router state больше НЕ передаём — id в URL уникальный,
              // AnalysisPage подгружает запись по id (см. KS-2403).
              const fullPgn = buildPuzzleAnalysisPgn(puzzle.fen, puzzle.moves);
              void openAnalysis(navigate, {
                pgn: fullPgn,
                title: `Puzzle #${puzzle.id.slice(0, 6)}`,
                t,
              });
            }}
          >
            {t('puzzle.analyze', 'Analyze')}
          </button>
          <button
            className="play-btn"
            onClick={handleNext}
            style={{ visibility: status === 'thinking' ? 'hidden' : 'visible' }}
          >
            {t('puzzle.next')}
          </button>
        </div>
      </div>

      {/* KS-2488: блок «Из партии» (sourceGame) — headers + ссылки
          архив/Lichess. Возвращает null если sourceGame пустой. */}
      <PuzzleSourceGame source={puzzle?.sourceGame} />

      {/* KS-1928 / ADR-032 §5: compact hint «Слабые темы» под доской.
          Self-fetching: скрыт при пустом списке / без auth / ошибке.
          Чипы ведут в /puzzles/mistakes-practice?theme=<...>. */}
      <MistakesDiaryHint />
    </div>
  );
}
