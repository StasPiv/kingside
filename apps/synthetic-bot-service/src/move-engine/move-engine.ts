/**
 * Контракт move-engine'а — выдаёт UCI-ход для текущей позиции.
 *
 * Реальная имплементация в B4v2 (`StockfishPool`, KS-2190): пул из
 * `STOCKFISH_POOL_SIZE` процессов, балансировка по простому FIFO.
 * Здесь, в B3v2, нужен только интерфейс — `BotInstance` принимает
 * любую реализацию через DI / конструктор.
 *
 * `profile` — будущее место для anti-detection шума (depth, TC bias,
 * blunder injection). В B3v2 не используется, но в API оставляем.
 */
export interface MoveProfile {
  /** Уровень / стиль из synthetic-профиля (см. ADR §6.2). */
  readonly skill: number;
  /** Бюджет «мышления» по умолчанию (мс). */
  readonly defaultThinkMs: number;
}

export interface MoveDecision {
  /** UCI-ход вида 'e2e4', 'e7e8q'. */
  readonly uci: string;
  /** Сколько мс думать (jitter в реальной реализации, фикс в моке). */
  readonly thinkMs: number;
}

export interface MoveEngine {
  /**
   * Вычислить ход из FEN'а с учётом истории ходов (для anti-detection
   * вариативности и отлова трёхкратного повторения).
   */
  computeMove(
    fen: string,
    history: readonly string[],
    profile: MoveProfile,
  ): Promise<MoveDecision>;
}
