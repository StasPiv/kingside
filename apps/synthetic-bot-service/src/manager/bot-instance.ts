import { Logger } from '@nestjs/common';

/**
 * Контракт `BotInstance`'а для `BotManager`. Реальная реализация —
 * B3v2 (KS-?). Сейчас здесь только интерфейс + заглушка, чтобы можно
 * было собрать lifecycle вокруг неё.
 *
 * Состояния (ADR-034-v2 §5.1):
 *   - `idle`     — создан, но не в очереди;
 *   - `in_queue` — присоединился к матчмейкингу, ждёт партию;
 *   - `in_game`  — играет.
 *
 * `shutdown()` должен:
 *   - для `in_queue` — мгновенно `LEAVE`;
 *   - для `in_game` — попытаться завершить корректно, но force-resign
 *     если запрос на shutdown пришёл с timeout'ом.
 *
 * Конкретная имплементация — B3v2.
 */
export type BotInstanceState = 'idle' | 'in_queue' | 'in_game';

export interface BotInstance {
  readonly userId: string;
  readonly state: BotInstanceState;
  /**
   * Корректное завершение работы. Manager вызывает в graceful shutdown
   * с общим бюджетом (см. `BotManager.SHUTDOWN_TIMEOUT_MS`). Если истечёт —
   * manager переключится на force-disconnect (B3v2).
   */
  shutdown(): Promise<void>;
}

/**
 * Заглушка под B3v2. Только хранит userId, состояние и логгирует
 * `shutdown()`. Используется и в проде до прихода B3v2 (лучше,
 * чем падать), и в тестах.
 */
export class BotInstanceStub implements BotInstance {
  private readonly logger = new Logger(BotInstanceStub.name);
  private _state: BotInstanceState;

  constructor(
    public readonly userId: string,
    initialState: BotInstanceState = 'idle',
  ) {
    this._state = initialState;
  }

  get state(): BotInstanceState {
    return this._state;
  }

  /** Тестовый сеттер — на проде B3v2 будет управлять через события. */
  setState(s: BotInstanceState): void {
    this._state = s;
  }

  async shutdown(): Promise<void> {
    this.logger.log(`[stub] shutdown userId=${this.userId} state=${this._state}`);
    this._state = 'idle';
  }
}
