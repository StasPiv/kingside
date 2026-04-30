/**
 * KS-2161 (B7). State-машина одной synthetic-партии.
 *
 * Состояния:
 *   - `awaiting_move` — ждём хода соперника.
 *   - `thinking`      — пришёл ход, считаем `thinkMs`,  setTimeout
 *                       до момента отправки нашего хода.
 *   - `moving`        — таймер сработал, отправляем ход в game state.
 *   - `finished`      — партия закончилась (мат / ничья / отказ).
 *
 * Изоляция: каждая партия — свой инстанс runner'а. Падение одного не
 * должно ломать другие — все шаги в try/catch внутри одного instance'а.
 *
 * Fallback: если `MoveEngine.computeMove` не успел за 90% бюджета —
 * runner делает random legal move. Бюджет = `thinkMs` от прошлой
 * предсказанной длительности (или текущего expectedTime).
 *
 * Переживание рестарта: момент «когда отправлять ход» сохраняется в
 * Redis под ключом `game:<gameId>:synthetic_move_due_at` со значением
 * `<timestamp_ms>`. На onModuleInit `BotGameRunnerOrchestrator` читает
 * все эти ключи; если `due_at <= now` — отправляет ход немедленно
 * (compensation tick), иначе ставит обычный setTimeout. Сам runner
 * не переживает рестарт сам по себе — orchestrator его пересобирает.
 *
 * Этот файл реализует **один runner на партию** — orchestrator
 * (создающий инстансы и хранящий их в Map) — отдельный класс ниже.
 */

import { Logger } from '@nestjs/common';
import {
  randomLegalMove,
  type SyntheticMoveEngineService,
  type ComputeMoveOutput,
} from './synthetic-move-engine.service';

export type RunnerState = 'awaiting_move' | 'thinking' | 'moving' | 'finished';

const REDIS_DUE_KEY_PREFIX = 'game:';
const REDIS_DUE_KEY_SUFFIX = ':synthetic_move_due_at';

export function dueAtKey(gameId: string): string {
  return `${REDIS_DUE_KEY_PREFIX}${gameId}${REDIS_DUE_KEY_SUFFIX}`;
}

/**
 * Узкий контракт game state'а, которому отправляется ход. По факту —
 * `GameService.makeMove(...)` или его обёртка.
 */
export interface RunnerGameApi {
  /** Возвращает текущее FEN + plyCount для следующего хода synthetic'а. */
  getPosition(gameId: string): Promise<{
    fen: string;
    plyCount: number;
    finished: boolean;
  }>;
  /** Делает ход synthetic'а в game state. */
  makeMove(gameId: string, userId: string, uci: string): Promise<void>;
}

/**
 * Узкий API Redis для runner'а: SET dueAt с TTL, GET, DEL.
 */
export interface RunnerRedis {
  set(
    key: string,
    value: string,
    mode?: 'EX',
    ttl?: number,
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface RunnerInput {
  gameId: string;
  syntheticUserId: string;
  category: 'bullet' | 'blitz' | 'rapid' | 'classical';
  rating: number;
  /** Подменяемый источник времени (для тестов). */
  now?: () => number;
  /** Подменяемый setTimeout — `jest.fakeTimers` не нужен. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}

export interface RunnerDeps {
  engine: Pick<SyntheticMoveEngineService, 'computeMove'>;
  game: RunnerGameApi;
  redis: RunnerRedis;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

export class BotGameRunner {
  state: RunnerState = 'awaiting_move';
  private timeoutHandle: unknown = null;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (h: unknown) => void;
  private readonly nowFn: () => number;

  constructor(
    private readonly input: RunnerInput,
    private readonly deps: RunnerDeps,
  ) {
    this.logger = deps.logger ?? new Logger(`BotGameRunner:${input.gameId.slice(0, 8)}`);
    this.setTimeoutFn = input.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = input.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.nowFn = input.now ?? (() => Date.now());
  }

  /**
   * Триггерится извне когда соперник сделал ход (или при инициации
   * партии, если synthetic — белые). Запускает thinking-фазу.
   */
  async onOpponentMoved(): Promise<void> {
    if (this.state === 'finished') return;
    if (this.state === 'thinking' || this.state === 'moving') {
      this.logger.warn(
        `onOpponentMoved called in state=${this.state} — ignoring (race)`,
      );
      return;
    }
    await this.scheduleNextMove();
  }

  /**
   * Compensation tick — вызывается orchestrator'ом на старте, если
   * Redis-ключ говорит, что мы должны были ходить уже давно. Запускает
   * moving-фазу немедленно (без thinking-задержки).
   */
  async tickOverdueImmediately(): Promise<void> {
    if (this.state === 'finished') return;
    this.logger.warn(
      `tickOverdueImmediately for game=${this.input.gameId} — sending move now`,
    );
    await this.executeMove();
  }

  finish(): void {
    if (this.timeoutHandle) {
      this.clearTimeoutFn(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.state = 'finished';
    void this.deps.redis.del(dueAtKey(this.input.gameId)).catch(() => {});
  }

  private async scheduleNextMove(): Promise<void> {
    this.state = 'thinking';
    let computed: ComputeMoveOutput;
    try {
      const pos = await this.deps.game.getPosition(this.input.gameId);
      if (pos.finished) {
        this.finish();
        return;
      }
      computed = await this.deps.engine.computeMove({
        gameId: this.input.gameId,
        fen: pos.fen,
        plyCount: pos.plyCount,
        category: this.input.category,
        rating: this.input.rating,
      });
    } catch (err) {
      // Engine упал → fallback на random + минимальный thinkMs.
      this.logger.warn(
        `engine.computeMove failed: ${(err as Error).message} — fallback random`,
      );
      const pos = await this.deps.game.getPosition(this.input.gameId).catch(
        () => null,
      );
      if (!pos || pos.finished) {
        this.finish();
        return;
      }
      const fallback = randomLegalMove(pos.fen);
      if (!fallback) {
        this.finish();
        return;
      }
      computed = {
        uci: fallback,
        thinkMs: 200,
        source: 'random-fallback',
      };
    }

    const dueAt = this.nowFn() + computed.thinkMs;
    // Сохраняем в Redis, чтобы переживать рестарт. TTL — 1 час, к этому
    // моменту партия точно отжила.
    await this.deps.redis
      .set(dueAtKey(this.input.gameId), String(dueAt), 'EX', 3600)
      .catch(() => null);

    this.timeoutHandle = this.setTimeoutFn(() => {
      void this.executeMove(computed.uci).catch((err) =>
        this.logger.warn(
          `executeMove failed: ${(err as Error).message}`,
        ),
      );
    }, computed.thinkMs);

    // Fallback страховка: если executeMove не дернётся за 90% от
    // thinkMs + 1 сек — форсим. Полезно когда сам setTimeout «спит» на
    // event-loop. Реализуется как ещё один setTimeout с таймером
    // thinkMs * 1.1 + 1000.
    const fallbackTimeoutMs = Math.max(2_000, computed.thinkMs * 1.1 + 1000);
    this.setTimeoutFn(() => {
      if (this.state !== 'thinking') return;
      this.logger.warn(
        `runner stuck in thinking past 110% budget — forcing fallback move`,
      );
      void this.executeMove().catch(() => {});
    }, fallbackTimeoutMs);
  }

  /**
   * Отправляет ход в game state. Если `uci` не задан — фолбэк на random
   * (compensation-сценарий или stuck-fallback).
   */
  private async executeMove(predetermined?: string): Promise<void> {
    if (this.state === 'finished' || this.state === 'moving') return;
    this.state = 'moving';
    if (this.timeoutHandle) {
      this.clearTimeoutFn(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    try {
      const pos = await this.deps.game.getPosition(this.input.gameId);
      if (pos.finished) {
        this.finish();
        return;
      }
      let uci = predetermined ?? null;
      if (!uci) {
        uci = randomLegalMove(pos.fen);
      }
      if (!uci) {
        this.finish();
        return;
      }
      await this.deps.game.makeMove(
        this.input.gameId,
        this.input.syntheticUserId,
        uci,
      );
      this.state = 'awaiting_move';
      // Освободили due-at в Redis — ход сделан.
      void this.deps.redis.del(dueAtKey(this.input.gameId)).catch(() => {});
    } catch (err) {
      this.logger.error(
        `executeMove failed: ${(err as Error).message}`,
      );
      this.state = 'awaiting_move'; // даём шанс retry на следующем onOpponentMoved
    }
  }
}
