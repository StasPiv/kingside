/**
 * KS-1824: применение результата `computeAdvanceLinks` к таблице
 * `broadcast_games`. Вызывается после `classifyRoundBrackets` для
 * всех раундов броадкаста — результат один (каждая пара получает
 * одинаковые advance/loser на всех партиях), поэтому проще делать
 * одной пачкой по `bracket_pair_id`.
 *
 * Шаги:
 *   1. Сбросить `advance_to_pair_id` / `loser_to_pair_id` у всех
 *      партий броадкаста (чтобы не остались «зомби»-значения после
 *      переименования раунда / смены типа).
 *   2. Запросить уникальные playoff-пары броадкаста и вычислить
 *      `computeAdvanceLinks`.
 *   3. Для каждой пары с non-null advance/loser — `updateMany` по
 *      `bracket_pair_id`.
 */

import type { PrismaClient } from '@kingside/broadcasts-db';
import { computeAdvanceLinks, type PairInput } from './compute-advance-links';

export interface ApplyBracketLinksResult {
  pairs: number;
  linksWritten: number;
}

export async function applyBracketLinks(
  prisma: PrismaClient,
  broadcastId: string,
): Promise<ApplyBracketLinksResult> {
  // Шаг 1: сброс. `updateMany` с фильтром «только партии броадкаста»
  // — round-relation возможно (`broadcast_rounds.broadcast_id = X`).
  await prisma.broadcastGame.updateMany({
    where: {
      round: { broadcastId },
      OR: [
        { advanceToPairId: { not: null } },
        { loserToPairId: { not: null } },
      ],
    },
    data: {
      advanceToPairId: null,
      loserToPairId: null,
    },
  });

  // Шаг 2: собрать уникальные playoff-пары броадкаста.
  const games = await prisma.broadcastGame.findMany({
    where: {
      round: { broadcastId, tournamentType: 'playoff' },
      bracketPairId: { not: null },
      bracketStage: { not: null },
    },
    select: { bracketPairId: true, bracketStage: true },
  });
  const uniq = new Map<string, PairInput>();
  for (const g of games) {
    if (!g.bracketPairId || !g.bracketStage) continue;
    if (uniq.has(g.bracketPairId)) continue;
    uniq.set(g.bracketPairId, {
      bracketPairId: g.bracketPairId,
      bracketStage: g.bracketStage,
    });
  }
  const pairs = [...uniq.values()];
  if (pairs.length === 0) {
    return { pairs: 0, linksWritten: 0 };
  }

  const { byPair } = computeAdvanceLinks(pairs);

  // Шаг 3: проставить advance/loser каждой паре через updateMany
  // (одна запись = один update, N ≤ десятков — приемлемо).
  let linksWritten = 0;
  for (const [pairId, data] of byPair) {
    if (data.advanceToPairId === null && data.loserToPairId === null) continue;
    await prisma.broadcastGame.updateMany({
      where: { bracketPairId: pairId, round: { broadcastId } },
      data: {
        advanceToPairId: data.advanceToPairId,
        loserToPairId: data.loserToPairId,
      },
    });
    linksWritten++;
  }

  return { pairs: pairs.length, linksWritten };
}
