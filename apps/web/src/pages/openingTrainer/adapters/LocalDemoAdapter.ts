/**
 * KS-4277. Локальный адаптер для гостевого демо-репертуара
 * (ADR-128 §5 / KS-4161, KS-4163).
 *
 * Валидирует ход по `tree.nodes[fen].edges`, бот делает первый edge
 * детерминистично. Прогресс (`score`, `correctMoves`, `wrongMoves`,
 * `hintsUsed`, `learnedFens`) хранится в localStorage под ключом
 * `kingside.openingTrainer.demo.<id>`. Никаких серверных POST.
 *
 * До KS-4277 эта логика жила в `OpeningTrainerDemoPage.tsx` (550 строк
 * перемешанные с UI). Сейчас здесь — чистая модель данных, без знаний
 * о React/UI.
 */
import { Chess } from 'chess.js';
import { ApiError } from '../../../ApiError';
import { openingTrainerApi } from '../../../api/openingTrainerApi';
import type {
  OpeningRepertoireDetailDto,
  RepertoireEdge,
  RepertoireNode,
} from '@kingside/shared';
import type {
  OpeningTrainerAdapter,
  OpeningTrainerAdapterCapabilities,
  OpeningTrainerBotMove,
  OpeningTrainerCounters,
  OpeningTrainerHintOutcome,
  OpeningTrainerInitialState,
  OpeningTrainerOutcome,
  SubmitMoveArgs,
} from './types';

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

const SCORE_PER_CORRECT = 10;
const WRONG_RESET_DELAY_MS = 600;

export function localDemoStorageKey(id: string): string {
  return `kingside.openingTrainer.demo.${id}`;
}

function readProgress(id: string): LocalProgress {
  try {
    const raw = localStorage.getItem(localDemoStorageKey(id));
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
    localStorage.setItem(
      localDemoStorageKey(id),
      JSON.stringify(progress),
    );
  } catch {
    /* quota errors игнорируем — это всё равно best-effort */
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

function toCounters(p: LocalProgress): OpeningTrainerCounters {
  return {
    score: p.score,
    correctMoves: p.correctMoves,
    wrongMoves: p.wrongMoves,
    hintsUsed: p.hintsUsed,
  };
}

/**
 * KS-4277. Исключение «демо-репертуар не найден» — Player покажет
 * empty-state «coming soon». Бросаем именно ApiError-404, чтобы Player
 * мог отличить «404» от «сеть упала».
 */
export class LocalDemoNotFoundError extends Error {
  constructor() {
    super('demo-not-found');
    this.name = 'LocalDemoNotFoundError';
  }
}

export class LocalDemoAdapter implements OpeningTrainerAdapter {
  readonly capabilities: OpeningTrainerAdapterCapabilities = {
    showWrongModal: false,
    showHintArrow: false,
    showStreak: false,
    showRestartLineButton: true,
    showResetProgressButton: true,
    showUndoButton: false,
    showGiveupButton: false,
    showFinishButton: false,
  };

  private demo: OpeningRepertoireDetailDto | null = null;
  private chess: Chess | null = null;
  private currentFen: string = '';
  private progress: LocalProgress = { ...EMPTY_PROGRESS };
  private learnedSet: Set<string> = new Set();

  constructor(private readonly id: string) {}

  async loadInitial(): Promise<OpeningTrainerInitialState> {
    try {
      const data = await openingTrainerApi.getDemoRepertoire(this.id);
      this.demo = data as unknown as OpeningRepertoireDetailDto;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new LocalDemoNotFoundError();
      }
      throw err;
    }
    const game = new Chess(this.demo.tree.rootFen);
    this.chess = game;
    this.currentFen = this.demo.tree.rootFen;
    this.progress = readProgress(this.id);
    this.learnedSet = new Set(this.progress.learnedFens);
    return {
      title: this.demo.title,
      description: this.demo.description ?? undefined,
      side: this.demo.side ?? 'white',
      currentFen: this.currentFen,
      lastMoveUci: null,
      counters: toCounters(this.progress),
    };
  }

  async submitMove(args: SubmitMoveArgs): Promise<OpeningTrainerOutcome> {
    if (!this.demo || !this.chess) {
      throw new Error('LocalDemoAdapter: submitMove before loadInitial');
    }
    const node: RepertoireNode | null =
      this.demo.tree.nodes[this.currentFen] ?? null;
    if (!node) {
      // Не должно случаться — currentFen всегда есть в дереве (узел
      // мог не иметь edges, тогда юзеру не дать сходить).
      return {
        kind: 'wrong',
        newFen: this.currentFen,
        resetDelayMs: WRONG_RESET_DELAY_MS,
        expected: [],
        counters: toCounters(this.progress),
      };
    }

    const from = args.moveUci.slice(0, 2);
    const to = args.moveUci.slice(2, 4);
    const promotion =
      args.moveUci.length > 4
        ? (args.moveUci[4] as 'q' | 'r' | 'b' | 'n')
        : isPromotionAttempt(this.chess, from, to)
          ? 'q'
          : undefined;

    const fenBefore = this.currentFen;
    const test = new Chess(this.chess.fen());
    const moved = test.move({ from, to, promotion });
    if (!moved) {
      // chess.js не пустил ход вовсе → откатываем доску без штрафа.
      return {
        kind: 'wrong',
        newFen: fenBefore,
        resetDelayMs: WRONG_RESET_DELAY_MS,
        expected: node.edges.map(toExpectedMove),
        counters: toCounters(this.progress),
      };
    }

    const uci = from + to + (promotion ?? '');
    const expectedEdge = node.edges.find((e: RepertoireEdge) => e.moveUci === uci);

    if (!expectedEdge) {
      // Неверный ход относительно репертуара.
      this.progress = {
        ...this.progress,
        wrongMoves: this.progress.wrongMoves + 1,
      };
      writeProgress(this.id, this.progress);
      // chess.js-инстанс адаптера не двигаем (доска у Плеера
      // визуально покажет ход, потом откатится по resetDelayMs).
      return {
        kind: 'wrong',
        newFen: fenBefore,
        resetDelayMs: WRONG_RESET_DELAY_MS,
        expected: node.edges.map(toExpectedMove),
        counters: toCounters(this.progress),
      };
    }

    // Корректный ход — двигаемся по дереву.
    this.chess = test;
    this.currentFen = expectedEdge.childFen;
    const wasLearned = this.learnedSet.has(node.fen);
    if (!wasLearned) this.learnedSet.add(node.fen);
    this.progress = {
      ...this.progress,
      score: this.progress.score + SCORE_PER_CORRECT,
      correctMoves: this.progress.correctMoves + 1,
      learnedFens: Array.from(this.learnedSet),
    };
    writeProgress(this.id, this.progress);

    const afterNode = this.demo.tree.nodes[expectedEdge.childFen] ?? null;
    const botMove = this.computeBotMove(afterNode);

    if (botMove) {
      // Бот сразу сходит — обновляем внутренний chess.
      try {
        const afterBot = new Chess(botMove.newFen);
        this.chess = afterBot;
        this.currentFen = botMove.newFen;
      } catch {
        /* ignore */
      }
    }

    // Если после нашего хода (и возможного бот-хода) в дереве нет
    // продолжений для нашей стороны и нет ответа бота — линия завершена.
    const finalFen = botMove ? botMove.newFen : expectedEdge.childFen;
    const finalNode = this.demo.tree.nodes[finalFen] ?? null;
    const isLineComplete =
      !finalNode || finalNode.edges.length === 0;

    if (isLineComplete && !botMove) {
      return {
        kind: 'line-complete',
        newFen: finalFen,
        lastMoveUci: uci,
        counters: toCounters(this.progress),
      };
    }
    if (isLineComplete && botMove) {
      // Бот сделал последний ход — после него вариаций нет.
      return {
        kind: 'correct',
        newFen: expectedEdge.childFen,
        lastMoveUci: uci,
        counters: toCounters(this.progress),
        botMove,
      };
    }

    return {
      kind: 'correct',
      newFen: expectedEdge.childFen,
      lastMoveUci: uci,
      counters: toCounters(this.progress),
      botMove,
    };
  }

  async requestHint(): Promise<OpeningTrainerHintOutcome> {
    if (!this.demo) {
      throw new Error('LocalDemoAdapter: requestHint before loadInitial');
    }
    const node = this.demo.tree.nodes[this.currentFen] ?? null;
    const first = node?.edges[0];
    if (!first) {
      // Нечего подсказывать — возвращаем «пустую» подсказку без штрафа.
      return {
        moveUci: '',
        moveSan: '',
        counters: toCounters(this.progress),
      };
    }
    this.progress = {
      ...this.progress,
      hintsUsed: this.progress.hintsUsed + 1,
    };
    writeProgress(this.id, this.progress);
    return {
      moveUci: first.moveUci,
      moveSan: first.moveSan,
      counters: toCounters(this.progress),
    };
  }

  async restartLine(): Promise<OpeningTrainerInitialState> {
    if (!this.demo) {
      throw new Error('LocalDemoAdapter: restartLine before loadInitial');
    }
    this.chess = new Chess(this.demo.tree.rootFen);
    this.currentFen = this.demo.tree.rootFen;
    return {
      title: this.demo.title,
      description: this.demo.description ?? undefined,
      side: this.demo.side ?? 'white',
      currentFen: this.currentFen,
      lastMoveUci: null,
      counters: toCounters(this.progress),
    };
  }

  async resetProgress(): Promise<OpeningTrainerInitialState> {
    if (!this.demo) {
      throw new Error('LocalDemoAdapter: resetProgress before loadInitial');
    }
    this.progress = { ...EMPTY_PROGRESS };
    this.learnedSet = new Set();
    writeProgress(this.id, this.progress);
    return this.restartLine();
  }

  /**
   * Бот-ход: если очередь НЕ нашей стороны и в дереве есть продолжение —
   * берём первый edge. Возвращает `null` если хода нет.
   */
  private computeBotMove(node: RepertoireNode | null): OpeningTrainerBotMove | null {
    if (!this.chess || !this.demo || !node) return null;
    const side = this.demo.side ?? 'white';
    const turn: 'white' | 'black' = this.chess.turn() === 'w' ? 'white' : 'black';
    if (turn === side) return null;
    if (node.edges.length === 0) return null;
    const edge = node.edges[0];
    const sim = new Chess(this.chess.fen());
    const promotion =
      edge.moveUci.length > 4
        ? (edge.moveUci[4] as 'q' | 'r' | 'b' | 'n')
        : undefined;
    const moved = sim.move({
      from: edge.moveUci.slice(0, 2),
      to: edge.moveUci.slice(2, 4),
      promotion,
    });
    if (!moved) return null;
    return {
      moveUci: edge.moveUci,
      moveSan: moved.san,
      newFen: edge.childFen,
    };
  }
}

function toExpectedMove(edge: RepertoireEdge) {
  return { moveUci: edge.moveUci, moveSan: edge.moveSan };
}
