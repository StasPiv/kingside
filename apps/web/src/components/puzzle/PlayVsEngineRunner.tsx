import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type {
  PuzzleDto,
  PlayVsEnginePuzzleReason,
  PuzzleObjective,
} from '@kingside/shared';
import { PuzzleObjectiveBadge } from './PuzzleObjectiveBadge';
// KS-3018 hotfix: рассчитываем итоговую 5-балльную оценку прямо во фронте
// из `userBestLog` — данные уже собраны. Это убирает round-trip к backend
// после POST attempt и даёт мгновенный результат на финальном экране.
import {
  computePrecisionScore,
  type PrecisionMoveInput,
} from '@kingside/shared';

/**
 * KS-3074. Сборка input'ов для shared `computePrecisionScore` из
 * `userBestLog`. Критически важно передавать `playedUci` и `bestUci` —
 * без них `accuracyMove` теряет best-override (KS-3030) и считает
 * каждый эталонный ход по WDL, который у Stockfish между depths
 * гуляет на единицы процентов. На 3 best-ходах это давало 79% / 3★
 * в раннере против 100% / 5★ в истории (backend передаёт UCI и
 * override срабатывает) — жалоба пользователя из Telegram.
 *
 * Вынесено в чистую функцию для unit-теста регрессии (см.
 * `PlayVsEngineRunner.test.tsx`, KS-3074).
 */
export function buildPrecisionScoreInputs(
  log: ReadonlyArray<{
    wdlBefore: WdlDistribution | null;
    wdlAfter: WdlDistribution | null;
    cpBefore: number | null;
    cpAfter: number | null;
    playedUci: string;
    bestUci: string;
  }>,
): PrecisionMoveInput[] {
  return log.map((m) => ({
    wdlBefore: m.wdlBefore,
    wdlAfter: m.wdlAfter,
    cpBefore: m.cpBefore,
    cpAfter: m.cpAfter,
    playedUci: m.playedUci,
    bestUci: m.bestUci,
  }));
}
import { PuzzleBoard } from '../PuzzleBoard';
// KS-3391: на /precision вместо вертикального градусника (EvalBar)
// показываем трёхцветную горизонтальную полосу шансов W/D/L. EvalBar
// в других местах (анализ, live-партии) не трогаем.
import { WdlChancesBar } from '../WdlChancesBar';
import { PromotionPicker, type PromotionPiece } from '../PromotionPicker';
import { PostGameReview } from './PostGameReview';
import { PrecisionScoreBlock } from '../precision/PrecisionScoreBlock';
import { EngineLoader } from '../EngineLoader';
import { useSounds, soundEventFromSan } from '../../hooks/useSounds';
import { permilleToPercent } from '../../utils/chessFormat';
import {
  WasmEngineAdapter,
  type EngineAdapter,
  type AnalysisResult,
  type WdlDistribution,
  type WasmEngineErrorReason,
} from '../../utils/engineAdapter';
import type { EvalLine, EngineErrorReason } from '../../hooks/useStockfish';
import {
  shouldFinishLose,
  isWinDropExcessive,
  meetsFinalObjective,
} from './precisionVerdict';

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
   * KS-3349 (ADR-079 §3.4). Кнопка «Назад» рядом со «Следующая» — на
   * `/precision`-флоу возвращает на список (с сохранением фильтров).
   * Если не передана — кнопка не рендерится.
   */
  onBack?: () => void;
  /**
   * KS-3349 (ADR-079 §3.5). Дельта precision-рейтинга после попытки.
   * Рендерится в result-блоке. `null` → не показываем (гость, ошибка
   * fetch, ещё не загружено).
   */
  precisionRatingChange?: {
    ratingBefore: number;
    ratingAfter: number;
    ratingDelta: number;
  } | null;
  /**
   * KS-3349. data-testid префикс для контейнера кнопок «Назад/Следующая»
   * (нужно для тестов). По умолчанию — undefined.
   */
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
   * грейсфолить.
   */
  cpBefore: number | null;
  /**
   * KS-2506 → KS-3380. cp-оценка СЫГРАННОГО хода POV юзера, снятая в
   * pre-frame на `fenBefore` через `searchmoves=[playedUci]`. До KS-3380
   * сюда писалась оценка post-analyze позиции ПОСЛЕ хода (POV соперника
   * + инверсия знака), но расхождение pre vs post на WASM (depth 18 /
   * 1s movetime) приводило к ложным `?!` даже на PV1-ходах. Теперь
   * `cpBefore` и `cpAfter` берутся из ОДНОЙ фрейма: первый — PV1
   * (bestUci) на `fenBefore`, второй — PV1 при ограничении searchmoves
   * до `playedUci` на той же `fenBefore`. Если `playedUci===bestUci`,
   * extra-analyze не делается, `cpAfter = cpBefore`. `null` —
   * pre-analyze упал ИЛИ extra-analyze упал; downstream грейсфолит.
   */
  cpAfter: number | null;
  /**
   * KS-2686. WDL POV user в позиции ДО хода юзера (`fenBefore`).
   * Pre-analyze идёт на FEN'е, где ходит сам юзер → WDL уже POV user
   * без инверсии. PV1 ведёт через bestUci → это «WDL после bestUci».
   */
  wdlBefore: WdlDistribution | null;
  /**
   * KS-2686 → KS-3380. WDL POV user СЫГРАННОГО хода в pre-frame на
   * `fenBefore` через `searchmoves=[playedUci]`. См. длинный коммент
   * к `cpAfter` выше — та же логика для WDL.
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
/**
 * KS-3035 / KS-3164: SAN зевка → строка с номером хода.
 *
 * Для **реактивного** пазла (`puzzle.fen = fenAfter`, side-to-move =
 * решающий = противник зевнувшего):
 *   - solver=w, fm=N → зевнули чёрные → «${N-1}... ${san}»;
 *   - solver=b, fm=N → зевнули белые  → «${N}. ${san}».
 * fullmoveNumber по правилам FEN увеличивается ПОСЛЕ хода чёрных.
 *
 * Для **превентивного** пазла (`puzzle.fen = fenBefore`, side-to-move =
 * сам зевнувший, ход ещё не сделан):
 *   - solver=w, fm=N → зевнут БЕЛЫЙ → «${N}. ${san}»;
 *   - solver=b, fm=N → зевнут ЧЁРНЫЙ → «${N}... ${san}».
 * KS-3164: до этого тикета фронт всегда использовал реактивную формулу,
 * из-за чего на превентивном пазле KS-3139 (39. d6, белые) показывалось
 * «38... d6» (формат хода чёрных). Теперь формула выбирается по
 * `puzzlePhase`.
 *
 * Без SAN (пустая строка / неизвестный blunder) возвращает пустую
 * строку — caller сам выберет generic-вариант.
 */
export function formatBlunderMoveWithNumber(
  san: string,
  postBlunderFen: string,
  puzzlePhase?: 'preventive' | 'reactive' | null,
): string {
  if (!san) return '';
  const parts = postBlunderFen.split(' ');
  const sideToMove = parts[1] === 'b' ? 'b' : 'w';
  const fullmove = Math.max(1, parseInt(parts[5] ?? '1', 10) || 1);
  if (puzzlePhase === 'preventive') {
    // side-to-move в fenBefore = сам зевнувший.
    if (sideToMove === 'w') {
      return `${fullmove}. ${san}`;
    }
    return `${fullmove}... ${san}`;
  }
  // Реактивный (или legacy без тега) — старая логика по противнику.
  if (sideToMove === 'w') {
    const blackMoveNumber = Math.max(1, fullmove - 1);
    return `${blackMoveNumber}... ${san}`;
  }
  return `${fullmove}. ${san}`;
}

/**
 * KS-3035: выбор i18n-ключа goal по WDL_before решателя.
 *
 *  - `wdl.w > 550` → advantage (можно реально выиграть).
 *  - `E = w + d/2 ∈ [400..600]` → equality (зона ничейного баланса).
 *  - `wdl.w < 400` → defense (хуже у решателя — защита проигранной).
 *
 * Приоритеты при пересечении: advantage > equality > defense >
 * fallback `advantage` (исторический default).
 *
 * Все значения в per-mille (0..1000) — формат `WdlDistribution`
 * из Stockfish.
 */
export function selectBlunderGoalKey(
  wdl: WdlDistribution | null | undefined,
): 'advantage' | 'equality' | 'defense' {
  if (!wdl) return 'advantage';
  if (wdl.w > 550) return 'advantage';
  const expected = wdl.w + wdl.d / 2;
  if (expected >= 400 && expected <= 600) return 'equality';
  if (wdl.w < 400) return 'defense';
  return 'advantage';
}

/**
 * KS-2471 → KS-3035: SAN зевка соперника.
 *
 * Precise path (KS-3035): если у нас есть `fenBeforeBlunder` (backend
 * кладёт его в `playVsEngine.fenBeforeBlunder` для generated-пазлов) —
 * берём SAN через `chess.move(uci)` прямо с pre-blunder позиции. Это
 * даёт корректную нотацию с захватами (`Nxe5`) и шахами/матами
 * (`Nxe5+`, `Qf7#`).
 *
 * Fallback (legacy/lichess без fenBeforeBlunder): эвристическая
 * реконструкция из postBlunder — фигуру с `to` обратно на `from`,
 * переключаем side-to-move. На capture-зевках взятую фигуру восстановить
 * нельзя, поэтому SAN будет без `x`/`+` (получим `Ne5` вместо `Nxe5+`).
 * Это лучше сырого UCI. При любых ошибках — fallback на UCI.
 */
export function blunderUciToSan(
  blunderUci: string,
  postBlunderFen: string,
  fenBeforeBlunder?: string | null,
): string {
  if (!blunderUci || blunderUci.length < 4) return blunderUci;
  if (fenBeforeBlunder) {
    try {
      const c = new Chess(fenBeforeBlunder);
      const mv = c.move({
        from: blunderUci.slice(0, 2),
        to: blunderUci.slice(2, 4),
        promotion: blunderUci.length > 4 ? blunderUci[4] : undefined,
      });
      if (mv?.san) return mv.san;
    } catch {
      /* fallthrough на эвристический путь */
    }
  }
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
  onBack,
  precisionRatingChange,
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

  // KS-3169: жанр пазла нужен и в финальном вердикте win/lose
  // (saveEquality считает «удержание ничьи» успехом), и в reasonLabel
  // ниже по дереву. Раньше определялся локально внутри return — поднят
  // на уровень компонента, чтобы `runEngineCycle` и last-user-move
  // могли применить objective-aware критерий через `meetsFinalObjective`.
  const objective: PuzzleObjective | null | undefined =
    puzzle.playVsEngine?.objective;

  // Сторона решателя — ходит первым после blunder.
  const userSide = useMemo<'w' | 'b'>(() => sideFromFen(puzzle.fen), [puzzle.fen]);
  const orientation = userSide === 'w' ? 'white' : 'black';

  // KS-3162 / KS-3164 / KS-3370: фаза пазла читается из тега в
  // `puzzle.themes`. Используется в:
  //   - KS-3370 replayBlunder (preventive ветка с возвратом на стартовую);
  //   - KS-3164 форматировании move-индекса;
  //   - KS-3162 выборе hint-ключа (упразднено KS-3369);
  //   - data-attr на replay-кнопке (KS-3369).
  const puzzlePhaseFromThemes: 'preventive' | 'reactive' | null = (() => {
    const themesArr: ReadonlyArray<string> = Array.isArray(puzzle.themes)
      ? (puzzle.themes as ReadonlyArray<string>)
      : [];
    if (themesArr.includes('preventive')) return 'preventive';
    if (themesArr.includes('reactive')) return 'reactive';
    return null;
  })();

  // KS-3365: стартуем с fenBeforeBlunder (если есть) — затем эффектом
  // ниже анимируем blunderMove до перехода в puzzle.fen. UX: пользователь
  // видит как соперник ходит, не получает позицию «с воздуха».
  // Если поля нет (legacy/lichess) — стартуем с puzzle.fen без анимации.
  const fenBeforeBlunder =
    (puzzle.playVsEngine as { fenBeforeBlunder?: string } | undefined)
      ?.fenBeforeBlunder ?? null;
  const canAnimateBlunder = Boolean(
    fenBeforeBlunder && params.blunderMove && params.blunderMove.length >= 4,
  );
  const [game, setGame] = useState<Chess>(() =>
    canAnimateBlunder && fenBeforeBlunder
      ? new Chess(fenBeforeBlunder)
      : new Chess(puzzle.fen),
  );
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
  /**
   * KS-2960. Baseline WDL стартовой позиции (POV решателя), посчитанный
   * локальным SF18 WASM — тем же движком, что играет в раннере. Считается
   * в initial pre-analyze (см. effect KS-2507 ниже) и хранится отдельно
   * от `latestWdl`, чтобы не перезаписываться при post-analyze.
   *
   * Используется как `start`-значение в финальном WDL-summary и как
   * initial значение для `latestWdlUser` — вместо серверного
   * `puzzle.playVsEngine.wdlAfter` / `wdlAfterBlunder`. Серверные поля
   * остаются fallback'ом если pre-analyze упал (worker не загрузился /
   * таймаут).
   *
   * Зачем: gen-time оценка пазла может быть посчитана на другом движке,
   * глубине или через mate-fallback в `wdlSignedFromInfo` — UI ловил
   * расхождения и показывал «преимущество удержано/потеряно» в обратную
   * сторону. См. KS-2955 / KS-2960.
   */
  const [clientBaselineWdl, setClientBaselineWdl] = useState<WdlDistribution | null>(null);
  /**
   * KS-2968: ref-зеркало clientBaselineWdl. finishWin/Lose-точки внутри
   * `runEngineCycle`/`onPieceDrop` читают baseline без добавления state'а
   * в зависимости useCallback (иначе колбэки пересоздаются каждый раз
   * при baseline-update и теряются стабильные ссылки). Pattern такой же
   * как `userBestLogRef` (KS-2739). Обновляется параллельно state'у в
   * `updateClientBaselineWdl`.
   */
  const clientBaselineWdlRef = useRef<WdlDistribution | null>(null);
  const updateClientBaselineWdl = useCallback(
    (next: WdlDistribution | null) => {
      clientBaselineWdlRef.current = next;
      setClientBaselineWdl(next);
    },
    [],
  );
  const [reason, setReason] = useState<PlayVsEnginePuzzleReason | null>(null);
  /**
   * KS-2969: pending promotion. Когда юзер тащит пешку на 8-й (для белых)
   * или 1-й (для чёрных) ряд, мы НЕ применяем ход сразу с авто-ферзём, а
   * открываем модалку выбора фигуры (Q/R/B/N). После выбора применяем
   * `applyUserMove(from, to, piece)`. Тот же UX-паттерн, что в GamePage
   * (live-партии) и AnalysisPage (анализ).
   */
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: Square;
    to: Square;
  } | null>(null);
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

  /**
   * KS-3170 (регрессия KS-3067): UI-состояние загрузки/ошибки движка.
   * До этого тикета `PlayVsEngineRunner` создавал `WasmEngineAdapter`
   * напрямую через `new WasmEngineAdapter()`, в обход `useStockfish` —
   * соответственно `<EngineLoader>` (KS-3067) на /precision не рендерился,
   * пользователь видел немой спиннер до 30 с таймаута (а на single-сборке
   * 113 МБ — гарантированно до таймаута на 4G мобильном).
   *
   * Теперь адаптер пробрасывает прогресс предзагрузки lite-wasm (7 МБ)
   * и причину ошибки наружу через колбэки конструктора, а раннер рендерит
   * EngineLoader в block-варианте при `loading`/`error`.
   */
  const [engineLoadState, setEngineLoadState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [engineLoadProgress, setEngineLoadProgress] = useState(0);
  const [engineErrorReason, setEngineErrorReason] = useState<EngineErrorReason>(null);

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
  /**
   * KS-3391: «живой» анализ позиции игрока. Пока игрок думает над ходом,
   * запускаем `analyzeLive` (go infinite) и стримим промежуточные WDL в
   * полосу шансов — она уточняется по мере роста глубины SF.
   *
   * `liveGenRef` — generation-счётчик: каждый start/stop инкрементит его,
   * чтобы устаревший onUpdate (от прошлой позиции) не перезаписывал
   * `latestWdl`, и чтобы pending-в-очереди live-анализ, отменённый до
   * старта, не запускал лишний `go infinite`.
   *
   * `liveInFlightRef` — реально ли сейчас идёт `go infinite` на worker'е.
   * Нужно, чтобы `stop()` дёргался ТОЛЬКО когда live-анализ в работе, и
   * не прерывал случайно классификационный analyze (pre/post).
   */
  const liveGenRef = useRef(0);
  const liveInFlightRef = useRef(false);

  // KS-3365/3366/3370: анимация blunderMove на старте + кнопка «Проиграть
  // последний ход». PuzzleBoard анимирует движение фигуры через
  // setGame с интервалом 300ms (KS-3366). После анимации `lastMoveUciRef`
  // хранит blunderMove → подсветка `from`/`to`-клеток.
  //
  // KS-3370: ветвление по фазе пазла:
  //   - **reactive** (соперник зевнул, solver наказывает): start =
  //     `fenBeforeBlunder` (позиция ДО зевка), через 400ms applying
  //     blunderMove → board переходит в `puzzle.fen` (позиция ПОСЛЕ
  //     зевка) → solver играет с неё. Финальная позиция — `puzzle.fen`.
  //   - **preventive** (солвер играет ВМЕСТО зевка): `fenBeforeBlunder
  //     === puzzle.fen` (стартовая позиция). Анимация: применить
  //     blunderMove на `puzzle.fen` → пауза 1500ms → откат обратно на
  //     `puzzle.fen` (solver сейчас играет с этой позиции, выбрав
  //     ход отличный от blunderMove). Финальная позиция — `puzzle.fen`.
  const blunderReplayTimerRef = useRef<number | null>(null);
  const blunderRevertTimerRef = useRef<number | null>(null);
  const isPreventive = puzzlePhaseFromThemes === 'preventive';
  const cancelBlunderTimers = useCallback(() => {
    if (blunderReplayTimerRef.current) {
      window.clearTimeout(blunderReplayTimerRef.current);
      blunderReplayTimerRef.current = null;
    }
    if (blunderRevertTimerRef.current) {
      window.clearTimeout(blunderRevertTimerRef.current);
      blunderRevertTimerRef.current = null;
    }
  }, []);
  const replayBlunder = useCallback(() => {
    if (!canAnimateBlunder || !fenBeforeBlunder) return;
    const uci = params.blunderMove;
    const moveOpts = {
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    };
    cancelBlunderTimers();

    if (isPreventive) {
      // KS-3370: превентив. Стартовая позиция = puzzle.fen (она же
      // fenBeforeBlunder). Применяем blunder через 400ms → пауза
      // 1500ms → откат на puzzle.fen.
      setGame(new Chess(puzzle.fen));
      lastMoveUciRef.current = null;
      blunderReplayTimerRef.current = window.setTimeout(() => {
        try {
          const after = new Chess(puzzle.fen);
          const mv = after.move(moveOpts);
          if (mv) {
            setGame(new Chess(after.fen()));
            lastMoveUciRef.current = uci;
            playSound(soundEventFromSan(mv.san));
            // Откат на стартовую через 1500ms — даём время разглядеть.
            blunderRevertTimerRef.current = window.setTimeout(() => {
              setGame(new Chess(puzzle.fen));
              lastMoveUciRef.current = null;
            }, 1500);
          }
        } catch {
          /* fallback: возвращаем стартовую без звука */
          setGame(new Chess(puzzle.fen));
        }
      }, 400);
      return;
    }

    // Реактивный (default): старт = fenBeforeBlunder; через 400ms →
    // puzzle.fen (анимация blunderMove). Финальная позиция puzzle.fen.
    setGame(new Chess(fenBeforeBlunder));
    lastMoveUciRef.current = null;
    blunderReplayTimerRef.current = window.setTimeout(() => {
      try {
        setGame(new Chess(puzzle.fen));
        lastMoveUciRef.current = uci;
        try {
          const probe = new Chess(fenBeforeBlunder);
          const mv = probe.move(moveOpts);
          if (mv) playSound(soundEventFromSan(mv.san));
        } catch {
          /* fallback: без звука */
        }
      } catch {
        setGame(new Chess(puzzle.fen));
      }
    }, 400);
  }, [
    canAnimateBlunder,
    fenBeforeBlunder,
    params.blunderMove,
    puzzle.fen,
    playSound,
    isPreventive,
    cancelBlunderTimers,
  ]);

  // KS-3365/3370: первый запуск анимации — ровно один раз на mount.
  // Компонент пересоздаётся через key={puzzle.id} в PuzzlePage при
  // смене пазла. Cleanup отменяет ОБА таймера (replay + revert), чтобы
  // unmount во время превентивной задержки 1500ms не оставлял setGame
  // на удалённом дереве.
  const blunderAnimatedRef = useRef(false);
  useEffect(() => {
    if (!canAnimateBlunder || blunderAnimatedRef.current) return;
    blunderAnimatedRef.current = true;
    replayBlunder();
    return () => cancelBlunderTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // один раз на mount

  // ── Engine init / cleanup ─────────────────────────────────────────────
  /**
   * KS-3170: `WasmEngineAdapter` теперь принимает колбэки `onProgress` /
   * `onError` и предзагружает lite-сборку (7 МБ) с прогрессом. Раннер
   * пробрасывает эти сигналы в локальное состояние, чтобы `<EngineLoader>`
   * мог отрисовать прогресс-плашку (loading) или ошибку с retry. Старая
   * single-сборка (113 МБ) и 15-секундный таймаут — отменены в адаптере.
   */
  const ensureEngine = useCallback((): Promise<EngineAdapter> => {
    if (engineRef.current) return Promise.resolve(engineRef.current);
    if (engineInitPromiseRef.current) return engineInitPromiseRef.current;
    setEngineLoadState('loading');
    setEngineLoadProgress(0);
    setEngineErrorReason(null);
    const promise = (async () => {
      const engine = engineFactory
        ? engineFactory()
        : new WasmEngineAdapter({
            onProgress: (loaded, total) => {
              if (total > 0) {
                setEngineLoadProgress(Math.min(0.99, loaded / total));
              }
            },
            onError: (reason: WasmEngineErrorReason) => {
              setEngineErrorReason(reason);
              setEngineLoadState('error');
            },
          });
      try {
        await engine.init();
      } catch (err) {
        // KS-3170: причина ошибки уже выставлена внутри onError; здесь
        // только страхуем случай, когда фабрика тестового движка кинула
        // без вызова onError (старые моки).
        if ((err as Error)?.name !== 'AbortError') {
          setEngineLoadState((prev) => (prev === 'loading' ? 'error' : prev));
        }
        engineInitPromiseRef.current = null;
        throw err;
      }
      engineRef.current = engine;
      setEngineLoadProgress(1);
      setEngineLoadState('ready');
      return engine;
    })();
    engineInitPromiseRef.current = promise;
    return promise;
  }, [engineFactory]);

  /**
   * KS-3170: «Попробовать снова» для `<EngineLoader>`. Сбрасывает init-
   * promise и движок, дёргает `ensureEngine` повторно. Если пользователь
   * жмёт retry до того как раннер успел инициировать ход — следующий
   * ensureEngine стартует с чистого листа.
   */
  const retryEngineInit = useCallback(() => {
    try { engineRef.current?.destroy(); } catch { /* ignore */ }
    engineRef.current = null;
    engineInitPromiseRef.current = null;
    setEngineErrorReason(null);
    setEngineLoadState('idle');
    setEngineLoadProgress(0);
    void ensureEngine().catch(() => undefined);
  }, [ensureEngine]);

  /**
   * KS-2473: сериализованный вызов analyze. Ставит запрос в очередь и
   * возвращает Promise<AnalysisResult>. Гарантирует, что в каждый
   * момент только один analyze в работе.
   */
  const queueAnalyze = useCallback(
    (
      fen: string,
      opts?: {
        multiPv?: number;
        /**
         * KS-3380: ограничить корневые ходы SF (UCI `go searchmoves`).
         * Используется для pre-frame WDL playedUci — pre-analyze
         * принимает multipv=1, snapshot.wdlAfter записывается из ОТДЕЛЬНОГО
         * extra-analyze с `searchmoves=[playedUci]`. Это даёт оценку
         * сыгранного хода в той же фрейме (та же глубина, тот же
         * search), что и bestUci — исключает расхождение pre/post
         * snapshots при WASM-ограничениях.
         */
        searchmoves?: ReadonlyArray<string>;
      },
    ): Promise<AnalysisResult> => {
      const next = engineQueueRef.current.then(async () => {
        const eng = await ensureEngine();
        // KS-2955: гарантируем нижнюю границу анализа ≥ 1 секунда. На
        // depth=12 SF18 WASM в насыщенных позициях даёт ложные WDL.
        return eng.analyze(
          fen,
          analyzeDepth,
          opts?.multiPv ?? 1,
          analyzeMovetimeMs,
          undefined, // nodes
          opts?.searchmoves,
        );
      });
      // Не пробрасываем ошибки в цепочку, чтобы один сбой не убил все
      // последующие analyze.
      engineQueueRef.current = next.catch(() => undefined);
      return next;
    },
    [ensureEngine, analyzeDepth, analyzeMovetimeMs],
  );

  /**
   * KS-3391: запустить «живой» анализ позиции игрока (`fen`). Стримит
   * промежуточные WDL в `setLatestWdl` (POV решателя) по мере роста
   * глубины SF. Идёт через ту же `engineQueueRef`, что и классификация —
   * один WASM-worker, без пересечения go-команд.
   *
   * Сам по себе live-анализ НЕ завершается (`go infinite`) — его
   * останавливает `stopLiveAnalysis()` (вызывается в начале хода игрока).
   */
  const startLiveAnalysis = useCallback(
    (fen: string) => {
      const gen = ++liveGenRef.current;
      const queued = engineQueueRef.current.then(async () => {
        // Отменён до старта (игрок успел сходить / сменился пазл) — выходим
        // без go infinite, очередь сразу свободна для классификации.
        if (gen !== liveGenRef.current) return;
        const eng = await ensureEngine();
        if (gen !== liveGenRef.current) return;
        liveInFlightRef.current = true;
        try {
          await eng.analyzeLive(fen, 1, (info) => {
            if (gen !== liveGenRef.current) return;
            if (!info.wdl) return;
            // На позиции игрока side-to-move = решатель → WDL движка
            // (POV side-to-move) уже POV решателя. Флипаем только если
            // вдруг side не совпал (страховка).
            const stm = sideFromFen(fen);
            const wdlSolver = stm === userSide ? info.wdl : flipWdl(info.wdl);
            setLatestWdl(wdlSolver);
          });
        } finally {
          liveInFlightRef.current = false;
        }
      });
      engineQueueRef.current = queued.catch(() => {
        liveInFlightRef.current = false;
      });
    },
    [ensureEngine, userSide],
  );

  /**
   * KS-3391: остановить live-анализ. Инкремент `liveGenRef` инвалидирует
   * stale onUpdate и pending-старт; `stop()` дёргаем только если live
   * реально в работе — иначе он мог бы оборвать классификационный analyze.
   */
  const stopLiveAnalysis = useCallback(() => {
    liveGenRef.current++;
    if (liveInFlightRef.current) {
      try {
        engineRef.current?.stop();
      } catch {
        /* ignore */
      }
    }
  }, []);

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

      // KS-3380 full: post-analyze БОЛЬШЕ НЕ пишет в snapshot.cpAfter/
      // wdlAfter — pre+extra уже сделали это в одной фрейме на
      // fenBefore. Здесь только обновляем `depth` (макс между pre и
      // post) для UI и dropвход engineUci ниже после bestmove.
      updateUserBestLog((prev) =>
        prev.map((s) =>
          s.halfMove === halfAfterUser
            ? { ...s, depth: Math.max(s.depth ?? 0, best.depth) }
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
          // KS-3248: для saveEquality промежуточный fail-check
          // отключаем — финал решает meetsFinalObjective ниже, чтобы
          // вся серия успела отыграться (см. /tmp/telegram/326129994_0.jpg).
          objective ?? null,
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
        // KS-2968: даже если effWdlUser >= winThreshold (формально в
        // выигрышной зоне), сравниваем итоговый WDL с baseline. Если
        // win% упал сильнее порога — это потеря преимущества, плашка
        // должна быть «потеряно». Baseline — клиентский SF (KS-2960)
        // с fallback'ом на серверный wdlAfter.
        //
        // KS-3169: drop-check применим только к convertAdvantage —
        // для saveEquality стартовый baseline уже близок к ничье и
        // любая ничья выпадала бы в lose. Финальный вердикт
        // считается через `meetsFinalObjective`, учитывающую objective.
        const baseline =
          clientBaselineWdlRef.current ?? puzzle.playVsEngine?.wdlAfter ?? null;
        const dropTooHigh =
          objective === 'saveEquality'
            ? false
            : isWinDropExcessive(baseline, wdlUserObj);
        if (
          meetsFinalObjective(
            wdlUserObj,
            effWdlUser,
            objective ?? null,
            params.winThreshold,
          ) &&
          !dropTooHigh
        ) {
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
          // KS-2968: дополнительный критерий — drop по win относительно
          // baseline. При формальном плюсе (>= winThreshold) но падении
          // win% > 15 п.п. ставим «потеряно».
          // KS-3169: drop-check отключаем для saveEquality (baseline
          // близок к ничье → любое удержание выпадало бы как «потеря
          // win%»). Финальный успех решается через `meetsFinalObjective`.
          const baselineFinal =
            clientBaselineWdlRef.current ?? puzzle.playVsEngine?.wdlAfter ?? null;
          const dropTooHighFinal =
            objective === 'saveEquality'
              ? false
              : isWinDropExcessive(baselineFinal, finalWdlObj);
          if (
            meetsFinalObjective(
              finalWdlObj,
              effWdlFinal,
              objective ?? null,
              params.winThreshold,
            ) &&
            !dropTooHighFinal
          ) {
            finishWin('win', effWdlFinal, halfAfterEngine);
          } else {
            finishLose('lose-wdl', effWdlFinal, halfAfterEngine);
          }
        } catch {
          // Если final analyze упал — судим по последнему effWdlUser
          // и последнему wdlUserObj (после user-хода, до engine-ответа).
          // KS-2968: тот же drop-check. KS-3169: см. main-ветку выше.
          const baselineFallback =
            clientBaselineWdlRef.current ?? puzzle.playVsEngine?.wdlAfter ?? null;
          const dropTooHighFallback =
            objective === 'saveEquality'
              ? false
              : isWinDropExcessive(baselineFallback, wdlUserObj);
          if (
            meetsFinalObjective(
              wdlUserObj,
              effWdlUser,
              objective ?? null,
              params.winThreshold,
            ) &&
            !dropTooHighFallback
          ) {
            finishWin('win', effWdlUser, halfAfterEngine);
          } else {
            finishLose('lose-wdl', effWdlUser, halfAfterEngine);
          }
        }
        return;
      }

      // 5) Возвращаем ход пользователю.
      setState('thinking');
      // KS-3391: запускаем live-анализ новой позиции игрока — полоса
      // шансов снова уточняется в реальном времени, пока он думает.
      startLiveAnalysis(next.fen());
    },
    [
      ensureEngine,
      queueAnalyze,
      startLiveAnalysis,
      params.failThreshold,
      params.winThreshold,
      params.halfMovesN,
      finishLose,
      finishWin,
      playSound,
      updateUserBestLog,
      // KS-2968: серверный wdlAfter — fallback baseline для drop-check.
      puzzle.playVsEngine?.wdlAfter,
      // KS-3169: жанр задачи влияет на финальный win/lose-вердикт
      // (meetsFinalObjective) и на применение drop-check'а.
      objective,
    ],
  );

  // ── User move handler ────────────────────────────────────────────────

  /**
   * KS-2969: применить ход пользователя. promotion-параметр — выбор юзера
   * из `PromotionPicker` (Q/R/B/N). Для не-promotion ходов параметр
   * игнорируется (chess.js его не использует). До KS-2969 здесь был
   * жёсткий `promotion: 'q'` (авто-ферзь, ADR §5.6) — теперь это
   * default для случаев когда вызывающий не знал о promotion (например,
   * программный вызов из тестов).
   */
  const applyUserMove = useCallback(
    (sourceSquare: string, targetSquare: string, promotion: PromotionPiece = 'q'): boolean => {
      if (state !== 'thinking') return false;
      const next = new Chess(game.fen());
      let move: ReturnType<Chess['move']> | null = null;
      try {
        move = next.move({ from: sourceSquare, to: targetSquare, promotion });
      } catch {
        move = null;
      }
      if (!move) return false;
      // KS-3391: игрок сходил — останавливаем live-анализ его прежней
      // позиции, освобождаем очередь движка для pre/post-analyze
      // (классификация). Без этого `go infinite` держал бы worker и
      // классификационный analyze не запустился бы (deadlock).
      stopLiveAnalysis();
      playSound(soundEventFromSan(move.san));
      // KS-2969: UCI промоушна обязан содержать суффикс фигуры
      // (b7b8q, не b7b8). chess.js заполняет move.promotion только
      // когда ход реально является превращением пешки.
      const playedUci = sourceSquare + targetSquare + (move.promotion ?? '');
      lastMoveUciRef.current = playedUci;
      const fenBefore = game.fen();
      setGame(next);
      // KS-2486 reopen: пишем SAN в общий лог, чтобы потом собрать
      // PGN партии для Workshop-ссылки.
      setPlayedSans((prev) => [...prev, move!.san]);
      const halfAfterUser = halfMovesPlayed + 1;
      setHalfMovesPlayed(halfAfterUser);

      // KS-3380 full: один последовательный async-pipeline:
      //   pre-analyze (PV1=bestUci, wdlBefore) →
      //   extra-analyze (searchmoves=[playedUci], wdlAfter) если !isBest →
      //   запись snapshot →
      //   runEngineCycle / inline-final (post-analyze).
      // Гарантирует что post-analyze идёт ПОСЛЕ snapshot записи,
      // submitOnce читает свежий userBestLogRef. Все analyze идут через
      // queueAnalyze — последовательно через engineQueueRef, без race.
      //
      // Зачем: раньше pre-analyze и runEngineCycle стартовали как
      // независимые void async. extra (если бы добавилось внутри
      // pre-async) вставала в очередь ПОСЛЕ runEngineCycle's post →
      // submitOnce читал snapshot до patch'а.
      void (async () => {
        try {
          await ensureEngine();
          const pre = await queueAnalyze(fenBefore);
          const preBest = pickBestLine(pre);

          // Если pre упал — snapshot не создаём (legacy fallback-effect
          // на win/lose попробует ещё раз).
          if (preBest && preBest.pv[0]) {
            const cpBefore = cpFromScore(preBest.score);
            const wdlBefore = preBest.wdl ?? null;
            const bestUci = preBest.pv[0];
            const isBest = playedUci === bestUci;

            let cpAfter: number | null = null;
            let wdlAfter: typeof wdlBefore = null;
            let depthAfter: number | null = preBest.depth;

            if (isBest) {
              // Один и тот же ход — оценки в одной фрейме тождественно
              // равны. Никакого extra-analyze не нужно. lossE=0 → best.
              cpAfter = cpBefore;
              wdlAfter = wdlBefore;
            } else {
              // KS-3380: extra-analyze playedUci на той же fenBefore.
              // SF с searchmoves=[playedUci] вернёт PV1 этого хода →
              // wdl/cp POV user (на fenBefore ходит user) в той же
              // фрейме, что и pre.
              try {
                const extra = await queueAnalyze(fenBefore, {
                  multiPv: 1,
                  searchmoves: [playedUci],
                });
                const extraBest = pickBestLine(extra);
                if (extraBest) {
                  cpAfter = cpFromScore(extraBest.score);
                  wdlAfter = extraBest.wdl ?? null;
                  depthAfter = Math.max(depthAfter ?? 0, extraBest.depth);
                }
              } catch {
                /* extra упал — cpAfter/wdlAfter останутся null,
                   downstream грейсфолит / fallback-effect повторит. */
              }
            }

            updateUserBestLog((prev) => [
              ...prev,
              {
                halfMove: halfAfterUser,
                fenBefore,
                playedUci,
                bestUci,
                cpBefore,
                cpAfter,
                wdlBefore,
                wdlAfter,
                depth: depthAfter,
                engineUci: null,
              },
            ]);
          }

          // ── Post-фаза: engine reply или inline-final ───────────────
          if (halfAfterUser >= params.halfMovesN) {
            // Inline-final-branch (последний user-полуход партии,
            // engine не отвечает). KS-3380: post-analyze здесь НЕ
            // пишет в snapshot — pre+extra уже всё сделали. Этот
            // analyze нужен только для UI (evalBar) и verdict.
            setState('evaluating');
            const result = await queueAnalyze(next.fen());
            const best = pickBestLine(result);
            setEvalLines(toEvalLines(result));
            setEvalSide(sideFromFen(next.fen()));
            if (next.isCheckmate()) {
              finishWin('win-mate', 1, halfAfterUser);
              return;
            }
            const wdlUser = best ? -scoreToWdlSigned(best.score) : 0;
            setLatestWdlUser(wdlUser);
            const wdlUserObj = best?.wdl ? flipWdl(best.wdl) : null;
            setLatestWdl(wdlUserObj);
            const effWdlUser = effectiveSignedWdl(wdlUserObj, wdlUser);
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
                objective ?? null,
              )
            ) {
              finishLose('lose-wdl', effWdlUser, halfAfterUser);
              return;
            }
            if (best && best.score.type === 'mate' && best.score.value < 0) {
              finishWin('win-engine-resign', effWdlUser, halfAfterUser);
              return;
            }
            const baselineLastUser =
              clientBaselineWdlRef.current ??
              puzzle.playVsEngine?.wdlAfter ??
              null;
            const dropTooHighLastUser =
              objective === 'saveEquality'
                ? false
                : isWinDropExcessive(baselineLastUser, wdlUserObj);
            if (
              meetsFinalObjective(
                wdlUserObj,
                effWdlUser,
                objective ?? null,
                params.winThreshold,
              ) &&
              !dropTooHighLastUser
            )
              finishWin('win', effWdlUser, halfAfterUser);
            else finishLose('lose-wdl', effWdlUser, halfAfterUser);
            return;
          }

          // KS-3380: post-analyze + engine reply через runEngineCycle.
          // Гарантировано идёт ПОСЛЕ snapshot записи — finishWin/Lose
          // внутри runEngineCycle прочитает свежий userBestLogRef.
          await runEngineCycle(next, halfAfterUser);
        } catch (e) {
          setErrorMsg(e instanceof Error ? e.message : 'engine-error');
          setState('error');
        }
      })();
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
      stopLiveAnalysis,
      finishLose,
      finishWin,
      updateUserBestLog,
      // KS-2968: серверный wdlAfter — fallback baseline для drop-check
      // в финальной точке решения внутри last-user-move ветки.
      puzzle.playVsEngine?.wdlAfter,
      // KS-3169: жанр задачи участвует в финальном вердикте
      // (meetsFinalObjective) и отключает drop-check для saveEquality.
      objective,
    ],
  );

  /**
   * KS-2969: определяет, является ли ход превращением пешки.
   * Pawn идёт на 8-й (белые) или 1-й (чёрные) ряд.
   */
  const isPromotionMove = useCallback(
    (sourceSquare: string, targetSquare: string): boolean => {
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
   * KS-2969: обработчик drop/click из PuzzleBoard. Если ход — promotion,
   * сохраняем pending и показываем `<PromotionPicker>`; иначе сразу
   * применяем ход через `applyUserMove`. Возвращаем `true` для promotion,
   * чтобы react-chessboard не «отскочил» (фигура всё равно вернётся в
   * исходное положение при следующем рендере, потому что `game` не
   * изменился).
   */
  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (state !== 'thinking') return false;
      if (isPromotionMove(sourceSquare, targetSquare)) {
        // Проверим легальность хода ферзём — если ход вообще запрещён
        // (пешка под связкой, фигура мешает и т.п.), модалку не открываем.
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
      return applyUserMove(sourceSquare, targetSquare);
    },
    [state, game, isPromotionMove, applyUserMove],
  );

  const handlePromotionChoice = useCallback(
    (piece: PromotionPiece) => {
      if (!pendingPromotion) return;
      const { from, to } = pendingPromotion;
      setPendingPromotion(null);
      applyUserMove(from, to, piece);
    },
    [pendingPromotion, applyUserMove],
  );

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

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
    // KS-2960: baseline тоже сбрасываем — заполнится в initial pre-analyze
    // ниже. До этого момента fallback идёт на серверный
    // `puzzle.playVsEngine.wdlAfter` / `wdlAfterBlunder`.
    updateClientBaselineWdl(null);
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
    // KS-2969: закрыть модалку выбора promotion при переключении пазла.
    setPendingPromotion(null);
  }, [puzzle.id, puzzle.fen, params.wdlAfterBlunder, updateClientBaselineWdl]);

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
        // KS-2960: фиксируем клиентский baseline POV-решателя из
        // локального SF (тот же движок, что будет играть). Используется
        // как `start` в финальном summary и как initial для
        // `latestWdlUser`. Без этого UI показывал «удержано/потеряно»
        // от серверного `puzzle.playVsEngine.wdlAfter`, который может
        // не совпадать с реальной оценкой движка на этой глубине.
        if (initialBest?.wdl) {
          updateClientBaselineWdl(initialBest.wdl);
          // signedWdl POV решателя (= user, на puzzle.fen ходит он).
          setLatestWdlUser(signedWdlFromObj(initialBest.wdl));
        }
        // KS-3391: после дискретного baseline-анализа (он фиксирует
        // clientBaselineWdl) запускаем «живой» continuous-анализ стартовой
        // позиции — полоса шансов уточняется в реальном времени, пока игрок
        // думает над первым ходом.
        if (!cancelled) startLiveAnalysis(puzzle.fen);
      } catch {
        /* ignore — полоса не критична, юзер сделает ход и анализ
           перезапустится в runEngineCycle. */
      }
    })();
    return () => {
      cancelled = true;
      // KS-3391: смена пазла / размонтирование — гасим live-анализ.
      stopLiveAnalysis();
    };
  }, [
    puzzle.id,
    puzzle.fen,
    ensureEngine,
    queueAnalyze,
    updateClientBaselineWdl,
    startLiveAnalysis,
    stopLiveAnalysis,
  ]);

  // ── KS-2508 → KS-3380 full fallback-analyze ─────────────────────────
  // KS-3380: fallback переписан под новую семантику. Старая логика
  // считала cpAfter из позиции ПОСЛЕ playedUci (с flipWdl POV user),
  // теперь оба значения должны быть в pre-frame.
  // Сценарий запуска фоллбека:
  //   1. pre-analyze в applyUserMove отработал, snapshot создан.
  //   2. extra-analyze упал (`cpAfter`/`wdlAfter` остались null).
  // После завершения партии (state win|lose) пробегаем по snapshot'ам
  // с `cpAfter===null` и заново делаем extra-analyze на их fenBefore.
  // Best-case (playedUci===bestUci) — копируем cpBefore/wdlBefore без
  // SF-вызова.
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
        if (s.bestUci && s.playedUci === s.bestUci && s.cpBefore != null) {
          updateUserBestLog((prev) =>
            prev.map((x) =>
              x.halfMove === s.halfMove
                ? { ...x, cpAfter: x.cpBefore, wdlAfter: x.wdlBefore }
                : x,
            ),
          );
          continue;
        }
        try {
          const r = await queueAnalyze(s.fenBefore, {
            multiPv: 1,
            searchmoves: [s.playedUci],
          });
          if (cancelled) return;
          const b = pickBestLine(r);
          if (!b) continue;
          // KS-3380: на fenBefore ходит user → score POV user без
          // инверсии (searchmoves даёт нужный PV1).
          const cpAfter = cpFromScore(b.score);
          const wdlAfter = b.wdl ?? null;
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

  // KS-3018: считаем 5-балльную оценку (ADR-065 §3) локально из
  // `userBestLog` — те же поля cpBefore/cpAfter/wdlBefore/wdlAfter, что
  // отправляются на backend в `submitAttempt`. На финальном экране это
  // даёт мгновенный результат, без round-trip к backend. Backend всё
  // равно пересчитает свой `score` для persistence (источник истины).
  const precisionScore = useMemo(() => {
    if (state !== 'win' && state !== 'lose') {
      return { stars: null as 1 | 2 | 3 | 4 | 5 | null, scorePct: null as number | null };
    }
    return computePrecisionScore(buildPrecisionScoreInputs(userBestLog));
  }, [state, userBestLog]);

  // KS-3146 (ADR-069 §3.2): дифференцируем тексты «You held / lost the
  // advantage» по жанру пазла. convertAdvantage — «реализуй перевес»,
  // saveEquality — «спасение в ничью». Mate-варианты от жанра не зависят
  // (мат всегда мат). Если objective undefined (legacy-пазлы до KS-3144)
  // — fallback на исторические тексты.
  //
  // KS-3169: `objective` поднята на уровень компонента (объявлена выше
  // вместе с `userSide`), чтобы тот же признак использовался в финальном
  // win/lose-вердикте `meetsFinalObjective`.
  const reasonLabel = (r: PlayVsEnginePuzzleReason | null): string => {
    switch (r) {
      case 'win':
        if (objective === 'saveEquality') {
          return t('puzzle.engine.winSave', 'You held the draw');
        }
        if (objective === 'convertAdvantage') {
          return t('puzzle.engine.winConvert', 'You converted the advantage');
        }
        return t('puzzle.engine.win', 'You held the advantage');
      case 'win-mate':
        return t('puzzle.engine.winMate', 'Checkmate!');
      case 'win-engine-resign':
        return t('puzzle.engine.winResign', 'Engine resigned (sees mate)');
      case 'lose-wdl':
        if (objective === 'saveEquality') {
          return t('puzzle.engine.loseWdlSave', 'You let the draw slip');
        }
        if (objective === 'convertAdvantage') {
          return t('puzzle.engine.loseWdlConvert', 'You lost the advantage');
        }
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

  // KS-2471 → KS-3035: blunder в SAN.
  // Backend для generated-пазлов отдаёт `playVsEngine.fenBeforeBlunder`
  // (KS-2754), но в shared-типе `PuzzleDto.playVsEngine` поле пока не
  // KS-3355: ранее тут вычислялся `blunderSan` для SAN-нотации в плашке
  // hint'а («29... Rf6»). После замены SAN на красную стрелку
  // (customArrows ниже) переменная больше не нужна. Helper-функции
  // `blunderUciToSan` / `formatBlunderMoveWithNumber` оставлены как
  // экспорты (используются в тестах).

  // KS-3162 / KS-3164: фаза пазла читается из тега в `puzzle.themes`
  // KS-3370: `puzzlePhaseFromThemes` поднята в начало компонента
  // (рядом с `params`/`userSide`) — нужна для `replayBlunder`-ветвления.

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
        <div className="puzzle-engine-runner__board-col">
          {/* KS-3391: трёхцветная полоса шансов W/D/L вместо EvalBar.
              `latestWdl` уже приведён к POV решателя (flipWdl на
              post-analyze FEN'е), поэтому сегмент «победа» = победа того,
              кто решает — корректно и для preventive-задач за чёрных.
              Перерисовывается в реальном времени по мере анализа. */}
          <WdlChancesBar wdl={latestWdl} testId="puzzle-engine-wdl-chances" />
          {/* KS-3170 (регрессия KS-3067): UI прогресса/ошибки загрузки
              движка. Рендерится поверх board-col при loading/error и
              автоматически исчезает при ready. До этого тикета на
              /precision не было индикатора, и пользователь Realme на
              4G видел немой спиннер до 30-секундного таймаута. EngineLoader
              сам решает рендерить ли себя (null при !loading/!error). */}
          <EngineLoader
            state={
              engineLoadState === 'loading'
                ? 'loading'
                : engineLoadState === 'error'
                ? 'error'
                : 'ready'
            }
            loadProgress={engineLoadProgress}
            errorReason={engineErrorReason}
            onRetry={retryEngineInit}
            variant="inline"
            className="puzzle-engine-runner__engine-loader"
          />

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

          {/* KS-3369: плашка hint'а убрана — её роль закрывает кнопка
              «Проиграть последний ход» (KS-3366), которая визуально
              сообщает «соперник сходил, можно пересмотреть». На старте
              рендерим только саму кнопку без текстовой плашки.
              `puzzlePhase` тег keep'аем в data-attr на самой кнопке —
              интеграционные тесты через `data-puzzle-phase` продолжают
              работать без отдельного hint-узла. */}
          {state === 'thinking' && halfMovesPlayed === 0 && canAnimateBlunder && (
            <div
              className="puzzle-engine-runner__hint-row"
              data-testid="puzzle-engine-hint-row"
            >
              <button
                type="button"
                className="puzzle-engine-runner__replay-btn"
                data-testid="puzzle-engine-replay-blunder"
                data-blunder-known="true"
                data-puzzle-phase={puzzlePhaseFromThemes ?? ''}
                onClick={replayBlunder}
                aria-label={t(
                  'puzzle.engine.replayLastMove',
                  'Replay last move',
                )}
                title={t(
                  'puzzle.engine.replayLastMove',
                  'Replay last move',
                )}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  {/* refresh-ccw icon */}
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                <span>
                  {t('puzzle.engine.replayLastMove', 'Replay last move')}
                </span>
              </button>
            </div>
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
            // KS-3365: красная стрелка blunderMove убрана. Вместо неё
            // на mount анимируется сам ход соперника (см. useEffect
            // выше с timer 400ms) — UX лучше, видно ОТКУДА фигура.
          >
            {/* KS-2969: модалка выбора фигуры при превращении пешки.
                Цвет — по ряду промоушна (8 → белые, 1 → чёрные). */}
            <PromotionPicker
              pending={pendingPromotion}
              color={pendingPromotion?.to[1] === '8' ? 'w' : 'b'}
              onChoice={handlePromotionChoice}
              onCancel={handlePromotionCancel}
              testId="puzzle-promotion-overlay"
            />
          </PuzzleBoard>

          {/* KS-3369 (ADR-079 §3.4 update). Кнопки «Назад»/«Следующая»
              сразу под доской (compact-variant). До KS-3369 они жили
              внутри result-блока ПОСЛЕ wdl-summary и PostGameReview —
              пользователь жаловался, что приходится много скроллить.
              Visible только после win/lose. */}
          {(state === 'win' || state === 'lose') && (onBack || onNext) && (
            <div
              className="precision-result-actions precision-result-actions--compact"
              data-testid="precision-result-actions"
            >
              {onBack && (
                <button
                  type="button"
                  className="play-btn play-btn--secondary play-btn--compact"
                  onClick={onBack}
                  data-testid="puzzle-engine-back"
                >
                  {t('precision.results.back', '← Back')}
                </button>
              )}
              {onNext && (
                <button
                  type="button"
                  className="play-btn play-btn--compact"
                  onClick={onNext}
                  data-testid="puzzle-engine-next"
                >
                  {t('precision.results.next', 'Next →')}
                </button>
              )}
            </div>
          )}

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
              {/* KS-3146 (ADR-069 §3.2): жанровая «шапка» summary —
                  Badge с иконкой («Реализуй перевес» / «Спасение в
                  ничью»). Рендерится только при наличии `objective` у
                  пазла (legacy-пазлы остаются без бейджа). */}
              {objective && (
                <div
                  className="puzzle-engine-runner__objective-row"
                  data-testid="puzzle-engine-objective-row"
                >
                  <PuzzleObjectiveBadge
                    objective={objective}
                    testId="puzzle-engine-objective-badge"
                  />
                </div>
              )}
              {/* KS-3018 (ADR-065 §5.1.1): 5-балльная оценка вместо бинарной
                  плашки «You held / lost the advantage». Старый result-label
                  оставлен mate/resign-каёмкой ниже — это игровая концовка,
                  не «итог попытки» (её показывает PrecisionScoreBlock). */}
              {/* KS-3248: передаём `objective` (жанр пазла) и
                  `objectiveAchieved` — для верных текста плашки и
                  подзаголовка по матрице 5×2. Используем `state`-флаги:
                  `complete` ('win') означает achieved=true,
                  `failed` ('lose') → false. */}
              <PrecisionScoreBlock
                score={precisionScore.stars}
                scorePct={precisionScore.scorePct}
                objective={objective ?? null}
                objectiveAchieved={
                  state === 'complete'
                    ? true
                    : state === 'failed'
                      ? false
                      : null
                }
              />
              {(reason === 'win-mate' ||
                reason === 'win-engine-resign' ||
                reason === 'lose-mate') && (
                <div
                  className={`puzzle-engine-runner__result-endnote puzzle-engine-runner__result-endnote--${state}`}
                  data-testid="puzzle-engine-result-endnote"
                >
                  {reasonLabel(reason)}
                </div>
              )}
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
                // KS-2960: предпочитаем клиентский baseline (тот же
                // движок, что играет) — серверный wdlAfter оставлен
                // как fallback на случай если initial pre-analyze упал
                // / движок не отдаёт WDL.
                const wdlAfter = clientBaselineWdl ?? puzzle.playVsEngine?.wdlAfter;
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
              {/* KS-3349 (ADR-079 §3.5). Дельта precision-рейтинга после
                  попытки. Для гостей `precisionRatingChange` всегда null →
                  блок не рендерится. */}
              {precisionRatingChange && (
                <div
                  className={`precision-rating-change precision-rating-change--${
                    precisionRatingChange.ratingDelta >= 0 ? 'gain' : 'loss'
                  }`}
                  data-testid="precision-rating-change"
                  data-rating-before={String(precisionRatingChange.ratingBefore)}
                  data-rating-after={String(precisionRatingChange.ratingAfter)}
                  data-rating-delta={String(precisionRatingChange.ratingDelta)}
                >
                  <span data-testid="precision-rating-change-text">
                    {precisionRatingChange.ratingBefore} →{' '}
                    {precisionRatingChange.ratingAfter} (
                    {precisionRatingChange.ratingDelta >= 0 ? '+' : ''}
                    {precisionRatingChange.ratingDelta})
                  </span>
                </div>
              )}
              {/* KS-3369: Back/Next переехали под доску — выше по дереву.
                  Здесь оставляем пустой комментарий-якорь, чтобы
                  follow-up задачи могли быстро найти место по grep. */}
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
