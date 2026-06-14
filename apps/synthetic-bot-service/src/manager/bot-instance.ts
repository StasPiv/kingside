import { Logger } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { GameEvents, MatchmakingEvents } from '@kingside/shared';
import type { MoveEngine, MoveProfile } from '../move-engine/move-engine';
import { pickUserAgent } from './ua-pool';

/**
 * State machine `BotInstance` (ADR-034-v2 §5.2):
 *
 *   idle → connecting → in_queue → in_game → finished → idle
 *                          ↓                    ↑
 *                      (LEAVE/timeout)      (close)
 *
 * `failed` — терминальное состояние: 5 неуспешных reconnect'ов подряд.
 * `BotManager` снимает такой инстанс из Map'а и Scheduler берёт другой
 * аккаунт.
 */
export type BotInstanceState =
  | 'idle'
  | 'connecting'
  | 'in_queue'
  | 'in_game'
  | 'finished'
  | 'failed';

/* ───── Контракты, нужные снаружи ───── */

export interface TimeControl {
  /** Initial time, секунды. */
  readonly timeInitial: number;
  /** Increment per move, секунды. */
  readonly increment: number;
}

export interface BotInstance {
  readonly userId: string;
  readonly username: string;
  readonly state: BotInstanceState;
  shutdown(): Promise<void>;
}

/**
 * Сервис, выдающий JWT для синтетика. В реальном приложении —
 * `BotTokenService` из `auth/`. В тестах — простой объект с тем же методом.
 */
export interface TokenSource {
  getToken(botUserId: string): Promise<string>;
  invalidate?(botUserId: string): Promise<void>;
}

/**
 * Зависимости для `BotInstance`. Все «дорогие» части (фабрика socket'а,
 * sleep, random) инжектируются — это позволяет в тестах подменять без
 * мокирования глобалов.
 */
export interface BotInstanceDeps {
  readonly tokens: TokenSource;
  readonly engine: MoveEngine;
  /** Базовый URL game-service'а (например, `http://localhost:3002`). */
  readonly gameServiceUrl: string;
  /** Профиль для `engine.computeMove`. */
  readonly profile: MoveProfile;
  /** Фабрика socket'а — позволяет в тестах внедрить свой transport. */
  readonly socketFactory?: typeof io;
  /** Полностью отключить anti-detection jitter (для тестов). */
  readonly disableJoinJitter?: boolean;
  /** Источник случайных чисел (по умолчанию Math.random). */
  readonly random?: () => number;
  /** Sleep (для отключения реальных задержек в тестах). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Кастомные backoff-периоды (мс). По умолчанию 1000/2000/4000/8000/30000. */
  readonly reconnectBackoffsMs?: readonly number[];
  /** Бюджет graceful shutdown (мс). По умолчанию 90 000. */
  readonly shutdownTimeoutMs?: number;
  /** Колбэк для уведомления BotManager'а о смене состояния. */
  readonly onStateChange?: (
    instance: BotInstance,
    prev: BotInstanceState,
    next: BotInstanceState,
  ) => void;
  /** Колбэк после `failed` — manager удалит из Map. */
  readonly onFailed?: (instance: BotInstance, reason: string) => void;
}

const DEFAULT_RECONNECT_BACKOFFS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 30_000,
];
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 90_000;
const JOIN_JITTER_MIN_MS = 800;
const JOIN_JITTER_MAX_MS = 3_000;

/* ───── BotInstanceStub (для тестов BotManager'а) ───── */

/**
 * Простая заглушка под B2v2 BotManager-тесты. Не имеет socket'ов, ничего
 * не подключает — просто хранит состояние и логирует shutdown. Реальный
 * `BotInstance` — ниже.
 */
export class BotInstanceStub implements BotInstance {
  private readonly logger = new Logger(BotInstanceStub.name);
  private _state: BotInstanceState;
  public readonly username: string;

  constructor(
    public readonly userId: string,
    initialState: BotInstanceState = 'idle',
  ) {
    this._state = initialState;
    this.username = `stub-${userId}`;
  }

  get state(): BotInstanceState {
    return this._state;
  }

  setState(s: BotInstanceState): void {
    this._state = s;
  }

  async shutdown(): Promise<void> {
    this.logger.log(`[stub] shutdown userId=${this.userId} state=${this._state}`);
    this._state = 'idle';
  }
}

/* ───── BotInstanceImpl ───── */

/**
 * Один synthetic-аккаунт = один WS-клиент к game-service.
 *
 * Делает всё то же, что живой пользователь: handshake JWT в socket.io,
 * `matchmaking:join`, ждёт `matchmaking:found`, открывает `/game`-сокет
 * для конкретной партии, играет до `game:end`. Всё remote-rate-limit'ы и
 * валидация — на стороне game-service'а; здесь только клиент.
 *
 * Reconnect: при любом неинициированном `disconnect` или `connect_error`
 * пытается reconnect'нуться по backoff'у 1/2/4/8/30 сек, максимум 5 раз.
 * После reconnect'а:
 *   - `in_queue` → повторный `matchmaking:join`;
 *   - `in_game`  → `game:join` с прежним gameId (game-service grace 30s).
 *
 * Anti-detection минимум: UA фиксируется на сессию (`USER_AGENT_POOL`),
 * перед `matchmaking:join` ждёт 800–3000 мс jitter (отключаемо в тестах).
 */
export class BotInstanceImpl implements BotInstance {
  private readonly logger = new Logger(BotInstanceImpl.name);

  /* — публично читаемые поля — */
  public readonly userId: string;
  public readonly username: string;
  public readonly createdAt: Date = new Date();
  public lastError?: string;
  public currentGameId?: string;
  public category?: string;
  public tc?: TimeControl;

  /* — приватное состояние — */
  private _state: BotInstanceState = 'idle';
  private mmSocket: Socket | null = null;
  private gameSocket: Socket | null = null;
  private readonly userAgent: string;
  private reconnectAttempts = 0;
  /** true → disconnect инициирован нами (shutdown / despawn / finished). */
  private intentionalDisconnect = false;
  private movesHistory: string[] = [];
  /** Цвет, полученный из FOUND/STATE; нужен, чтобы понять, наш ли ход. */
  private myColor: 'white' | 'black' | null = null;
  /** Активные таймеры — для очистки при shutdown. */
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Один pending move — чтобы не запускать дублей через onState/onMove. */
  private moveInFlight = false;
  /** Защита от двух параллельных reconnect'ов (mm + game disconnect одновременно). */
  private reconnectPending = false;
  private cachedToken: string | null = null;

  private readonly deps: Required<
    Pick<BotInstanceDeps, 'tokens' | 'engine' | 'gameServiceUrl' | 'profile'>
  > &
    BotInstanceDeps;

  constructor(
    userId: string,
    username: string,
    deps: BotInstanceDeps,
    randomForUa: () => number = Math.random,
  ) {
    this.userId = userId;
    this.username = username;
    this.deps = {
      ...deps,
      socketFactory: deps.socketFactory ?? io,
      random: deps.random ?? Math.random,
      sleep: deps.sleep ?? defaultSleep,
      reconnectBackoffsMs:
        deps.reconnectBackoffsMs ?? DEFAULT_RECONNECT_BACKOFFS_MS,
      shutdownTimeoutMs: deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    };
    this.userAgent = pickUserAgent(randomForUa);
  }

  get state(): BotInstanceState {
    return this._state;
  }
  /** Тестовый getter — UA, выбранный при создании. */
  get assignedUserAgent(): string {
    return this.userAgent;
  }

  /* ===================== Public API ===================== */

  /**
   * Подключиться к `/matchmaking` и встать в очередь по выбранной
   * категории.
   */
  async connect(category: string, tc: TimeControl): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(
        `BotInstance.connect: cannot connect from state=${this._state}`,
      );
    }
    this.category = category;
    this.tc = tc;
    this.movesHistory = [];
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    await this.openMatchmakingSocket();
  }

  /**
   * Программное завершение работы. Используется `BotManager.despawn` и
   * `BotManager.onModuleDestroy`.
   *
   * - `in_queue`: шлёт `LEAVE`, отключается.
   * - `in_game`: пытается доиграть, но не более `shutdownTimeoutMs`;
   *   после deadline — `RESIGN`.
   * - в остальных состояниях — просто закрывает socket'ы.
   */
  async shutdown(): Promise<void> {
    if (this._state === 'idle' || this._state === 'finished') {
      this.intentionalDisconnect = true;
      this.closeSockets();
      this.transition('idle');
      return;
    }
    this.intentionalDisconnect = true;

    if (this._state === 'in_queue') {
      this.safeEmit(this.mmSocket, MatchmakingEvents.LEAVE, {});
      this.closeSockets();
      this.transition('idle');
      return;
    }

    if (this._state === 'in_game') {
      // Ждём естественного `game:end` до deadline; иначе — RESIGN.
      await this.waitForGameEnd(this.deps.shutdownTimeoutMs!);
      if (this._state === 'in_game' && this.currentGameId) {
        this.logger.warn(
          `shutdown: deadline reached, sending RESIGN game=${this.currentGameId}`,
        );
        this.safeEmit(this.gameSocket, GameEvents.RESIGN, {
          gameId: this.currentGameId,
        });
      }
      this.closeSockets();
      this.transition('idle');
    }

    if (this._state === 'connecting') {
      this.closeSockets();
      this.transition('idle');
    }
  }

  /** Программное disconnect — обычно через BotManager.despawn. */
  async disconnect(): Promise<void> {
    return this.shutdown();
  }

  /* ===================== Sockets ===================== */

  private async openMatchmakingSocket(): Promise<void> {
    this.transition('connecting');
    let token: string;
    try {
      token = await this.deps.tokens.getToken(this.userId);
      this.cachedToken = token;
    } catch (err) {
      this.lastError = `token: ${(err as Error).message}`;
      this.markFailed(this.lastError);
      throw err;
    }

    const socket = this.deps.socketFactory!(
      `${this.deps.gameServiceUrl}/matchmaking`,
      {
        auth: { token },
        transports: ['websocket'],
        reconnection: false, // мы сами рулим reconnect'ом
        forceNew: true,
        extraHeaders: { 'User-Agent': this.userAgent },
      },
    );

    this.mmSocket = socket;
    this.attachMatchmakingHandlers(socket);
  }

  private attachMatchmakingHandlers(socket: Socket): void {
    socket.on('connect', async () => {
      this.logger.log(
        `mm:connect userId=${this.userId} ua=${this.userAgent.slice(0, 30)}`,
      );
      this.reconnectAttempts = 0;
      this.transition('in_queue');
      await this.delayJoinJitter();
      // Если за время jitter'а нас успели остановить — не шлём.
      if (this._state !== 'in_queue') return;
      this.safeEmit(socket, MatchmakingEvents.JOIN, {
        timeInitial: this.tc!.timeInitial,
        increment: this.tc!.increment,
      });
    });

    socket.on('connect_error', (err: Error) => {
      this.lastError = `mm:connect_error ${err.message}`;
      this.logger.warn(this.lastError);
      this.scheduleReconnect();
    });

    socket.on('disconnect', (reason: string) => {
      this.logger.log(`mm:disconnect userId=${this.userId} reason=${reason}`);
      if (this.intentionalDisconnect) return;
      this.scheduleReconnect();
    });

    socket.on(MatchmakingEvents.FOUND, (payload: unknown) => {
      this.handleMatchFound(payload as MatchFoundPayload).catch((e) =>
        this.logger.error(`onMatchFound failed: ${(e as Error).message}`),
      );
    });

    socket.on(MatchmakingEvents.ERROR, (err: { code?: string; message?: string }) => {
      // ALREADY_IN_QUEUE — idempotency, молча игнорим.
      if (err?.code === 'ALREADY_IN_QUEUE') {
        this.logger.log(`mm:ERROR ALREADY_IN_QUEUE — ignored (idempotent)`);
        return;
      }
      this.lastError = `mm:${err?.code || 'ERROR'}: ${err?.message || ''}`;
      this.logger.warn(this.lastError);
    });
  }

  private async handleMatchFound(payload: MatchFoundPayload): Promise<void> {
    if (!payload?.gameId) return;
    this.currentGameId = payload.gameId;
    this.myColor = payload.color === 'black' ? 'black' : 'white';
    await this.openGameSocket();
  }

  private async openGameSocket(): Promise<void> {
    if (!this.cachedToken) {
      this.cachedToken = await this.deps.tokens.getToken(this.userId);
    }
    const socket = this.deps.socketFactory!(
      `${this.deps.gameServiceUrl}/game`,
      {
        auth: { token: this.cachedToken },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        extraHeaders: { 'User-Agent': this.userAgent },
      },
    );
    this.gameSocket = socket;
    this.attachGameHandlers(socket);
  }

  private attachGameHandlers(socket: Socket): void {
    socket.on('connect', () => {
      this.logger.log(
        `game:connect userId=${this.userId} game=${this.currentGameId}`,
      );
      this.transition('in_game');
      this.safeEmit(socket, GameEvents.JOIN, { gameId: this.currentGameId });
    });

    socket.on(GameEvents.STATE, (state: GameStatePayload) => {
      this.handleGameState(state).catch((e) =>
        this.logger.error(`onState failed: ${(e as Error).message}`),
      );
    });

    socket.on(GameEvents.MOVE_SERVER, (move: MoveServerPayload) => {
      this.handleServerMove(move).catch((e) =>
        this.logger.error(`onMove failed: ${(e as Error).message}`),
      );
    });

    socket.on(GameEvents.END, () => {
      this.logger.log(`game:end userId=${this.userId} game=${this.currentGameId}`);
      this.handleGameFinished();
    });

    socket.on(GameEvents.ERROR, (err: { code?: string; message?: string }) => {
      this.lastError = `game:${err?.code || 'ERROR'}: ${err?.message || ''}`;
      this.logger.warn(this.lastError);
    });

    socket.on('connect_error', (err: Error) => {
      this.lastError = `game:connect_error ${err.message}`;
      this.logger.warn(this.lastError);
      // Reconnect game-сокета — сам по себе. Но если был mmSocket-disconnect,
      // он уже триггерит reconnect через mm-канал.
      this.scheduleReconnect();
    });

    socket.on('disconnect', (reason: string) => {
      this.logger.log(`game:disconnect userId=${this.userId} reason=${reason}`);
      if (this.intentionalDisconnect) return;
      this.scheduleReconnect();
    });
  }

  /* ===================== Move loop ===================== */

  private async handleGameState(state: GameStatePayload): Promise<void> {
    this.logger.log(
      `game:state userId=${this.userId} fen=${state.fen?.slice(0, 25)} status=${state.status} color=${state.color}`,
    );
    if (state.color === 'white' || state.color === 'black') {
      this.myColor = state.color;
    }
    this.movesHistory = state.moves ?? [];
    if (state.status === 'completed' || state.status === 'aborted') {
      this.handleGameFinished();
      return;
    }
    if (this.isMyTurn(state.fen)) {
      await this.tryMakeMove(state.fen);
    }
  }

  private async handleServerMove(move: MoveServerPayload): Promise<void> {
    this.movesHistory = [...this.movesHistory, move.uci];
    if (this.isMyTurn(move.fen)) {
      await this.tryMakeMove(move.fen);
    }
  }

  private isMyTurn(fen: string): boolean {
    if (!this.myColor) return false;
    // FEN: "<board> w/b ...". Второй сегмент — кому ходить.
    const parts = fen.split(' ');
    if (parts.length < 2) return false;
    const turn = parts[1] === 'w' ? 'white' : 'black';
    return turn === this.myColor;
  }

  private async tryMakeMove(fen: string): Promise<void> {
    if (this.moveInFlight) return;
    if (this._state !== 'in_game') return;
    this.moveInFlight = true;
    try {
      const decision = await this.deps.engine.computeMove(
        fen,
        this.movesHistory,
        this.deps.profile,
      );
      // think-budget: имитируем «время на ход».
      if (decision.thinkMs > 0) {
        await this.deps.sleep!(decision.thinkMs);
      }
      // Пока думали, могла прийти отмена / disconnect.
      if (this._state !== 'in_game' || !this.gameSocket || !this.currentGameId) {
        return;
      }
      this.safeEmit(this.gameSocket, GameEvents.MOVE, {
        gameId: this.currentGameId,
        uci: decision.uci,
      });
    } finally {
      this.moveInFlight = false;
    }
  }

  /* ===================== Lifecycle hooks ===================== */

  private handleGameFinished(): void {
    if (this._state === 'finished' || this._state === 'idle') return;
    this.transition('finished');
    if (this.gameSocket) {
      try {
        this.gameSocket.disconnect();
      } catch {
        /* ignore */
      }
      this.gameSocket = null;
    }
    // matchmaking-socket больше не нужен в этом цикле.
    if (this.mmSocket) {
      try {
        this.mmSocket.disconnect();
      } catch {
        /* ignore */
      }
      this.mmSocket = null;
    }
    this.transition('idle');
  }

  private async waitForGameEnd(timeoutMs: number): Promise<void> {
    if (this._state !== 'in_game') return;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, timeoutMs);
      this.timers.add(timer);
      const interval = setInterval(() => {
        if (this._state !== 'in_game') {
          clearInterval(interval);
          clearTimeout(timer);
          this.timers.delete(timer);
          resolve();
        }
      }, 100);
    });
  }

  /* ===================== Reconnect ===================== */

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this._state === 'failed') return;
    if (this.reconnectPending) return; // mm + game могли упасть одновременно — не удваиваем
    const max = this.deps.reconnectBackoffsMs!.length;
    if (this.reconnectAttempts >= max) {
      this.markFailed(`reconnect exhausted after ${max} attempts`);
      return;
    }
    const delay = this.deps.reconnectBackoffsMs![this.reconnectAttempts];
    this.reconnectAttempts++;
    this.reconnectPending = true;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.reconnectPending = false;
      this.attemptReconnect().catch((err) => {
        this.lastError = `reconnect failed: ${(err as Error).message}`;
        this.logger.warn(this.lastError);
        this.scheduleReconnect();
      });
    }, delay);
    this.timers.add(timer);
  }

  private async attemptReconnect(): Promise<void> {
    this.logger.log(
      `reconnect attempt #${this.reconnectAttempts}/${this.deps.reconnectBackoffsMs!.length} state=${this._state}`,
    );
    // Закрываем потенциально живой mm-сокет (новый создадим).
    if (this.mmSocket) {
      try {
        this.mmSocket.removeAllListeners();
        this.mmSocket.disconnect();
      } catch {
        /* ignore */
      }
      this.mmSocket = null;
    }
    if (this._state === 'in_game' && this.currentGameId) {
      // Партия активна — откроем game-сокет напрямую (без matchmaking).
      if (this.gameSocket) {
        try {
          this.gameSocket.removeAllListeners();
          this.gameSocket.disconnect();
        } catch {
          /* ignore */
        }
        this.gameSocket = null;
      }
      await this.openGameSocket();
      return;
    }
    // В остальных случаях — повторяем mm-flow.
    await this.openMatchmakingSocket();
  }

  private markFailed(reason: string): void {
    this.transition('failed');
    this.lastError = reason;
    this.logger.error(`BotInstance failed userId=${this.userId}: ${reason}`);
    this.closeSockets();
    this.deps.onFailed?.(this, reason);
  }

  /* ===================== Helpers ===================== */

  private async delayJoinJitter(): Promise<void> {
    if (this.deps.disableJoinJitter) return;
    const min = JOIN_JITTER_MIN_MS;
    const max = JOIN_JITTER_MAX_MS;
    const ms = Math.floor(min + this.deps.random!() * (max - min));
    await this.deps.sleep!(ms);
  }

  private safeEmit(socket: Socket | null, event: string, payload: unknown): void {
    if (!socket) return;
    try {
      socket.emit(event, payload);
    } catch (err) {
      this.logger.warn(`emit '${event}' failed: ${(err as Error).message}`);
    }
  }

  private closeSockets(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.mmSocket) {
      try {
        this.mmSocket.removeAllListeners();
        this.mmSocket.disconnect();
      } catch {
        /* ignore */
      }
      this.mmSocket = null;
    }
    if (this.gameSocket) {
      try {
        this.gameSocket.removeAllListeners();
        this.gameSocket.disconnect();
      } catch {
        /* ignore */
      }
      this.gameSocket = null;
    }
  }

  private transition(next: BotInstanceState): void {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    this.deps.onStateChange?.(this, prev, next);
    this.logger.log(`state ${prev} -> ${next} userId=${this.userId}`);
  }
}

/* ===================== local types ===================== */

interface MatchFoundPayload {
  gameId: string;
  color: 'white' | 'black';
}

interface GameStatePayload {
  gameId: string;
  fen: string;
  moves?: string[];
  color?: 'white' | 'black';
  status: string;
}

interface MoveServerPayload {
  uci: string;
  fen: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
