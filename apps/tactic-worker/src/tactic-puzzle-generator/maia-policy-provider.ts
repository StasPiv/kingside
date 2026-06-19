/**
 * KS-4340 / ADR-135 §2.3. Адаптер `MaiaAnnotationService` →
 * `MaiaPolicySource` из shared. Используется обоими пайплайнами
 * (continuous annotation и tactic-puzzle-generator), чтобы делить
 * одну singleton ONNX-сессию модели Maia-3 (~125 MiB).
 *
 * Сам adapter тонкий — лишь делегирует `predictPolicy`. Чтобы создать,
 * нужен экземпляр `MaiaAnnotationService.fromEnv(stockfish)`.
 */
import type { MaiaPolicySource } from '@kingside/shared';
import type { MaiaAnnotationService } from '../maia/maia-annotation.service';

export class TacticMaiaPolicyProvider implements MaiaPolicySource {
  constructor(private readonly maia: MaiaAnnotationService) {}

  async predictMoves(
    fen: string,
    eloW: number,
    eloB: number,
  ): Promise<{ policy: Array<{ move: string; probability: number }> }> {
    return this.maia.predictPolicy(fen, eloW, eloB);
  }
}
