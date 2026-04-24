/**
 * KS-1813: orchestrator для брекет-классификации раунда.
 *
 * Вход — `roundId` (UUID из БД). Внутри:
 *   1. Загружает round + broadcast.format + games.
 *   2. Определяет `tournamentType` через `detectRoundTournamentType`
 *      (учитывает name + format + структуру пар).
 *   3. Если `playoff` — считает `classifyBrackets` и обновляет все игры;
 *      иначе — чистит bracket-поля, чтобы не остались «зомби»-значения
 *      если раунд сменил тип (редко, но возможно при ручной правке
 *      имени в Lichess).
 *   4. Обновляет `broadcast_rounds.tournament_type`.
 *
 * Изолированная функция — не зависит от NestJS, принимает PrismaClient
 * напрямую. Используется из `BroadcastSyncService` после каждого
 * PGN-обновления раунда.
 */

import type { PrismaClient } from '@kingside/broadcasts-db';
import {
  detectRoundTournamentType,
  type DetectRoundInput,
} from './detect-round-tournament-type';
import { classifyBrackets } from './bracket-classifier';

export interface ClassifyRoundResult {
  tournamentType: 'round_robin' | 'swiss' | 'playoff' | 'unknown';
  gamesUpdated: number;
}

export async function classifyRoundBrackets(
  prisma: PrismaClient,
  roundId: string,
): Promise<ClassifyRoundResult> {
  const round = await prisma.broadcastRound.findUnique({
    where: { id: roundId },
    include: {
      // KS-1847: нужен `teamTable` — детектор применяет строгий
      // whitelist и игнорирует структурный сигнал для team-турниров.
      broadcast: { select: { format: true, teamTable: true } },
      games: {
        select: { id: true, whitePlayer: true, blackPlayer: true, result: true },
      },
    },
  });
  if (!round) return { tournamentType: 'unknown', gamesUpdated: 0 };

  const detectInput: DetectRoundInput = {
    roundName: round.name,
    broadcastFormat: round.broadcast.format,
    isTeamTournament: round.broadcast.teamTable,
    games: round.games.map((g) => ({
      whitePlayer: g.whitePlayer,
      blackPlayer: g.blackPlayer,
    })),
  };
  const tournamentType = detectRoundTournamentType(detectInput);

  // Обновляем тип раунда, если изменился.
  if (round.tournamentType !== tournamentType) {
    await prisma.broadcastRound.update({
      where: { id: round.id },
      data: { tournamentType },
    });
  }

  if (tournamentType === 'playoff') {
    const classified = classifyBrackets(round.name, round.games);
    let updated = 0;
    for (const [gameId, fields] of classified) {
      await prisma.broadcastGame.update({
        where: { id: gameId },
        data: {
          bracketStage: fields.bracketStage,
          bracketPairId: fields.bracketPairId || null,
          matchScore: fields.matchScore,
        },
      });
      updated++;
    }
    return { tournamentType, gamesUpdated: updated };
  }

  // Не плей-офф — чистим bracket-поля, чтобы не оставлять мусор.
  // `updateMany` с фильтром «есть хотя бы одно bracket-поле» позволяет
  // избежать ненужной записи для игр, у которых всё уже null.
  const cleaned = await prisma.broadcastGame.updateMany({
    where: {
      roundId: round.id,
      OR: [
        { bracketStage: { not: null } },
        { bracketPairId: { not: null } },
        { matchScore: { not: null } },
      ],
    },
    data: {
      bracketStage: null,
      bracketPairId: null,
      matchScore: null,
    },
  });
  return { tournamentType, gamesUpdated: cleaned.count };
}
