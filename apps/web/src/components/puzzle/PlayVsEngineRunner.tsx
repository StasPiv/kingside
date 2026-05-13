import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  PuzzleDto,
  PlayVsEnginePuzzleReason,
} from '@kingside/shared';
import { PuzzleBoard } from '../PuzzleBoard';
import { EvalBar } from '../EvalBar';
import { PostGameReview } from './PostGameReview';
import { useSounds, soundEventFromSan } from '../../hooks/useSounds';
import { permilleToPercent } from '../../utils/chessFormat';
import {
  WasmEngineAdapter,
  type EngineAdapter,
  type AnalysisResult,
  type WdlDistribution,
} from '../../utils/engineAdapter';
import type { EvalLine } from '../../hooks/useStockfish';
import { shouldFinishLose } from './precisionVerdict';

/**
 * KS-2466 / ADR-044 §5. Раннер пазла-«удержания преимущества» против
 * локального WASM Stockfish. Реализован как отдельный компонент, чтобы
 * не пересекаться с forced-line веткой `PuzzlePage` (см. KS-2466 §1).
 *
 * Жизненный цикл (ADR §5.2):
 *   thinking  → пользователь делает ход
 *   evaluating→ analyze: посчитать WDL_user, проверить mate / engine-resign
 *   engine    → применить bestmove, halfMovesPlayed++; break при N полуходов
 *   win/lose  → submit attempt, показать итог
 *   error     → сетевая/движковая ошибка
 *
 * Anti-cheat MVP не делаем — вся логика на клиенте (см. ADR §5.4 / задача
 * §5).
 */

export type PlayVsEngineSubmit = {
  solved: boolean;
  halfMovesPlayed: number;
  finalWdl: number;
  reason: PlayVsEnginePuzzleReason;
  timeMs: number;
  /**
   * KS-2719 / ADR-056 §4 F1. Полный лог snapshot'ов user-ходов
   * (`UserBestSnapshot[]`), накопленный во время попытки. Отправляется
   * на backend как `moves` в `submitAttempt` payload — там пересчитают
   * accuracy/classification по server-trust (ADR-055).
   *
   * На каждый user-ход содержит: ply, fenBefore, playedUci, bestUci,
   * cpBefore, cpAfter, wdlBefore, wdlAfter, depth (см. UserBestSnapshot).
   */
  moves: UserBestSnapshot[];
};

export interface PlayVsEngineRunnerProps {
  puzzle: PuzzleDto;
  /**
   * Вызывается один раз при достижении win/lose. Родитель сам решает,
   * слать ли `puzzleApi.submitAttempt` (для гостей — нет).
   */
  onSubmit?: (data: PlayVsEngineSubmit) => void | Promise<void>;
  /** Кнопка «Следующий пазл» — навигация решается родителем. */
  onNext?: () => void;
  /**
   * DI для тестов — позволяет подменить движок на mock без WASM.
   * Production — `() => new WasmEngineAdapter()`.
   */
  engineFactory?: () => EngineAdapter;
  /**
   * Глубина для анализа. По умолчанию 18 — на меньших глубинах SF18 WASM
   * в насыщенных позициях даёт ложные WDL и срабатывает ложный
   * «Преимущество потеряно» (KS-2955). Пара с `analyzeMovetimeMs`
   * гарантирует разумный нижний порог: SF останавливается по первой
   * достигнутой границе.
   */
  analyzeDepth?: number;
  /**
   * KS-2955: нижний порог времени анализа в мс. По умолчанию 1000 — на
   * проблемных позициях типа `3r4/pppk1pQP/8/...` это даёт SF18 WASM
   * добраться до depth 18+, где `bestmove`/`wdl` стабильно корректны.
   * 0/undefined — без movetime, только depth (как было до KS-2955).
   */
  analyzeMovetimeMs?: number;
}

type RunnerState = 'thinking' | 'evaluating' | 'engine' | 'win' | 'lose' | 'error';

/**
 * KS-2473: лучший ход юзера на полуходе. PV1 от движка В ПОЗИЦИИ ДО
 * user-хода (т.е. там, где ходит юзер). KS-2509: единственный лог,
 * нужный для post-mortem (PostGameReview); старый `BestmoveSnapshot`
 * (engine-ответы) упразднён вместе с inline-bestmoveHint.
 */
export type UserBestSnapshot = {
  halfMove: number;
  /** FEN, в котором ходил юзер (до его хода). */
  fenBefore: string;
  /** UCI, который юзер сыграл. */
  playedUci: string;
  /** UCI, который рекомендовал движок в той же позиции. */
  bestUci: string;
  /**
   * KS-2505 / ADR-047 §3 #2. cp-оценка позиции `fenBefore` POV юзера
   * (на этом FEN ходит юзер → score из движка уже POV side-to-move).
   * Mate-оценки кодируются ±100000 (см. `cpFromScore`). null —
   * pre-analyze не успел/упал, классификатор downstream должен
   * грейсфолить (KS-2506+).
   */
  cpBefore: number | null;
  /**
   * KS-2506 / ADR-047 §3 #3. cp-оценка позиции ПОСЛЕ хода юзера POV
   * юзера. На post-analyze FEN ходит соперник → score движка POV
   * соперника, поэтому ИНВЕРТИРУЕМ знак: `cpAfter_user = -cpAfter_opp`.
   * Записывается в `runEngineCycle` после первого analyze. null —
   * post-analyze упал / завершился до записи (race с pre-analyze
   * исключён: post-analyze всегда позже создания snapshot'а в
   * pre-analyze, и оба идут через тот же queueAnalyze).
   */
  cpAfter: number | null;
  /**
   * KS-2686. WDL POV user в позиции ДО хода юзера (на `fenBefore`).
   * Pre-analyze идёт на FEN'е, где ходит сам юзер → WDL уже POV user
   * без инверсии. Используется в PostGameReview для отображения
   * «WDL после лучшего хода» (best UCI ведёт к этому распределению,
   * т.к. это PV1 от движка).
   */
  wdlBefore: WdlDistribution | null;
  /**
   * KS-2686. WDL POV user в позиции ПОСЛЕ фактически сыгранного хода.
   * Post-analyze на FEN'е, где ходит соперник → wdl POV соперника,
   * инвертируется через `flipWdl`. Показывается в PostGameReview как
   * «WDL после хода студента».
   */
  wdlAfter: WdlDistribution | null;
  /**
   * KS-2686. Глубина анализа Stockfish — берётся из info-строки PV1
   * pre-analyze (depth post-analyze совпадает в пределах ±1, т.к.
   * `analyzeDepth` фиксирован). Показывается рядом с вариантом в
   * PostGameReview как «оба значения сняты на depth=N».
   */
  depth: number | null;
  /**
   * KS-2754. UCI хода, которым движок ответил на этот user-ход.
   * Заполняется в `runEngineCycle` после применения engine bestmove.
   * `null` — движок не ответил (последний полуход партии: мат/abort/
   * достигнут halfMovesN). Используется в `PrecisionAttemptReview` для
   * полной аннотации партии без реконструкции через chess.js diff.
   */
  engineUci: string | null;
};

/**
 * Сигмоидное преобразование cp → WDL_signed в диапазоне [-1..+1] (ADR §5.2).
 * k=400 — стандарт Lichess; mate → ±1.
 */
function scoreToWdlSigned(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') return score.value > 0 ? 1 : -1;
  const k = 400;
  return 2 / (1 + Math.exp(-score.value / k)) - 1;
}

/**
 * KS-2505 / ADR-047 §3 #2. Нормализуем `score` к одному cp-числу для
 * downstream-классификатора (`classifyMove`, KS-2504). Mate кодируется
 * `±MATE_CP_ENCODING` — гигантский cp-loss попадает в blunder, что и
 * нужно для хода, в котором юзер потерял мат.
 *
 * NB: знак не инвертируется — вызывающий обязан передавать `score` в
 * системе отсчёта, в которой он хочет получить cp (POV side-to-move
 * на анализируемом FEN).
 */
const MATE_CP_ENCODING = 100000;
export function cpFromScore(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') {
    return score.value > 0 ? MATE_CP_ENCODING : -MATE_CP_ENCODING;
  }
  return score.value;
}

/**
 * KS-2527: инвертировать POV WDL — w↔l, d остаётся. Нужно когда analyze
 * был сделан на FEN'е соперника (post-analyze), а в state хранится POV
 * user. Pure-функция, без side-эффектов.
 */
export function flipWdl(wdl: WdlDistribution): WdlDistribution {
  return { w: wdl.l, d: wdl.d, l: wdl.w };
}

/**
 * KS-2533: «настоящий» signed WDL из объекта `{w,d,l}` (per-mille):
 *   `(w − l) / 1000` ∈ [-1..+1].
 * Когда от движка приходит реальный WDL-распределение — мы должны
 * принимать win/lose решения по нему, а не по сигмоиде cp (которая
 * для cp=+50 даёт +0.124, ниже winThreshold=0.5, даже если W=1000‰).
 *
 * Возвращает POV того же side, что и переданный wdl-объект; вызывающий
 * обязан передать POV user (через `flipWdl` если нужно).
 */
export function signedWdlFromObj(wdl: WdlDistribution): number {
  return (wdl.w - wdl.l) / 1000;
}

/**
 * KS-2533: эффективный signed WDL POV user для win/lose-решений.
 * Если есть `wdlObj` (реальный WDL из движка POV user) — используем
 * его; иначе fallback на сигмоиду cp (`sigmoidWdl`, тоже POV user).
 */
export function effectiveSignedWdl(
  wdlObj: WdlDistribution | null,
  sigmoidWdl: number,
): number {
  return wdlObj ? signedWdlFromObj(wdlObj) : sigmoidWdl;
}

function sideFromFen(fen: string): 'w' | 'b' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'b' : 'w';
}

function pickBestLine(result: AnalysisResult) {
  if (!result.lines.length) return null;
  const sorted = [...result.lines].sort((a, b) => a.multipv - b.multipv);
  return sorted[0];
}

/** Вытащить `EvalLine[]` для `<EvalBar />` из `AnalysisResult`. */
function toEvalLines(result: AnalysisResult): EvalLine[] {
  return result.lines.map((l) => ({
    depth: l.depth,
    multipv: l.multipv,
    score: l.score,
    pv: l.pv.join(' '),
  }));
}

/**
 * KS-2471: UCI→SAN относительно заданного FEN. Если ход не легален или
 * FEN кривой — возвращает исходный UCI как fallback (не падает).
 */
export function uciToSan(uci: string, fen: string): string {
  if (!uci || uci.length < 4) return uci;
  try {
    const c = new Chess(fen);
    const move = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}

/**
 * KS-2471: SAN зевка соперника. `puzzle.fen` — это позиция ПОСЛЕ зевка
 * (там ходит решатель), поэтому напрямую `chess.move(blunderUci)` не
 * легален. Восстанавливаем before-blunder FEN: переносим фигуру с `to`
 * обратно на `from` и переключаем side-to-move. На capture-зевках
 * взятая фигура восстановиться не может — для SAN это не критично
 * (получим Rf4 вместо Rxf4). При любых ошибках — fallback на UCI.
 */
export function blunderUciToSan(blunderUci: string, postBlunderFen: string): string {
  if (!blunderUci || blunderUci.length < 4) return blunderUci;
  try {
    const c = new Chess(postBlunderFen);
    const from = blunderUci.slice(0, 2) as Parameters<typeof c.get>[0];
    const to = blunderUci.slice(2, 4) as Parameters<typeof c.get>[0];
    const piece = c.get(to);
    if (!piece) return blunderUci;
    // Снимаем фигуру с `to`, ставим на `from`.
    c.remove(to);
    c.put(piece, from);
    // Переключаем side-to-move через переписывание FEN (chess.js не даёт
    // прямого setter'а; парсим и собираем обратно).
    const parts = c.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    const beforeFen = parts.join(' ');
    const before = new Chess(beforeFen);
    const move = before.move({
      from: blunderUci.slice(0, 2),
      to: blunderUci.slice(2, 4),
      promotion: blunderUci.length > 4 ? blunderUci[4] : undefined,
    });
    return move?.san ?? blunderUci;
  } catch {
    return blunderUci;
  }
}

export function PlayVsEngineRunner({
  puzzle,
  onSubmit,
  onNext,
  engineFactory,
  // KS-2955: depth=18 + movetime=1000 — гарантия корректной оценки
  // в насыщенных позициях. На depth=12 SF18 WASM в FEN
  // 3r4/pppk1pQP/8/... выбирал c5c6 вместо g7f7 и оценивал результат
  // как «чёрные выигрывают», давая ложный «Преимущество потеряно».
  analyzeDepth = 18,
  analyzeMovetimeMs = 1000,
}: PlayVsEngineRunnerProps) {
  const { t } = useTranslation();
  const { playSound } = useSounds();

  // playVsEngine-параметры с дефолтами по ADR §5.5.
  const params = useMemo(() => {
    const pv = puzzle.playVsEngine;
    return {
      blunderMove: pv?.blunderMove ?? '',
      wdlAfterBlunder: pv?.wdlAfterBlunder ?? 0,
      winThreshold: pv?.winThreshold ?? 0.5,
      failThreshold: pv?.failThreshold ?? 0.0,
      halfMovesN: pv?.halfMovesN ?? 6,
    };
  }, [puzzle]);

  // Сторона решателя — ходит первым после blunder.
  const userSide = useMemo<'w' | 'b'>(() => sideFromFen(puzzle.fen), [puzzle.fen]);
  const orientation = userSide === 'w' ? 'white' : 'black';

  const [game, setGame] = useState<Chess>(() => new Chess(puzzle.fen));
  // KS-2486 reopen: список SAN-нотаций всех применённых ходов (user +
  // engine), накапливаем отдельно — `game` пересоздаётся через
  // `new Chess(game.fen())` на каждом ходу и теряет history, поэтому
  // `game.pgn()` для Workshop-ссылки даёт только последнюю позицию.
  // Сохранение SAN'ов отдельно даёт «настоящую» партию: `?pgn=` в
  // ссылке — это `playedSans.join(' ')`.
  const [playedSans, setPlayedSans] = useState<string[]>([]);
  const [state, setState] = useState<RunnerState>('thinking');
  const [halfMovesPlayed, setHalfMovesPlayed] = useState(0);
  const [evalLines, setEvalLines] = useState<EvalLine[]>([]);
  /**
   * KS-2519: side-to-move на FEN, по которому посчитан текущий
   * `evalLines`. Stockfish отдаёт score POV side-to-move; EvalBar
   * (через `evalToPercent` / `formatEval`) умеет инвертировать знак,
   * если `isBlackTurn=true`. Без этого на FEN'ах, где ходят чёрные
   * (post-analyze, или userSide='b'), bar отображал перевёрнутую
   * оценку. Сохраняется синхронно с `setEvalLines` во всех трёх
   * analyze-местах: initial, post-analyze, final.
   */
  const [evalSide, setEvalSide] = useState<'w' | 'b'>(() =>
    sideFromFen(puzzle.fen),
  );
  // KS-2686: state `latestWdlUser` (sigmoid POV user) удалён вместе с
  // sigmoid-fallback в summary. Локальная переменная wdlUser в
  // runEngineCycle остаётся — используется для effectiveSignedWdl
  // win/lose-решения (когда движок не отдаёт wdl).
  const [, setLatestWdlUser] = useState<number>(params.wdlAfterBlunder);
  /**
   * KS-2527 / KS-2521: «настоящий» WDL Stockfish'а (UCI_ShowWDL +
   * KS-2526 парсер). Объект `{w,d,l}` в промилле, POV user. null —
   * info без `wdl ...` (старый Stockfish или Bridge без WDL-патча);
   * downstream-логика делает fallback на сигмоиду cp (`latestWdlUser`).
   *
   * NB: на post-analyze FEN'е ходит соперник, поэтому wdl из движка
   * POV соперника — инвертируем (`w↔l`) перед записью.
   */
  const [latestWdl, setLatestWdl] = useState<WdlDistribution | null>(null);
  const [reason, setReason] = useState<PlayVsEnginePuzzleReason | null>(null);
  /**
   * KS-2473: лог «лучшего хода юзера» в позиции ДО user-move. Заполняется
   * pre-analyze'ом параллельно с engine-ответом, см. `onPieceDrop`.
   */
  const [userBestLog, setUserBestLog] = useState<UserBestSnapshot[]>([]);
  /**
   * KS-2739: race condition фикс. `submitOnce` собирает `moves` для
   * backend payload через захват `userBestLog` в `useCallback`-
   * замыкании. Pre-analyze пишет в state через `setUserBestLog(prev =>
   * [...prev, snap])` — это асинхронный update, react-state не
   * обновляется синхронно. К моменту, когда `runEngineCycle` доходит до
   * `finishWin/finishLose → submitOnce`, цепочка callbacks захватывает
   * `userBestLog` ИЗ TOГO RENDER, в котором был зарегистрирован
   * `onPieceDrop` — то есть пустой `[]`.
   *
   * Раньше у us был только state. После KS-2719 это привело к тому, что
   * `submitAttempt` шёл с `moves: []`, и backend (KS-2717) не создавал
   * `precision_attempts`. KS-2738 девопс заметил precision_attempts=0
   * после 3 PVE-попыток, диагноз — KS-2739.
   *
   * Лечим параллельным `useRef`. Все места, где `setUserBestLog`
   * вызывается, теперь синхронно обновляют и ref. `submitOnce` читает
   * `userBestLogRef.current` — гарантированно актуальное значение.
   * State остаётся для UI (PostGameReview подписан на state).
   */
  const userBestLogRef = useRef<UserBestSnapshot[]>([]);
  /**
   * KS-2739: helper, который синхронно обновляет и ref, и state. Все
   * места, которые раньше звали `setUserBestLog(...)`, теперь зовут
   * `updateUserBestLog(...)` чтобы ref гарантированно был свежим к
   * моменту submit'а. Принимает либо новое значение, либо updater-
   * функцию (как обычный setState).
   */
  const updateUserBestLog = useCallback(
    (
      updater:
        | UserBestSnapshot[]
        | ((prev: UserBestSnapshot[]) => UserBestSnapshot[]),
    ) => {
      // KS-2739: ref пишем СНАРУЖИ setState — иначе writer внутри
      // `setUserBestLog((prev) => ...)` исполняется только в фазе
      // commit React'а, а submitOnce может прочитать ref до этого
      // момента (микротаски post-analyze идут раньше commit'а).
      // Writer-функция должна срабатывать прямо сейчас, синхронно.
      const next =
        typeof updater === 'function'
          ? updater(userBestLogRef.current)
          : updater;
      userBestLogRef.current = next;
      setUserBestLog(next);
    },
    [],
  );
  /**
   * KS-2510 / ADR-047 §3 #7. Когда юзер кликает строку в PostGameReview,
   * на доске показываем `fenBefore` выбранного хода. Доска по-прежнему
   * disabled (state ∈ win|lose), фигуры не двигаются. Сбрасывается на
   * null при смене puzzle (через reset useEffect).
   */
  const [reviewFen, setReviewFen] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const startTimeRef = useRef(Date.now());
  const submittedRef = useRef(false);
  const engineRef = useRef<EngineAdapter | null>(null);
  /**
   * KS-2473: атомарный promise инициализации движка. Гарантирует, что
   * параллельные `ensureEngine()` (pre + post analyze в onPieceDrop)
   * получают ОДИН и тот же worker. Без этого создавались два WASM-
   * экземпляра, второй ломал stdin первого, runner падал в `error`.
   */
  const engineInitPromiseRef = useRef<Promise<EngineAdapter> | null>(null);
  /**
   * KS-2473: единый WASM-worker не выдерживает конкурентных analyze
   * (mid-stream разруха stdin → state=error). Сериализуем все вызовы
   * через promise-цепочку.
   */
  const engineQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastMoveUciRef = useRef<string | null>(null);

  // ── Engine init / cleanup ─────────────────────────────────────────────
  const ensureEngine = useCallback((): Promise<EngineAdapter> => {
    if (engineRef.current) return Promise.resolve(engineRef.current);
    if (engineInitPromiseRef.current) return engineInitPromiseRef.current;
    const promise = (async () => {
      const engine = engineFactory ? engineFactory() : new WasmEngineAdapter();
      await engine.init();
      engineRef.current = engine;
      return engine;
    })();
    engineInitPromiseRef.current = promise;
    return promise;
  }, [engineFactory]);

  /**
   * KS-2473: сериализованный вызов analyze. Ставит запрос в очередь и
   * возвращает Promise<AnalysisResult>. Гарантирует, что в каждый
   * момент только один analyze в работе.
   */
  const queueAnalyze = useCallback(
    (fen: string): Promise<AnalysisResult> => {
      const next = engineQueueRef.current.then(async () => {
        const eng = await ensureEngine();
        // KS-2955: гарантируем нижнюю границу анализа ≥ 1 секунда. На
        // depth=12 SF18 WASM в насыщенных позициях даёт ложные WDL
        // (например для FEN 3r4/pppk1pQP/8/...: depth=12 bestmove c5c6
        // wdl 0 679 321 → effWdlUser -0.32 → ложный «потеряно», на
        // depth 18 / movetime 1000 — bestmove g7f7 (Qxf7+) wdl 1000 0 0).
        return eng.analyze(fen, analyzeDepth, 1, analyzeMovetimeMs);
      });
      // Не пробрасываем ошибки в цепочку, чтобы один сбой не убил все
      // последующие analyze.
      engineQueueRef.current = next.catch(() => undefined);
      return next;
    },
    [ensureEngine, analyzeDepth, analyzeMovetimeMs],
  );

  useEffect(() => {
    return () => {
      try { engineRef.current?.destroy(); } catch { /* ignore */ }
      engineRef.current = null;
      engineInitPromiseRef.current = null;
    };
  }, []);

  // ── submit attempt one-shot ──────────────────────────────────────────
  const submitOnce = useCallback(
    (solved: boolean, finishReason: PlayVsEnginePuzzleReason, finalWdl: number, finalHalf: number) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      const data: PlayVsEngineSubmit = {
        solved,
        halfMovesPlayed: finalHalf,
        finalWdl,
        reason: finishReason,
        timeMs: Date.now() - startTimeRef.current,
        // KS-2719 F1 → KS-2739 fix: читаем ref, а не state. State-
        // версия `userBestLog` захватывается замыканием `useCallback` в
        // момент создания `submitOnce`, и из-за асинхронного
        // обновления state pre-analyze'ом цепочка `onPieceDrop →
        // runEngineCycle → finishWin → submitOnce` всегда видела
        // прежнюю (пустую) версию. KS-2738 девопс заметил
        // precision_attempts=0 на проде — следствие того, что moves
        // приходило `[]`. Через `userBestLogRef.current` гарантированно
        // последняя версия.
        //
        // KS-2508 fallback-effect мог ещё допечатать cpAfter уже после
        // finishWin/finishLose; такой post-submit апдейт всё ещё не
        // попадает в payload (submit одноразовый), но это редкий хвост,
        // backend грейсфолит на null cpAfter.
        moves: userBestLogRef.current,
      };
      void onSubmit?.(data);
    },
    [onSubmit],
  );

  // ── Win / lose helpers ───────────────────────────────────────────────
  const finishWin = useCallback(
    (finishReason: 'win' | 'win-mate' | 'win-engine-resign', wdl: number, half: number) => {
      setState('win');
      setReason(finishReason);
      playSound('puzzle-correct');
      submitOnce(true, finishReason, wdl, half);
    },
    [playSound, submitOnce],
  );

  const finishLose = useCallback(
    (finishReason: 'lose-wdl' | 'lose-mate', wdl: number, half: number) => {
      setState('lose');
      setReason(finishReason);
      playSound('puzzle-incorrect');
      submitOnce(false, finishReason, wdl, half);
    },
    [playSound, submitOnce],
  );

  // ── Engine response cycle ────────────────────────────────────────────
  // Запускается после хода игрока: analyze → возможно engine-ответ.
  const runEngineCycle = useCallback(
    async (after: Chess, halfAfterUser: number) => {
      setState('evaluating');
      try {
        await ensureEngine();
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'engine-init-failed');
        setState('error');
        return;
      }

      // 1) Оценка после хода пользователя — в этом fen ходит соперник.
      let result: AnalysisResult;
      try {
        result = await queueAnalyze(after.fen());
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : 'engine-error');
        setState('error');
        return;
      }
      const best = pickBestLine(result);
      if (!best) {
        setErrorMsg('engine-no-bestmove');
        setState('error');
        return;
      }
      setEvalLines(toEvalLines(result));
      // KS-2519: side-to-move на FEN после user-хода — соперник.
      setEvalSide(sideFromFen(after.fen()));
      const wdlEngine = scoreToWdlSigned(best.score);
      const wdlUser = -wdlEngine;
      setLatestWdlUser(wdlUser);
      // KS-2527: post-analyze FEN POV соперника → flipWdl для POV user.
      const wdlUserObj = best.wdl ? flipWdl(best.wdl) : null;
      setLatestWdl(wdlUserObj);
      // KS-2533: для win/lose решений используем «настоящий» WDL,
      // если есть; sigmoidная wdlUser — fallback. Без этого при
      // позиции Победа=100% sigmoid от cp=+50 ≈ +0.12 < winThreshold,
      // и UI показывал lose-wdl при идеальной игре (см. KS-2533).
      const effWdlUser = effectiveSignedWdl(wdlUserObj, wdlUser);

      // KS-2506: cpAfter POV юзера = −cp(score) POV соперника. Дописываем
      // в snapshot, созданный pre-analyze'ом. Pre-analyze идёт через
      // тот же queueAnalyze раньше post-analyze, так что snapshot обычно
      // уже на месте; если по какой-то причине pre-analyze упал и
      // snapshot отсутствует — просто молча пропускаем (cpAfter останется
      // вне лога; downstream-классификатор грейсфолит на null).
      const cpAfterUser = -cpFromScore(best.score);
      // KS-2686: wdl POV user после фактически сыгранного user-хода.
      // На post-analyze FEN'е ходит соперник → POV соперника, инвертируем.
      const wdlAfterUser = best.wdl ? flipWdl(best.wdl) : null;
      updateUserBestLog((prev) =>
        prev.map((s) =>
          s.halfMove === halfAfterUser
            ? {
                ...s,
                cpAfter: cpAfterUser,
                wdlAfter: wdlAfterUser,
                // depth берём максимум из pre/post — в pre-analyze
                // обычно записан, тут только если пред-snapshot отсутствует.
                depth: s.depth ?? best.depth,
              }
            : s,
        ),
      );

      // 2) Терминальные ситуации до хода движка.
      if (after.isCheckmate()) {
        // Side-to-move (engine) получил мат от пользователя.
        finishWin('win-mate', 1, halfAfterUser);
        return;
      }
      // KS-2533: смотрим effWdlUser, чтобы при WDL-данных юзер не
      // получил lose-wdl при реально выигрывающей позиции.
      // KS-2955: дополнительно учитываем `bestUci` из pre-analyze
      // snapshot — если фактический ход совпал с лучшим, «потеряно»
      // НЕ ставим даже при отрицательном effWdlUser (в задачах с
      // изначально проигранной позицией лучший ход не возвращает
      // оценку в плюс, но это не «потеря преимущества»).
      const snapForVerdict = userBestLogRef.current.find(
        (s) => s.halfMove === halfAfterUser,
      );
      if (
        shouldFinishLose(
          snapForVerdict
            ? { bestUci: snapForVerdict.bestUci, playedUci: snapForVerdict.playedUci }
            : null,
          effWdlUser,
          params.failThreshold,
        )
      ) {
        finishLose('lose-wdl', effWdlUser, halfAfterUser);
        return;
      }
      // engine видит мат против себя — resign.
      if (best.score.type === 'mate' && best.score.value < 0) {
        finishWin('win-engine-resign', effWdlUser, halfAfterUser);
        return;
      }
      // KS-2754 follow-up: задача завершается после N правильных
      // user-ходов; движок не должен отвечать на последний user-ход.
      // Источник N: `Math.ceil(params.halfMovesN / 2)` — у дефолтной
      // PVE-задачи `halfMovesN=6`, что даёт N=3 (3 user + 2 engine).
      // Backend меняет требование на 4 user-хода → ставит halfMovesN=8
      // → N=4 (4 user + 3 engine).
      const userMovesTarget = Math.ceil(params.halfMovesN / 2);
      if (userBestLogRef.current.length >= userMovesTarget) {
        if (effWdlUser >= params.winThreshold) {
          finishWin('win', effWdlUser, halfAfterUser);
        } else {
          finishLose('lose-wdl', effWdlUser, halfAfterUser);
        }
        return;
      }

      // 3) Применяем engine bestmove.
      setState('engine');
      const next = new Chess(after.fen());
      const uci = best.pv[0];
      let applied: ReturnType<Chess['move']> | null = null;
      try {
        applied = next.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
      } catch {
        applied = null;
      }
      if (!applied) {
        setErrorMsg('engine-illegal-move');
        setState('error');
        return;
      }
      playSound(soundEventFromSan(applied.san));
      lastMoveUciRef.current = uci;
      setGame(next);
      // KS-2486 reopen: ход движка тоже идёт в общий лог SAN.
      setPlayedSans((prev) => [...prev, applied!.san]);
      // KS-2754: дописываем engineUci в snapshot user-хода, на который
      // движок только что ответил. submitOnce читает userBestLogRef и
      // пробрасывает поле в payload submitAttempt → backend кладёт в
      // precision_attempt_moves.engine_uci → отдаёт обратно в
      // PrecisionMoveDto.engineUci для разбора партии без реконструкции.
      updateUserBestLog((prev) =>
        prev.map((s) =>
          s.halfMove === halfAfterUser ? { ...s, engineUci: uci } : s,
        ),
      );
      const halfAfterEngine = halfAfterUser + 1;
      setHalfMovesPlayed(halfAfterEngine);

      // 4) Проверки после хода движка.
      if (next.isCheckmate()) {
        // Защитный кейс: §2.3 фильтр должен исключать engine→mate user,
        // но защищаемся.
        finishLose('lose-mate', -1, halfAfterEngine);
        return;
      }
      if (halfAfterEngine >= params.halfMovesN) {
        // Финальный analyze, чтобы сверить wdl_user после хода engine.
        try {
          const final = await queueAnalyze(next.fen());
          const finalBest = pickBestLine(final);
          setEvalLines(toEvalLines(final));
          // KS-2519: после хода движка side-to-move = userSide.
          setEvalSide(sideFromFen(next.fen()));
          // Теперь side-to-move == userSide → POV-знак WDL = +1 для user.
          const wdlFinalUser = finalBest ? scoreToWdlSigned(finalBest.score) : wdlUser;
          setLatestWdlUser(wdlFinalUser);
          // KS-2527: side-to-move на final FEN = userSide → POV user без flip.
          const finalWdlObj = finalBest?.wdl ?? null;
          setLatestWdl(finalWdlObj);
          // KS-2533: см. effWdlUser выше — те же причины.
          const effWdlFinal = effectiveSignedWdl(finalWdlObj, wdlFinalUser);
          if (effWdlFinal >= params.winThreshold) {
            finishWin('win', effWdlFinal, halfAfterEngine);
          } else {
            finishLose('lose-wdl', effWdlFinal, halfAfterEngine);
          }
        } catch {
          // Если final analyze упал — судим по последнему effWdlUser.
          if (effWdlUser >= params.winThreshold) finishWin('win', effWdlUser, halfAfterEngine);
          else finishLose('lose-wdl', effWdlUser, halfAfterEngine);
        }
        return;
      }

      // 5) Возвращаем ход пользователю.
      setState('thinking');
    },
    [
      ensureEngine,
      queueAnalyze,
      params.failThreshold,
      params.winThreshold,
      params.halfMovesN,
      finishLose,
      finishWin,
      playSound,
      updateUserBestLog,
    ],
  );

  // ── User move handler ────────────────────────────────────────────────
  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (state !== 'thinking') return false;

      const next = new Chess(game.fen());
      let move: ReturnType<Chess['move']> | null = null;
      try {
        // Авто-продвижение в ферзя для MVP — ADR §5.6.
        move = next.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      } catch {
        move = null;
      }
      if (!move) return false;
      playSound(soundEventFromSan(move.san));
      const playedUci = sourceSquare + targetSquare;
      lastMoveUciRef.current = playedUci;
      const fenBefore = game.fen();
      setGame(next);
      // KS-2486 reopen: пишем SAN в общий лог, чтобы потом собрать
      // PGN партии для Workshop-ссылки.
      setPlayedSans((prev) => [...prev, move!.san]);
      const halfAfterUser = halfMovesPlayed + 1;
      setHalfMovesPlayed(halfAfterUser);

      // KS-2473: pre-analyze позиции ДО хода юзера (PV1 = лучший ход
      // юзера на этом полуходе). У нас один WASM-worker — конкурентные
      // analyze пересекают stdin Stockfish'а и ломают его. Поэтому
      // делаем pre-analyze СЕРИАЛЬНО до post-analyze в runEngineCycle.
      // Запускается фоном (void async) — onPieceDrop остаётся sync,
      // PuzzleBoard сразу анимирует фигуру.
      void (async () => {
        try {
          await ensureEngine();
          const pre = await queueAnalyze(fenBefore);
          const preBest = pickBestLine(pre);
          if (preBest && preBest.pv[0]) {
            // KS-2505: на `fenBefore` ходит юзер → score POV user без
            // инверсии. Mate нормализован cpFromScore до ±100000.
            const cpBefore = cpFromScore(preBest.score);
            // KS-2686: wdl на `fenBefore` POV user (юзер — side-to-move).
            // PV1 ведёт через bestUci → это и есть «WDL после лучшего хода».
            const wdlBefore = preBest.wdl ?? null;
            updateUserBestLog((prev) => [
              ...prev,
              {
                halfMove: halfAfterUser,
                fenBefore,
                playedUci,
                bestUci: preBest.pv[0],
                cpBefore,
                // KS-2506: cpAfter дописывается из runEngineCycle после
                // post-analyze; до этого момента — null.
                cpAfter: null,
                wdlBefore,
                wdlAfter: null,
                depth: preBest.depth,
                // KS-2754: engineUci допишется из runEngineCycle после
                // применения bestmove; для последнего полухода партии
                // (мат / достигнут halfMovesN / abort) останется null.
                engineUci: null,
              },
            ]);
          }
        } catch {
          /* ignore — post-mortem-подсказка для этого хода будет пустой */
        }
      })();

      if (halfAfterUser >= params.halfMovesN) {
        // По описанию ADR halfMovesN считается общим числом полуходов;
        // если пользователь сделал последний полуход — сразу финальный
        // чек после оценки. evaluating сделает analyze, и далее идёт
        // обычная проверка mate/wdl. Если wdl >= winThreshold и не lose
        // → это уже win, иначе lose.
        // Реализация: запускаем стандартный engine-cycle, но в нём при
        // halfAfterEngine >= N мы делаем final analyze. Чтобы учесть
        // случай user-last-move, обработаем здесь же.
        void (async () => {
          setState('evaluating');
          try {
            await ensureEngine();
            const result = await queueAnalyze(next.fen());
            const best = pickBestLine(result);
            setEvalLines(toEvalLines(result));
            // KS-2519: side-to-move на FEN после user-хода — соперник.
            setEvalSide(sideFromFen(next.fen()));
            if (next.isCheckmate()) {
              finishWin('win-mate', 1, halfAfterUser);
              return;
            }
            const wdlUser = best ? -scoreToWdlSigned(best.score) : 0;
            setLatestWdlUser(wdlUser);
            // KS-2527: post-analyze FEN POV соперника → flipWdl.
            const wdlUserObj = best?.wdl ? flipWdl(best.wdl) : null;
            setLatestWdl(wdlUserObj);
            // KS-2533: WDL-данные приоритетнее sigmoid.
            const effWdlUser = effectiveSignedWdl(wdlUserObj, wdlUser);
            // KS-2955: см. описание выше про учёт `bestUci`.
            const snapForVerdict = userBestLogRef.current.find(
              (s) => s.halfMove === halfAfterUser,
            );
            if (
              shouldFinishLose(
                snapForVerdict
                  ? {
                      bestUci: snapForVerdict.bestUci,
                      playedUci: snapForVerdict.playedUci,
                    }
                  : null,
                effWdlUser,
                params.failThreshold,
              )
            ) {
              finishLose('lose-wdl', effWdlUser, halfAfterUser);
              return;
            }
            if (best && best.score.type === 'mate' && best.score.value < 0) {
              finishWin('win-engine-resign', effWdlUser, halfAfterUser);
              return;
            }
            if (effWdlUser >= params.winThreshold)
              finishWin('win', effWdlUser, halfAfterUser);
            else finishLose('lose-wdl', effWdlUser, halfAfterUser);
          } catch (e) {
            setErrorMsg(e instanceof Error ? e.message : 'engine-error');
            setState('error');
          }
        })();
        return true;
      }

      void runEngineCycle(next, halfAfterUser);
      return true;
    },
    [
      state,
      game,
      halfMovesPlayed,
      params.halfMovesN,
      params.failThreshold,
      params.winThreshold,
      runEngineCycle,
      playSound,
      ensureEngine,
      queueAnalyze,
      finishLose,
      finishWin,
      updateUserBestLog,
    ],
  );

  // ── Reset при смене puzzle ───────────────────────────────────────────
  useEffect(() => {
    setGame(new Chess(puzzle.fen));
    setState('thinking');
    setHalfMovesPlayed(0);
    setEvalLines([]);
    // KS-2519: на старте side-to-move = ходящему в puzzle.fen
    // (решатель). EvalBar до initial analyze получит пустой массив и
    // отрендерит «0.0», но evalSide важен на случай, если первый
    // setEvalLines (initial) опередит сброс.
    setEvalSide(sideFromFen(puzzle.fen));
    setLatestWdlUser(params.wdlAfterBlunder);
    // KS-2527: latestWdl сбрасываем в null — initial analyze запишет
    // настоящее значение из движка (если UCI_ShowWDL поддерживается).
    setLatestWdl(null);
    setReason(null);
    // KS-2739: ref сбрасываем тут же чтобы не утащить лог прошлого пазла
    // в submit нового. updateUserBestLog тоже работал бы, но reset-эффект
    // не должен зависеть от useCallback — пишем напрямую.
    userBestLogRef.current = [];
    setUserBestLog([]);
    // KS-2510: при новом пазле выкл review-snapshot, чтобы доска
    // показывала актуальную позицию для нового решения.
    setReviewFen(null);
    // KS-2486 reopen: сброс SAN-лога при смене drill'а.
    setPlayedSans([]);
    setErrorMsg('');
    submittedRef.current = false;
    startTimeRef.current = Date.now();
    lastMoveUciRef.current = null;
  }, [puzzle.id, puzzle.fen, params.wdlAfterBlunder]);

  // ── KS-2507 / ADR-047 §2.1 + §3 #4 ───────────────────────────────────
  // Initial pre-analyze стартовой позиции — чтобы `<EvalBar />` сразу
  // показывал оценку, а не дефолтный «0.0», пока юзер думает над первым
  // ходом. Идёт через тот же queueAnalyze — последовательно с pre/post
  // analyze, без риска пересечения stdin Stockfish'а.
  //
  // Запускается только при смене puzzle.id (deps по тикету). Race с
  // pre-analyze первого хода: setEvalLines в обоих местах — последний
  // запиcавший выигрывает, что для UI приемлемо: pre-analyze хода
  // запускается на FEN ДО хода (== puzzle.fen на 1-м полуходе), так что
  // оба analyze дают одну и ту же оценку. Ошибки молча проглатываем —
  // EvalBar не критичен.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureEngine();
        const initial = await queueAnalyze(puzzle.fen);
        if (cancelled) return;
        setEvalLines(toEvalLines(initial));
        // KS-2519: initial analyze был на puzzle.fen → side = решатель.
        setEvalSide(sideFromFen(puzzle.fen));
        // KS-2527: на puzzle.fen ходит решатель = user → wdl POV user
        // без flip. null если info без wdl.
        const initialBest = pickBestLine(initial);
        setLatestWdl(initialBest?.wdl ?? null);
      } catch {
        /* ignore — EvalBar не критичен, юзер сделает ход и анализ
           перезапустится в runEngineCycle. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [puzzle.id, puzzle.fen, ensureEngine, queueAnalyze]);

  // ── KS-2508 / ADR-047 §4(i) ──────────────────────────────────────────
  // Fallback-analyze для записей userBestLog без cpAfter. Сценарий:
  // pre-analyze (фоновый, fire-and-forget) опаздывает создать snapshot,
  // и когда runEngineCycle пытается дописать cpAfter через `prev.map`,
  // записи ещё нет — cpAfter теряется. Pre-analyze добавляет snapshot
  // позже с cpAfter=null. После завершения партии (state in win|lose)
  // пробегаем по записям с cpAfter===null и считаем cp на FEN после
  // playedUci через тот же queueAnalyze. Score POV соперника →
  // инвертируем, как в KS-2506.
  useEffect(() => {
    if (state !== 'win' && state !== 'lose') return;
    let cancelled = false;
    void (async () => {
      const missing = userBestLog.filter((s) => s.cpAfter === null);
      if (missing.length === 0) return;
      try {
        await ensureEngine();
      } catch {
        return;
      }
      for (const s of missing) {
        if (cancelled) return;
        try {
          const c = new Chess(s.fenBefore);
          c.move({
            from: s.playedUci.slice(0, 2),
            to: s.playedUci.slice(2, 4),
            promotion:
              s.playedUci.length > 4 ? s.playedUci[4] : undefined,
          });
          const r = await queueAnalyze(c.fen());
          if (cancelled) return;
          const b = pickBestLine(r);
          if (!b) continue;
          const cpAfter = -cpFromScore(b.score);
          // KS-2686: на FEN'е после хода юзера ходит соперник → flipWdl.
          const wdlAfter = b.wdl ? flipWdl(b.wdl) : null;
          updateUserBestLog((prev) =>
            prev.map((x) =>
              x.halfMove === s.halfMove
                ? {
                    ...x,
                    cpAfter,
                    wdlAfter,
                    depth: x.depth ?? b.depth,
                  }
                : x,
            ),
          );
        } catch {
          /* ignore — отсутствие cpAfter PostGameReview грейсфолит. */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, userBestLog, ensureEngine, queueAnalyze, updateUserBestLog]);

  // ── UI helpers ───────────────────────────────────────────────────────
  const halfMovesLeft = Math.max(0, params.halfMovesN - halfMovesPlayed);
  const progressPercent = Math.min(100, Math.round((halfMovesPlayed / params.halfMovesN) * 100));
  // KS-2519: `isBlackOriented` больше не нужен — EvalBar получает
  // isBlackTurn={evalSide === 'b'}. Локальная константа удалена,
  // чтобы lint не ругался на unused.

  // Подсветка blunderMove на стартовой позиции (KS-2466 §4).
  const blunderHighlight = useMemo(() => {
    if (halfMovesPlayed > 0) return null;
    const m = params.blunderMove;
    if (!m || m.length < 4) return null;
    return m;
  }, [halfMovesPlayed, params.blunderMove]);

  // Маппинг внутреннего state → status, который понимает PuzzleBoard.
  const boardStatus = useMemo(() => {
    if (state === 'win') return 'correct';
    if (state === 'lose') return 'incorrect';
    if (state === 'evaluating' || state === 'engine') return 'checking';
    return 'thinking';
  }, [state]);

  const reasonLabel = (r: PlayVsEnginePuzzleReason | null): string => {
    switch (r) {
      case 'win':
        return t('puzzle.engine.win', 'You held the advantage');
      case 'win-mate':
        return t('puzzle.engine.winMate', 'Checkmate!');
      case 'win-engine-resign':
        return t('puzzle.engine.winResign', 'Engine resigned (sees mate)');
      case 'lose-wdl':
        return t('puzzle.engine.loseWdl', 'You lost the advantage');
      case 'lose-mate':
        return t('puzzle.engine.loseMate', 'You got mated');
      default:
        return '';
    }
  };

  // KS-2509 / ADR-047 §3 #6: блок `bestmoveHint` (показывал только
  // последний ход) полностью заменён на `<PostGameReview>` — там
  // полный список ходов с cp-loss классификацией. JSX рендерится
  // ниже в win/lose-блоке.

  // KS-2471: blunder в SAN.
  const blunderSan = useMemo(
    () => blunderUciToSan(params.blunderMove, puzzle.fen),
    [params.blunderMove, puzzle.fen],
  );

  return (
    <div
      className="puzzle-engine-runner"
      data-testid="puzzle-engine-runner"
      data-mode="play-vs-engine"
      data-state={state}
      data-half-moves={halfMovesPlayed}
      data-reason={reason ?? ''}
      data-eval-lines={evalLines.length}
      data-eval-side={evalSide}
      data-latest-wdl={
        latestWdl
          ? `${latestWdl.w},${latestWdl.d},${latestWdl.l}`
          : ''
      }
      data-review-fen={reviewFen ?? ''}
    >
      <div className="puzzle-engine-runner__layout">
        {/* KS-2519: isBlackTurn должен отражать side-to-move на FEN, по
            которому посчитан evalLines (Stockfish отдаёт score POV
            side-to-move). До тикета сюда подставлялась `isBlackOriented`
            (ориентация доски, не side-to-move) — bar показывал
            перевёрнутую оценку при чёрном решателе. */}
        <EvalBar lines={evalLines} isBlackTurn={evalSide === 'b'} />

        <div className="puzzle-engine-runner__board-col">
          <div className="puzzle-engine-runner__progress" data-testid="puzzle-engine-progress">
            {/* KS-2923: подпись над progress-bar. Место под неё уже
                зарезервировано CSS-правкой KS-2922 (074b2edb). */}
            <div
              className="puzzle-engine-runner__progress-title"
              data-testid="puzzle-engine-progress-title"
            >
              {t('precision.attempt.progressLabel', 'Task progress')}
            </div>
            <div className="puzzle-engine-runner__progress-bar">
              <div
                className="puzzle-engine-runner__progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="puzzle-engine-runner__progress-label">
              {t('puzzle.engine.halfMovesLeft', '{{count}} half-moves left', {
                count: halfMovesLeft,
              })}
            </div>
          </div>

          {state === 'thinking' && halfMovesPlayed === 0 && (
            <p
              className="puzzle-engine-runner__hint"
              data-testid="puzzle-engine-blunder-hint"
              data-blunder-known={blunderSan ? 'true' : 'false'}
            >
              {/*
                KS-2732: если в DTO нет blunderMove (backend mismatch или
                forced-line пазл попал в PVE-runner) — рендерим
                generic-текст без «зевнул ходом ?». Раньше шаблон был
                fallback'ом на '?', что выглядело как баг для юзера.
              */}
              {blunderSan
                ? t(
                    'puzzle.engine.blunderHint',
                    'Opponent just blundered ({{move}}). Hold the advantage for {{n}} half-moves.',
                    {
                      move: blunderSan,
                      n: params.halfMovesN,
                    },
                  )
                : t(
                    'puzzle.engine.blunderHintGeneric',
                    'Hold the advantage against the engine for {{n}} half-moves.',
                    { n: params.halfMovesN },
                  )}
            </p>
          )}

          {/* KS-2510: при выбранном snapshot'е (reviewFen != null) на
              доске показываем позицию ДО ошибочного хода, чтобы юзер
              визуально видел альтернативу. Новый Chess создаём ad-hoc;
              он не сохраняется в game-стейт, чтобы ход «Next» вернул
              финальную позицию (не нужна — пазл уже завершён, но
              consistency со стандартным reset-флоу). lastMoveUci при
              review убираем — выделение на старой позиции запутает. */}
          <PuzzleBoard
            game={reviewFen ? new Chess(reviewFen) : game}
            boardOrientation={orientation}
            enabled={state === 'thinking' && !reviewFen}
            onPieceDrop={onPieceDrop}
            lastMoveUci={
              reviewFen ? null : (lastMoveUciRef.current ?? blunderHighlight)
            }
            status={boardStatus}
          />

          {/* KS-2486: открыть пазл в мастерской (анализ). Передаём
              `?fen=<initialPuzzleFen>&pgn=<пройденные ходы>` — Workshop
              откроется с НАЧАЛЬНОЙ позицией пазла и партией всех
              сделанных ходов (включая ходы движка), пользователь
              сможет промотать с начала и разобрать каждый ход
              (KS-2486 reopen). `target=_blank` — не прерывать пазл. */}
          <div
            className="puzzle-engine-runner__actions"
            data-testid="puzzle-engine-actions"
          >
            <a
              className="puzzle-engine-runner__workshop-link"
              data-testid="puzzle-engine-workshop-link"
              href={(() => {
                // KS-2486 reopen: PGN — пройденные ходы (user + engine)
                // в SAN, объединённые пробелом. AnalysisPage парсит
                // SAN из `?pgn=` и реплеит на `?fen=` (initial puzzle FEN).
                const movesText = playedSans.join(' ');
                const fenParam = `fen=${encodeURIComponent(puzzle.fen)}`;
                const pgnParam = movesText
                  ? `&pgn=${encodeURIComponent(movesText)}`
                  : '';
                return `/analysis?${fenParam}${pgnParam}`;
              })()}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('puzzle.engine.openInWorkshop', 'Open in Workshop')}
            </a>
          </div>

          {(state === 'win' || state === 'lose') && (
            <div className="puzzle-engine-runner__result" data-testid="puzzle-engine-result">
              <div className={`puzzle-engine-runner__result-label puzzle-engine-runner__result-label--${state}`}>
                {reasonLabel(reason)}
              </div>
              {/* KS-2686: финальный summary блок.
                  Только реальные WDL Stockfish (UCI_ShowWDL=true) +
                  WDL пазла (puzzle.playVsEngine.wdlAfter, KS-2524).
                  Если хотя бы одного нет — блок не рендерится; внешний
                  reasonLabel выше остаётся единственным заголовком.
                  Sigmoid-fallback из cp удалён по требованию: при
                  отсутствии вероятностных данных от движка показывать
                  одну цифру некорректно (см. комментарии пользователя
                  в задаче).
                  Внутренний lost/preserved-header УБРАН — он дублировал
                  внешний reasonLabel. */}
              {(() => {
                const wdlAfter = puzzle.playVsEngine?.wdlAfter;
                if (!wdlAfter || !latestWdl) return null;

                const start = {
                  w: permilleToPercent(wdlAfter.w),
                  d: permilleToPercent(wdlAfter.d),
                  l: permilleToPercent(wdlAfter.l),
                };
                const final = {
                  w: permilleToPercent(latestWdl.w),
                  d: permilleToPercent(latestWdl.d),
                  l: permilleToPercent(latestWdl.l),
                };
                // signedFmt: «−65», «+47» (ноль без знака).
                const signedFmt = (n: number): string => {
                  if (n === 0) return '0';
                  return `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
                };
                const dW = final.w - start.w;
                const dD = final.d - start.d;
                const dL = final.l - start.l;
                const preserved = state === 'win';
                return (
                  <div
                    className={`puzzle-engine-runner__wdl-summary puzzle-engine-runner__wdl-summary--${preserved ? 'preserved' : 'lost'}`}
                    data-testid="puzzle-engine-wdl-summary"
                    data-preserved={preserved ? 'true' : 'false'}
                    data-mode="permille"
                    data-start-w={String(start.w)}
                    data-start-d={String(start.d)}
                    data-start-l={String(start.l)}
                    data-final-w={String(final.w)}
                    data-final-d={String(final.d)}
                    data-final-l={String(final.l)}
                  >
                    <div
                      className="puzzle-engine-runner__wdl-summary-line"
                      data-testid="puzzle-engine-wdl-summary-line"
                    >
                      <div data-testid="puzzle-engine-wdl-row-win">
                        {t(
                          'puzzle.engine.summary.lineWdl',
                          '{{label}}: {{start}}% → {{final}}% ({{delta}})',
                          {
                            label: t('puzzle.engine.summary.win', 'Win'),
                            start: start.w,
                            final: final.w,
                            delta: `${signedFmt(dW)}%`,
                          },
                        )}
                      </div>
                      <div data-testid="puzzle-engine-wdl-row-draw">
                        {t(
                          'puzzle.engine.summary.lineWdl',
                          '{{label}}: {{start}}% → {{final}}% ({{delta}})',
                          {
                            label: t(
                              'puzzle.engine.summary.draw',
                              'Draw',
                            ),
                            start: start.d,
                            final: final.d,
                            delta: `${signedFmt(dD)}%`,
                          },
                        )}
                      </div>
                      <div data-testid="puzzle-engine-wdl-row-loss">
                        {t(
                          'puzzle.engine.summary.lineWdl',
                          '{{label}}: {{start}}% → {{final}}% ({{delta}})',
                          {
                            label: t(
                              'puzzle.engine.summary.loss',
                              'Loss',
                            ),
                            start: start.l,
                            final: final.l,
                            delta: `${signedFmt(dL)}%`,
                          },
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* KS-2508 / ADR-047 §2.2 + §3 #5: список ходов с
                  метками классификации (best/good/inaccuracy/mistake/
                  blunder). Появляется только на win/lose. Если у
                  последнего хода cpAfter=null — fallback-effect выше
                  допишет, и компонент перерисуется с правильной меткой.
                  KS-2510: клик по строке показывает на доске позицию
                  ДО этого хода (`fenBefore`) — для визуального разбора
                  «что было перед моей ошибкой». */}
              {/* KS-2534: PGN-формат с NAG-аннотациями вместо карточек.
                  Отдаём всю партию через `playedSans` + `userBestLog`
                  для классификации; компонент сам ходит chess.js'ом
                  от `initialFen` для номеров ходов и SAN'а вариантов. */}
              <PostGameReview
                initialFen={puzzle.fen}
                playedSans={playedSans}
                userBestLog={userBestLog}
                userSide={userSide}
                onSelectMove={({ fenBefore }) => setReviewFen(fenBefore)}
              />
              {onNext && (
                <button
                  type="button"
                  className="play-btn"
                  onClick={onNext}
                  data-testid="puzzle-engine-next"
                >
                  {t('puzzle.next', 'Next')}
                </button>
              )}
            </div>
          )}

          {state === 'error' && (
            <div className="puzzle-engine-runner__error" data-testid="puzzle-engine-error">
              {t('puzzle.engine.error', 'Engine error')}: {errorMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
