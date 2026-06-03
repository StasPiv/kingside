/**
 * KS-3632 / ADR-104 §4-5. Извлечение solutionUci из строки `Puzzle`
 * для Maia-аннотации.
 *
 * Поведение `puzzle.moves` зависит от `solutionMode`:
 *   - `forced-line` (lichess-импорт): `moves` = "<setupUci> <playerUci>
 *     <opponent> <player> ..."; первый ход — setup-ход соперника.
 *   - `play-vs-engine` (Precision, генерируется `apps/tactic-worker`):
 *     `moves = ''` — линии решения нет, движок играет по ходу.
 *     Правильный первый ход игрока лежит в
 *     `sourceMetadata.firstMovePV1` (см. `generator-pipeline.ts:367` —
 *     одно поле для обоих `puzzlePhase` ∈ {'reactive', 'preventive'};
 *     генератор уже подобрал стартовую FEN под тип, так что Maia
 *     инференс делается прямо на `puzzle.fen`).
 *
 * До этого фикса CLI бэкфилла и continuous-T2 hook оба читали
 * `moves.split(' ')[0]` и для всех Precision-пазлов получали пустую
 * строку → `error='empty-moves'` (см. KS-3635 прод-инцидент: 11724/11724
 * errors).
 */
export function resolvePveSolutionUci(
  moves: string,
  sourceMetadata: string | null | undefined,
): string | null {
  if (sourceMetadata) {
    try {
      const meta = JSON.parse(sourceMetadata) as Record<string, unknown>;
      const v = meta.firstMovePV1;
      if (typeof v === 'string' && v.length >= 4) return v;
    } catch {
      // невалидный JSON — fallback на moves[0] ниже
    }
  }
  const first = moves.split(' ')[0]?.trim();
  return first && first.length >= 4 ? first : null;
}
