import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { ExternalChessService } from '../../workshop/external-chess.service';
import { WorkshopService } from '../../workshop/workshop.service';
import { parsePgnGames } from '../../workshop/pgn.parser';
import type { StudyProfile } from '../study-plan-generator.service';
import {
  GameFragment,
  LessonMaterial,
  LessonMaterialSource,
  MaterialNote,
} from './lesson-material.types';

/**
 * KS-4910 / ADR-162 §4, уточнён ADR-166. Baseline-заглушка материала:
 * только дешёвые сигналы, БЕЗ движка и БЕЗ поиска ошибок.
 * - focusThemes — слабые темы профиля (v1) + carry-over;
 * - gameFragments — 1–2 последние партии игрока ТОЛЬКО из online-импортов
 *   (origin auto_ или external_) с мэтчем по привязанному username; ручные
 *   PGN и чужие партии в разбор не попадают;
 * - positions — пусто (наполнит будущий источник поиска ошибок);
 * - notes — агрегаты по PGN-заголовкам с корректной атрибуцией цвета/
 *   результата по username игрока. Нет квалифицированных партий →
 *   gameFragments=[] → builder пропускает game-шаг (ADR-166 §2.4).
 */
@Injectable()
export class BaselineMaterialSource implements LessonMaterialSource {
  /** Сколько последних партий смотреть для notes-агрегатов. */
  private static readonly NOTES_GAMES = 10;
  /** Сколько партий отдавать в game-шаги. */
  private static readonly FRAGMENTS = 2;
  /** Кандидатов до username-фильтра тянем с запасом. */
  private static readonly CANDIDATE_POOL = 60;
  /** ADR-166 §2.2: online-провенанс — только свои реальные партии. */
  private static readonly ONLINE_ORIGINS = [
    'auto_lichess',
    'auto_chesscom',
    'external_lichess',
    'external_chesscom',
  ];
  /** ADR-166 §2.3: окно разового бэкфилла — не более N партий на провайдер. */
  private static readonly BACKFILL_MAX_GAMES = 20;
  /** Повторную попытку бэкфилла не чаще раза в сутки (rate-limit-safe). */
  private static readonly BACKFILL_GUARD_TTL_SEC = 86400;

  private readonly logger = new Logger(BaselineMaterialSource.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly externalChess: ExternalChessService,
    private readonly workshop: WorkshopService,
  ) {}

  async extract(userId: string, profile: StudyProfile): Promise<LessonMaterial> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lichessUsername: true, chesscomUsername: true },
    });
    const usernames = [user?.lichessUsername, user?.chesscomUsername]
      .filter((u): u is string => !!u)
      .map((u) => u.toLowerCase());

    const focusThemes = [
      ...(profile.carryOver.theme ? [profile.carryOver.theme] : []),
      ...profile.weakThemes.map((t) => t.theme),
    ];

    // Без привязанного аккаунта своих online-партий быть не может —
    // game-шаг отсутствует, урок строится на темах+пазлах.
    if (usernames.length === 0) {
      return {
        focusThemes,
        gameFragments: [],
        positions: [],
        notes: this.buildNotes([], profile),
      };
    }

    let candidates = await this.queryOnlineCandidates(userId);

    // ADR-166 §2.3: своих online-партий ещё нет (только что привязал
    // аккаунт / автоимпорт не отработал) — разовый бэкфилл окна 30д/20
    // партий на провайдер, затем повторная выборка.
    if (candidates.length === 0) {
      const backfilled = await this.backfillRecentGames(userId, {
        lichessUsername: user?.lichessUsername ?? null,
        chesscomUsername: user?.chesscomUsername ?? null,
      });
      if (backfilled) candidates = await this.queryOnlineCandidates(userId);
    }

    // ADR-166 §2.2: только партии, где сам игрок (мэтч white/black по
    // привязанному username, регистронезависимо) — это и отбор своих
    // партий, и корректная атрибуция цвета.
    const own = candidates
      .map((g) => {
        const white = (g.white ?? '').toLowerCase();
        const black = (g.black ?? '').toLowerCase();
        const userColor: 'w' | 'b' | null = usernames.includes(white)
          ? 'w'
          : usernames.includes(black)
            ? 'b'
            : null;
        return userColor ? { ...g, userColor } : null;
      })
      .filter((g): g is NonNullable<typeof g> => g !== null)
      .slice(0, BaselineMaterialSource.NOTES_GAMES);

    const gameFragments: GameFragment[] = own
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
      notes: this.buildNotes(own, profile),
    };
  }

  /** Свежие online-партии пользователя (origin auto_/external_). */
  private queryOnlineCandidates(userId: string) {
    return this.prisma.pgnImportGame.findMany({
      where: {
        import: {
          userId,
          origin: { in: BaselineMaterialSource.ONLINE_ORIGINS },
        },
      },
      orderBy: [{ import: { createdAt: 'desc' } }, { position: 'desc' }],
      take: BaselineMaterialSource.CANDIDATE_POOL,
      select: {
        pgn: true,
        white: true,
        black: true,
        result: true,
        opening: true,
      },
    });
  }

  /**
   * ADR-166 §2.3: разовый бэкфилл последних партий на каждый привязанный
   * провайдер — окно текущего месяца, не более BACKFILL_MAX_GAMES партий.
   * Redis-guard не чаще раза в сутки на пользователя (rate-limit-safe).
   * Возвращает true, если что-то импортировано.
   */
  private async backfillRecentGames(
    userId: string,
    user: { lichessUsername: string | null; chesscomUsername: string | null },
  ): Promise<boolean> {
    const guardKey = `study:backfill:${userId}`;
    const acquired = await this.redis
      .set(
        guardKey,
        `${Date.now()}`,
        'EX',
        BaselineMaterialSource.BACKFILL_GUARD_TTL_SEC,
        'NX',
      )
      .catch(() => null);
    if (acquired !== 'OK') return false;

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const providers: Array<{
      name: 'lichess' | 'chesscom';
      username: string;
      origin: string;
    }> = [];
    if (user.lichessUsername) {
      providers.push({
        name: 'lichess',
        username: user.lichessUsername,
        origin: 'auto_lichess',
      });
    }
    if (user.chesscomUsername) {
      providers.push({
        name: 'chesscom',
        username: user.chesscomUsername,
        origin: 'auto_chesscom',
      });
    }

    let imported = false;
    for (const p of providers) {
      try {
        const raw =
          p.name === 'lichess'
            ? await this.externalChess.fetchLichessGames(
                p.username,
                year,
                month,
                BaselineMaterialSource.BACKFILL_MAX_GAMES,
              )
            : await this.externalChess.fetchChesscomGames(
                p.username,
                year,
                month,
              );
        if (!raw || !raw.trim()) continue;
        // Кап на BACKFILL_MAX_GAMES партий (chesscom отдаёт весь месяц).
        const games = parsePgnGames(raw).slice(
          0,
          BaselineMaterialSource.BACKFILL_MAX_GAMES,
        );
        if (games.length === 0) continue;
        const pgn = games.map((g) => g.pgn).join('\n\n');
        await this.workshop.importPgn(
          userId,
          {
            buffer: Buffer.from(pgn, 'utf8'),
            originalname: `study-backfill (${p.name}).pgn`,
          } as Express.Multer.File,
          p.origin,
        );
        imported = true;
      } catch (e) {
        this.logger.warn(
          `study backfill ${p.name}/${p.username} failed: ${(e as Error).message}`,
        );
      }
    }
    return imported;
  }

  private buildNotes(
    games: Array<{
      result: string | null;
      opening: string | null;
      userColor?: 'w' | 'b';
    }>,
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
      if (g.result === '1/2-1/2') {
        draws++;
        continue;
      }
      // ADR-166: атрибуция по цвету игрока — победа/поражение считаются
      // относительно его стороны, а не абстрактно по результату партии.
      if (g.result === '1-0') {
        if (g.userColor === 'w') wins++;
        else if (g.userColor === 'b') losses++;
      } else if (g.result === '0-1') {
        if (g.userColor === 'b') wins++;
        else if (g.userColor === 'w') losses++;
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
