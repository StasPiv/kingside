/**
 * KS-2161 (B8). Гибрид-pipeline выбора хода для synthetic-партии.
 *
 * Этап 1 (плай 1–20) — opening book / TWIC:
 *   Пытаемся найти ход в opening book или (при наличии archive-service
 *   API) в TWIC по eco-prefix + ELO-окну. Если нет совпадения → этап 2.
 *
 * Этап 2 (миттельшпиль / эндшпиль) — Stockfish:
 *   `setoption UCI_LimitStrength true`, `UCI_Elo <rating>`, `MultiPV 6`,
 *   `go depth N`. Парсим info-строки → MultipvLine[] → multipv-noise +
 *   blunder + sanity → выбранный uci.
 *
 * Все «детали поведения» (multipv-выбор, blunder, sanity, тайминги) —
 * в `synthetic-move-engine.helpers.ts` (pure-функции). Этот сервис —
 * композиция: получает позицию + параметры синтета, возвращает
 * `{ uci, thinkMs, source }`. Реальный stdout-парсинг info-строк
 * Stockfish тоже здесь — выделено в pure-helpers `parseInfoLines`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Chess } from 'chess.js';
import type { TimeControlCategory } from '@kingside/shared';
import {
  computeThinkMs,
  decideBlunder,
  eligibleMultipvCandidates,
  pickSubOptimalOrBlunder,
  pickWithMultipvNoise,
  phaseFromPly,
  sanityCheckMateInTwoOrThree,
  type MultipvLine,
} from './synthetic-move-engine.helpers';
import type { StockfishPoolService } from './stockfish-pool.service';

export interface ComputeMoveInput {
  /** UUID партии — для лога. */
  gameId: string;
  /** FEN перед нашим ходом. */
  fen: string;
  /** Текущий plyCount (1..). */
  plyCount: number;
  /** Категория time control'а — для тайминга. */
  category: TimeControlCategory;
  /** Целевой рейтинг synthetic'а в этой категории. */
  rating: number;
  /** Опционально: ECO-префикс для poll'а opening book / TWIC. */
  ecoPrefix?: string;
}

export interface ComputeMoveOutput {
  /** UCI хода (`e2e4`, `g1f3`, ...). */
  uci: string;
  /** Сколько мс синтет «думает» перед отправкой хода. */
  thinkMs: number;
  /** Откуда выбран ход — для логов и метрик. */
  source: 'opening-book' | 'stockfish' | 'random-fallback';
  /** Пометки шума для аудита. */
  notes?: { noiseIndex?: 0 | 1 | 2; blunder?: 'sub-optimal' | 'blunder' };
}

/**
 * Узкий контракт opening-book / TWIC интеграции. По умолчанию заглушка
 * возвращает null — engine фолбэчит на Stockfish.
 *
 * Реальную имплементацию (запрос к archive-service /games?fen=...)
 * подцепим отдельной правкой; здесь оставляю интерфейс с подменяемым
 * провайдером, чтобы pipeline уже работал.
 */
export interface OpeningBookProvider {
  pickMove(opts: {
    fen: string;
    plyCount: number;
    rating: number;
    ecoPrefix?: string;
  }): Promise<string | null>;
}

@Injectable()
export class SyntheticMoveEngineService {
  private readonly logger = new Logger(SyntheticMoveEngineService.name);
  private openingBook: OpeningBookProvider | null = null;

  constructor(private readonly pool: StockfishPoolService) {}

  setOpeningBookProvider(p: OpeningBookProvider | null): void {
    this.openingBook = p;
  }

  /**
   * Главная точка входа: на вход — позиция + рейтинг синтета, на выход —
   * выбранный uci и сколько «думать». Stockfish-pool используется
   * под капотом.
   */
  async computeMove(input: ComputeMoveInput): Promise<ComputeMoveOutput> {
    const phase = phaseFromPly(input.plyCount);

    // Этап 1: opening book для дебюта.
    if (phase === 'opening' && this.openingBook) {
      try {
        const bookUci = await this.openingBook.pickMove({
          fen: input.fen,
          plyCount: input.plyCount,
          rating: input.rating,
          ecoPrefix: input.ecoPrefix,
        });
        if (bookUci && this.isLegal(input.fen, bookUci)) {
          const thinkMs = computeThinkMs({
            category: input.category,
            phase: 'opening',
            evalDiffCp: 0,
          });
          return {
            uci: bookUci,
            thinkMs,
            source: 'opening-book',
          };
        }
      } catch (err) {
        this.logger.warn(
          `opening book failed for ${input.gameId}: ${(err as Error).message}`,
        );
      }
    }

    // Этап 2: Stockfish multipv.
    try {
      const result = await this.pool.submit({
        id: `${input.gameId}:${input.plyCount}`,
        setOptions: [
          'setoption name UCI_LimitStrength value true',
          `setoption name UCI_Elo value ${clampUciElo(input.rating)}`,
          'setoption name MultiPV value 6',
        ],
        position: `position fen ${input.fen}`,
        // Глубина выбирается под категорию — bullet поверхностный, classical глубокий.
        go: `go depth ${depthForCategory(input.category)}`,
      });
      const lines = parseInfoLines(result.infoLines);
      const decision = this.selectFromMultipv(lines, input.rating);
      const evalDiffCp = computeEvalDiff(lines);
      const thinkMs = computeThinkMs({
        category: input.category,
        phase,
        evalDiffCp,
      });
      return {
        uci: decision.uci,
        thinkMs,
        source: 'stockfish',
        notes: decision.notes,
      };
    } catch (err) {
      this.logger.warn(
        `stockfish failed for ${input.gameId}: ${(err as Error).message} — fallback random`,
      );
      const uci = randomLegalMove(input.fen);
      return {
        uci: uci ?? '',
        thinkMs: 200,
        source: 'random-fallback',
      };
    }
  }

  /**
   * Композиция multipv-noise + blunder + sanity. Pure (без pool).
   * Экспонируется отдельно для тестов.
   */
  selectFromMultipv(
    lines: MultipvLine[],
    rating: number,
    rng: () => number = Math.random,
  ): { uci: string; notes?: { noiseIndex?: 0 | 1 | 2; blunder?: 'sub-optimal' | 'blunder' } } {
    const eligible = eligibleMultipvCandidates(lines);
    if (eligible.length === 0) {
      // Stockfish не вернул ни одной info-линии — невозможный сценарий
      // на нормальном depth, но защищаемся. Берём первую line или fallback.
      const fallback = [...lines].sort((a, b) => a.rank - b.rank)[0];
      if (!fallback) throw new Error('selectFromMultipv: no lines');
      return { uci: fallback.uci };
    }

    // Blunder-инжектор для < 1000 рейтинга.
    const blunder = decideBlunder(rating, rng);
    if (blunder !== 'normal') {
      const picked = pickSubOptimalOrBlunder(lines, rng);
      if (picked) {
        // Sanity: чтобы не пропустить мат в 2-3.
        const sanity = sanityCheckMateInTwoOrThree({
          candidate: picked,
          best: eligible[0],
          mateForOpponentAfterCandidate: picked.mateIn !== null && picked.mateIn < 0
            ? -picked.mateIn
            : null,
        });
        return {
          uci: sanity.uci,
          notes: {
            blunder,
            noiseIndex: 0,
          },
        };
      }
    }

    const { line, noiseIndex } = pickWithMultipvNoise(eligible, rating, rng);
    const sanity = sanityCheckMateInTwoOrThree({
      candidate: line,
      best: eligible[0],
      mateForOpponentAfterCandidate: line.mateIn !== null && line.mateIn < 0
        ? -line.mateIn
        : null,
    });
    return {
      uci: sanity.uci,
      notes: noiseIndex > 0 ? { noiseIndex } : undefined,
    };
  }

  private isLegal(fen: string, uci: string): boolean {
    try {
      const chess = new Chess(fen);
      const moves = chess.moves({ verbose: true });
      return moves.some(
        (m) => m.from + m.to + (m.promotion ?? '') === uci,
      );
    } catch {
      return false;
    }
  }
}

/**
 * UCI_Elo минимум обычно 1320. Clamp вверх и вниз — Stockfish
 * сильнее 2850 не «играет» через эту опцию (ниже 1320 — также).
 * Для рейтингов <1000 шум добавит блантер-инжектор.
 */
export function clampUciElo(rating: number): number {
  return Math.max(1320, Math.min(2850, rating));
}

export function depthForCategory(category: TimeControlCategory): number {
  switch (category) {
    case 'bullet':
      return 8;
    case 'blitz':
      return 12;
    case 'rapid':
      return 16;
    case 'classical':
      return 20;
  }
}

/**
 * Парсит UCI info-строки одного `go ...` в массив MultipvLine.
 * Из последней info-строки на каждый multipv rank достаём score и pv.
 */
export function parseInfoLines(lines: readonly string[]): MultipvLine[] {
  const byRank = new Map<number, MultipvLine>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('info ')) continue;
    const tokens = line.split(/\s+/);

    let multipv = 1;
    let scoreCp: number | null = null;
    let mateIn: number | null = null;
    let pv: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === 'multipv') multipv = parseInt(tokens[++i] ?? '1', 10) || 1;
      else if (t === 'score') {
        const kind = tokens[++i];
        const value = parseInt(tokens[++i] ?? '0', 10);
        if (kind === 'cp') scoreCp = value;
        else if (kind === 'mate') mateIn = value;
      } else if (t === 'pv') {
        pv = tokens.slice(i + 1);
        break;
      }
    }

    const uci = pv[0];
    if (!uci) continue;

    // Stockfish с MultiPV отдаёт обновления по каждому rank на каждой
    // глубине — мы перезаписываем, в итоге останется последнее (=
    // самое глубокое) значение для каждого ранга.
    byRank.set(multipv, { rank: multipv, uci, scoreCp, mateIn });
  }
  return [...byRank.values()].sort((a, b) => a.rank - b.rank);
}

export function computeEvalDiff(lines: MultipvLine[]): number {
  if (lines.length < 2) return 0;
  const a = lines[0].scoreCp;
  const b = lines[1].scoreCp;
  if (a === null || b === null) return 0;
  return Math.abs(a - b);
}

/** Используется при fallback'е, когда Stockfish-pool отказал. */
export function randomLegalMove(fen: string): string | null {
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ verbose: true });
    if (moves.length === 0) return null;
    const m = moves[Math.floor(Math.random() * moves.length)];
    return m.from + m.to + (m.promotion ?? '');
  } catch {
    return null;
  }
}
