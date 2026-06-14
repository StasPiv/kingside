import type { MoveDecision, MoveEngine, MoveProfile } from './move-engine';

/**
 * Заглушка `MoveEngine` для B3v2 integration-тестов и dev-режима без
 * Stockfish.
 *
 * Стратегия: ход выбирается из заранее заданного списка по индексу,
 * соответствующему количеству уже сделанных ходов. Если список
 * исчерпан — возвращает `e2e4`/`e7e5` поочерёдно (тривиально, но
 * допустимо как заглушка).
 *
 * `thinkMs` — фиксированный (по умолчанию 50 мс): тесты не должны
 * зависать на «реальное мышление». Реальная имплементация (B4v2)
 * считает Stockfish'ем с jitter'ом.
 */
export class MockMoveEngine implements MoveEngine {
  /** Счётчик «своих» ходов (independent от history) — упрощает тестирование. */
  private callCount = 0;

  constructor(
    private readonly script: readonly string[] = [],
    private readonly thinkMs: number = 50,
  ) {}

  async computeMove(
    _fen: string,
    _history: readonly string[],
    _profile: MoveProfile,
  ): Promise<MoveDecision> {
    const idx = this.callCount++;
    if (idx < this.script.length) {
      return { uci: this.script[idx], thinkMs: this.thinkMs };
    }
    // Запасной план — чередуем e2e4 / e7e5. Тесты проверяют transport,
    // не валидность позиции.
    const uci = idx % 2 === 0 ? 'e2e4' : 'e7e5';
    return { uci, thinkMs: this.thinkMs };
  }
}
