import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { StudyProfile } from '../study-plan-generator.service';
import {
  GameFragment,
  LessonMaterial,
  LessonMaterialSource,
  MaterialNote,
} from './lesson-material.types';

/**
 * KS-4910 / ADR-162 §4. Baseline-заглушка материала: только дешёвые
 * сигналы, БЕЗ движка и БЕЗ поиска ошибок.
 * - focusThemes — слабые темы профиля (v1) + carry-over;
 * - gameFragments — 1–2 последние партии из workshop-импортов
 *   (PgnImportGame): метаданные заголовков, PGN как есть;
 * - positions — пусто (наполнит будущий источник поиска ошибок);
 * - notes — агрегаты по PGN-заголовкам последних партий (результаты,
 *   цвета, дебюты) — парсинг ТЕГОВ, не ходов.
 */
@Injectable()
export class BaselineMaterialSource implements LessonMaterialSource {
  /** Сколько последних партий смотреть для notes-агрегатов. */
  private static readonly NOTES_GAMES = 10;
  /** Сколько партий отдавать в game-шаги. */
  private static readonly FRAGMENTS = 2;

  constructor(private readonly prisma: PrismaService) {}

  async extract(userId: string, profile: StudyProfile): Promise<LessonMaterial> {
    const recent = await this.prisma.pgnImportGame.findMany({
      where: { import: { userId } },
      orderBy: [{ import: { createdAt: 'desc' } }, { position: 'desc' }],
      take: BaselineMaterialSource.NOTES_GAMES,
      select: {
        pgn: true,
        white: true,
        black: true,
        result: true,
        opening: true,
        import: { select: { fileName: true } },
      },
    });

    const focusThemes = [
      ...(profile.carryOver.theme ? [profile.carryOver.theme] : []),
      ...profile.weakThemes.map((t) => t.theme),
    ];

    const gameFragments: GameFragment[] = recent
      .slice(0, BaselineMaterialSource.FRAGMENTS)
      .map((g) => ({
        pgn: g.pgn,
        white: g.white,
        black: g.black,
        result: g.result,
        opening: g.opening,
      }));

    return {
      focusThemes,
      gameFragments,
      positions: [],
      notes: this.buildNotes(recent, profile),
    };
  }

  private buildNotes(
    games: Array<{ result: string | null; opening: string | null }>,
    profile: StudyProfile,
  ): MaterialNote[] {
    const notes: MaterialNote[] = [];
    if (profile.carryOver.theme) {
      notes.push({ key: 'carryOver', args: { theme: profile.carryOver.theme } });
    }
    if (games.length === 0) {
      notes.push({ key: 'noGames', args: {} });
      return notes;
    }
    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const g of games) {
      // Без имени пользователя в тегах точной атрибуции нет — считаем
      // грубые агрегаты по результату партии как есть.
      if (g.result === '1-0' || g.result === '0-1') {
        // счёт побед/поражений уточнит источник v3 с привязкой к цвету
        wins += g.result === '1-0' ? 1 : 0;
        losses += g.result === '0-1' ? 1 : 0;
      } else if (g.result === '1/2-1/2') {
        draws++;
      }
    }
    notes.push({ key: 'results', args: { wins, losses, draws } });

    const openings = [
      ...new Set(games.map((g) => g.opening).filter((o): o is string => !!o)),
    ].slice(0, 3);
    if (openings.length > 0) {
      notes.push({ key: 'openings', args: { openings: openings.join(', ') } });
    }
    return notes;
  }
}
