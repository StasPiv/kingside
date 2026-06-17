import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { EcoService } from '../game/eco.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
// KS-4205 / ADR-128 §10 #11 §7.3.7. Mutation hooks для prerender
// публичной страницы тренера `/coach/:username`.
import { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18n: I18nService,
    private readonly eco: EcoService,
    /**
     * KS-4205 / ADR-128 §10 #11 §7.3.7. Перегенерация страницы
     * `/coach/:username` при смене username и при обновлении полей,
     * отображаемых на ней.
     */
    private readonly prerender: PrerenderEnqueueService,
  ) {}

  private readonly SETTINGS_SELECT = {
    id: true,
    locale: true,
    boardTheme: true,
    pieceSet: true,
    soundEnabled: true,
    showBotEngineDebugPanel: true,
    chesscomUsername: true,
    lichessUsername: true,
  } as const;

  async checkUsername(username: string): Promise<{ available: boolean }> {
    const existing = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return { available: !existing };
  }

  async setUsername(
    userId: string,
    username: string,
    pendingEmail: string | null = null,
  ): Promise<{ user: Record<string, unknown>; isNewUser: boolean }> {
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      throw new BadRequestException('Invalid username format');
    }

    const conflict = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (conflict) {
      throw new ConflictException('Username already taken');
    }

    // Pending user — create new user in DB
    if (userId.startsWith('pending:')) {
      const withoutPrefix = userId.slice('pending:'.length);
      const colonIndex = withoutPrefix.indexOf(':');

      let createData: Record<string, unknown>;
      if (colonIndex === -1) {
        // Telegram: pending:telegramId
        createData = {
          username,
          requiresUsernameSetup: false,
          telegramId: withoutPrefix,
          email: null,
          passwordHash: null,
        };
      } else {
        // OAuth: pending:provider:providerId
        const oauthProvider = withoutPrefix.slice(0, colonIndex);
        const oauthProviderId = withoutPrefix.slice(colonIndex + 1);
        // KS-2786: pendingEmail приходит из pending JWT (см. generatePendingOAuthTokens),
        // содержит email из Google/Facebook profile. Сохраняем его при создании user,
        // чтобы потом сработали link-account и восстановление пароля.
        createData = {
          username,
          requiresUsernameSetup: false,
          oauthProvider,
          oauthProviderId,
          email: pendingEmail,
          passwordHash: null,
        };
      }

      const userSelect = {
        id: true,
        username: true,
        email: true,
        requiresUsernameSetup: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
        createdAt: true,
      } as const;

      try {
        const user = await this.prisma.user.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: createData as any,
          select: userSelect,
        });
        // KS-4205 §10 #11. Новый username → новая публичная страница
        // тренера. Старого username здесь нет — это первичная установка.
        this.prerender.enqueueFireAndForget({ kind: 'coach', username });
        return { user: user as Record<string, unknown>, isNewUser: true };
      } catch (err: unknown) {
        // KS-2786: race-condition — между OAuth callback и set-username
        // (TTL pending JWT до 7 дней) другой юзер мог зарегистрироваться
        // с этим email через /auth/register. На прямой повторный OAuth
        // он бы залинковался по email в findOrCreateOAuthUser, но pending
        // токен этот шаг проскочил. В таком случае создаём юзера без email,
        // чтобы не ронять signup. Email можно будет добавить вручную позже.
        const code = (err as { code?: string })?.code;
        const meta = (err as { meta?: { target?: string | string[] } })?.meta;
        const target = Array.isArray(meta?.target) ? meta?.target : [meta?.target];
        if (
          pendingEmail &&
          code === 'P2002' &&
          target?.some((t) => typeof t === 'string' && t.includes('email'))
        ) {
          const user = await this.prisma.user.create({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { ...createData, email: null } as any,
            select: userSelect,
          });
          // KS-4205 §10 #11. Та же первичная установка username
          // (повтор после email-conflict fallback'а).
          this.prerender.enqueueFireAndForget({ kind: 'coach', username });
          return { user: user as Record<string, unknown>, isNewUser: true };
        }
        throw err;
      }
    }

    // Existing user — update
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, requiresUsernameSetup: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    if (!user.requiresUsernameSetup) {
      throw new BadRequestException('Username already set');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { username, requiresUsernameSetup: false },
      select: {
        id: true,
        username: true,
        email: true,
        requiresUsernameSetup: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
        createdAt: true,
      },
    });

    // KS-4205 §10 #11. Существующий pending-user задаёт username
    // впервые. Старого username в этом сценарии тоже нет (метод
    // допускается только при `requiresUsernameSetup=true`), поэтому
    // ставим один enqueue на новый username.
    this.prerender.enqueueFireAndForget({ kind: 'coach', username });

    return { user: updated as Record<string, unknown>, isNewUser: false };
  }

  async getSettings(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.SETTINGS_SELECT,
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    return user;
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto) {
    const data: Record<string, unknown> = {};
    if (dto.locale !== undefined) data.locale = dto.locale;
    if (dto.boardTheme !== undefined) data.boardTheme = dto.boardTheme;
    if (dto.pieceSet !== undefined) data.pieceSet = dto.pieceSet;
    if (dto.soundEnabled !== undefined) data.soundEnabled = dto.soundEnabled;
    if (dto.showBotEngineDebugPanel !== undefined) {
      data.showBotEngineDebugPanel = dto.showBotEngineDebugPanel;
    }

    // KS-4205 §10 #11. Расширяем select на username, чтобы хук
    // мог поставить prerender без второго запроса. Username пилим
    // из response (контракт getSettings не меняется).
    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { ...this.SETTINGS_SELECT, username: true },
    });
    if (user.username) {
      this.prerender.enqueueFireAndForget({
        kind: 'coach',
        username: user.username,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { username: _username, ...response } = user;
    return response;
  }

  async updateExternalAccounts(userId: string, data: Record<string, string | null>) {
    // KS-4205 §10 #11. chesscomUsername/lichessUsername отображаются на
    // публичной странице тренера — перегенерация нужна. Запрашиваем
    // username отдельно (response-контракт не трогаем).
    const result = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { chesscomUsername: true, lichessUsername: true },
    });
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    if (user?.username) {
      this.prerender.enqueueFireAndForget({
        kind: 'coach',
        username: user.username,
      });
    }
    return result;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException(
        this.i18n.t('messages.user.wrongPassword'),
      );
    }

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException(
        this.i18n.t('messages.user.wrongPassword'),
      );
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return { success: true };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
        gamesPlayedBullet: true,
        gamesPlayedBlitz: true,
        gamesPlayedRapid: true,
        gamesPlayedClassical: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    const PROVISIONAL_THRESHOLD = 20;

    return {
      ...user,
      provisionalBullet: user.gamesPlayedBullet < PROVISIONAL_THRESHOLD,
      provisionalBlitz: user.gamesPlayedBlitz < PROVISIONAL_THRESHOLD,
      provisionalRapid: user.gamesPlayedRapid < PROVISIONAL_THRESHOLD,
      provisionalClassical: user.gamesPlayedClassical < PROVISIONAL_THRESHOLD,
    };
  }

  async getRatingHistory(userId: string, category?: string) {
    const where: Record<string, unknown> = { userId };
    if (category && ['bullet', 'blitz', 'rapid', 'classical'].includes(category)) {
      where.category = category;
    }

    const entries = await this.prisma.ratingHistory.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        id: true,
        category: true,
        rating: true,
        gameId: true,
        createdAt: true,
      },
    });

    return {
      data: entries.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  async getPuzzleRushStats(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException(this.i18n.t('messages.user.notFound'));
    }

    const [best3, best5, totalSessions] = await Promise.all([
      this.prisma.puzzleRushScore.findFirst({
        where: { userId, timeMode: '3' },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleRushScore.findFirst({
        where: { userId, timeMode: '5' },
        orderBy: { score: 'desc' },
        select: { score: true },
      }),
      this.prisma.puzzleRushScore.count({
        where: { userId },
      }),
    ]);

    return {
      best3: best3?.score ?? 0,
      best5: best5?.score ?? 0,
      totalSessions,
    };
  }

  async getUserGames(
    userId: string,
    filters: {
      opponent?: string;
      color?: 'white' | 'black';
      result?: 'win' | 'loss' | 'draw';
      eco?: string;
      dateFrom?: string;
      dateTo?: string;
      take?: number;
      skip?: number;
    } = {},
  ) {
    const {
      opponent, color, result, eco, dateFrom, dateTo,
      take = 20, skip = 0,
    } = filters;
    const safeTake = Math.min(take, 50);

    const where: Record<string, any> = { status: 'finished' };

    // Color filter: user played as white or black
    if (color === 'white') {
      where.whiteId = userId;
    } else if (color === 'black') {
      where.blackId = userId;
    } else {
      where.OR = [{ whiteId: userId }, { blackId: userId }];
    }

    // Opponent filter: search by username (case-insensitive)
    if (opponent) {
      const opponentCondition = {
        username: { contains: opponent, mode: 'insensitive' as const },
      };
      if (color === 'white') {
        where.black = opponentCondition;
      } else if (color === 'black') {
        where.white = opponentCondition;
      } else {
        where.AND = [
          {
            OR: [
              { white: opponentCondition },
              { black: opponentCondition },
            ],
          },
        ];
      }
    }

    // Result filter relative to the user
    if (result) {
      if (result === 'draw') {
        where.result = 'draw';
      } else if (result === 'win') {
        const winConditions = [
          { whiteId: userId, result: 'white' },
          { blackId: userId, result: 'black' },
        ];
        where.AND = [...(where.AND || []), { OR: winConditions }];
      } else if (result === 'loss') {
        const lossConditions = [
          { whiteId: userId, result: 'black' },
          { blackId: userId, result: 'white' },
        ];
        where.AND = [...(where.AND || []), { OR: lossConditions }];
      }
    }

    // ECO code filter
    if (eco) {
      where.eco = { startsWith: eco, mode: 'insensitive' };
    }

    // Date range filter
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    const [games, total] = await Promise.all([
      this.prisma.game.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: safeTake,
        skip,
        select: {
          id: true,
          whiteId: true,
          blackId: true,
          result: true,
          termination: true,
          timeControlType: true,
          timeInitialSec: true,
          timeIncrementSec: true,
          eco: true,
          createdAt: true,
          finishedAt: true,
          whiteRatingBefore: true,
          whiteRatingAfter: true,
          blackRatingBefore: true,
          blackRatingAfter: true,
          white: { select: { id: true, username: true } },
          black: { select: { id: true, username: true } },
          moves: {
            orderBy: { moveNumber: 'asc' },
            take: 20,
            select: { san: true },
          },
          _count: { select: { moves: true } },
        },
      }),
      this.prisma.game.count({ where }),
    ]);

    const data = games.map((game) => {
      const isWhite = game.whiteId === userId;
      const playerColor = isWhite ? 'white' : 'black';
      const gameOpponent = isWhite ? game.black : game.white;
      const opponentRatingBefore = isWhite
        ? game.blackRatingBefore
        : game.whiteRatingBefore;

      const sanMoves = game.moves.map((m: { san: string }) => m.san);
      const opening = this.eco.classify(sanMoves);

      let playerResult: 'win' | 'loss' | 'draw' | null;
      if (game.result === null) {
        playerResult = null;
      } else if (game.result === 'draw') {
        playerResult = 'draw';
      } else if (game.result === playerColor) {
        playerResult = 'win';
      } else {
        playerResult = 'loss';
      }

      return {
        id: game.id,
        playerColor,
        playerResult,
        opponent: {
          id: gameOpponent.id,
          username: gameOpponent.username,
          ratingBefore: opponentRatingBefore,
        },
        ecoCode: opening.code,
        openingName: opening.name,
        result: this.formatPlayerResult(playerResult),
        termination: game.termination,
        timeControlType: game.timeControlType,
        timeControl: this.formatTimeControl(game.timeInitialSec, game.timeIncrementSec),
        totalMoves: game._count.moves,
        createdAt: game.createdAt,
        finishedAt: game.finishedAt,
        whiteRatingBefore: game.whiteRatingBefore,
        whiteRatingAfter: game.whiteRatingAfter,
        blackRatingBefore: game.blackRatingBefore,
        blackRatingAfter: game.blackRatingAfter,
      };
    });

    return {
      data,
      total,
      hasMore: skip + safeTake < total,
    };
  }

  private formatPlayerResult(playerResult: 'win' | 'loss' | 'draw' | null): string {
    switch (playerResult) {
      case 'win': return '1-0';
      case 'loss': return '0-1';
      case 'draw': return '1/2-1/2';
      default: return '*';
    }
  }

  private formatTimeControl(initialSec: number, incrementSec: number): string {
    const minutes = Math.floor(initialSec / 60);
    return `${minutes}+${incrementSec}`;
  }

  /**
   * KS-3938 / ADR-118 §2.4.1. Поиск пользователей по username для
   * UI «найти ученика» при добавлении в allowlist restricted-лекции.
   *
   * Контракт:
   *   - `q` — обрезается до `trim()`, при пустой строке возвращаем
   *     `[]` без запроса в БД;
   *   - case-insensitive substring-поиск по username
   *     (`mode: 'insensitive'` в Prisma);
   *   - фильтр служебных аккаунтов: `isBot=false`, `isSynthetic=false`,
   *     `isTestAccount=false`, `isHidden=false` (тот же набор, что
   *     KS-2256 применяет к публичным выдачам);
   *   - sort: username ASC (стабильно для UI);
   *   - limit — управляется вызывающим (controller'ом).
   *
   * Возвращаем `[{ id, username, displayName, avatarUrl? }]`. В схеме
   * User полей `displayName`/`avatarUrl` пока нет — `displayName`
   * падает на `username`, `avatarUrl` — undefined. Когда профили
   * расширятся, маппинг поправится.
   */
  async searchUsers(
    q: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      username: string;
      displayName: string;
      avatarUrl?: string;
    }>
  > {
    const query = (q ?? '').trim();
    if (query.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: {
        username: { contains: query, mode: 'insensitive' },
        isBot: false,
        isSynthetic: false,
        isTestAccount: false,
        isHidden: false,
      },
      orderBy: { username: 'asc' },
      take: limit,
      select: { id: true, username: true },
    });

    return users
      .filter((u) => u.username !== null)
      .map((u) => ({
        id: u.id,
        username: u.username as string,
        displayName: u.username as string,
      }));
  }

  /**
   * KS-3935 / ADR-118 §3.2 cleanup. При удалении пользователя нужно
   * убрать его allowlist-доступы из `lecture_access_grants`: поле
   * `subject_id` хранит UUID полиморфно (для `'user'` — User.id, для
   * `'course'` — Course.id), поэтому FK на User там не стоит и
   * каскадного удаления нет. Чистим обработчиком в коде.
   *
   * Цепочка ADR §2.2:
   *   DELETE FROM lecture_access_grants
   *   WHERE subject_type = 'user' AND subject_id = :userId;
   *
   * Поле `grantedById` к этому случаю не относится — у него есть FK
   * `granted_by_id → users.id ON DELETE CASCADE` (см. KS-3930), его
   * Postgres уберёт сам, когда `prisma.user.delete` снесёт запись
   * пользователя.
   *
   * Метод сделан публичным и отдельным от `delete()`, чтобы в
   * будущем его можно было вызывать из других scenarios очистки
   * (например, soft-delete + last-cleanup job). Возвращает число
   * удалённых grant'ов для аудита.
   */
  async cleanupAccessGrantsForDeletedUser(userId: string): Promise<number> {
    const { count } = await this.prisma.lectureAccessGrant.deleteMany({
      where: { subjectType: 'user', subjectId: userId },
    });
    return count;
  }

  /**
   * KS-3935 / ADR-118 §3.2. Полное удаление пользователя из системы.
   * Шаги:
   *   1. `cleanupAccessGrantsForDeletedUser` — снять все allowlist-
   *      доступы, выданные этому пользователю на чужие лекции
   *      (по `subject_id`, без FK).
   *   2. `prisma.user.delete` — каскадом снимает все остальные
   *      ссылочные данные (lectures с `ownerId=:userId`, grants
   *      с `granted_by_id=:userId`, games, attempts и пр.) согласно
   *      FK ON DELETE CASCADE в schema.prisma.
   *
   * Сейчас метод не привязан к публичному REST-эндпоинту — его
   * вызывают из admin/CLI-скриптов (например, soft-delete cleanup
   * job). Когда появится self-service «удалить аккаунт», обработчик
   * соответствующего контроллера должен звать именно этот метод,
   * а не вызывать `prisma.user.delete` напрямую — иначе access-
   * grants по subject_id зависнут как orphan-записи.
   *
   * @returns число удалённых allowlist-grant'ов (cleanup-step).
   */
  async delete(userId: string): Promise<{ deletedAccessGrants: number }> {
    const deletedAccessGrants = await this.cleanupAccessGrantsForDeletedUser(
      userId,
    );
    await this.prisma.user.delete({ where: { id: userId } });
    return { deletedAccessGrants };
  }
}
