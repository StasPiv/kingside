import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  SyntheticPresenceBatchResponse,
  SyntheticUserListItem,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { InternalKeyGuard } from '../auth/internal-key.guard';
import { SyntheticPresenceBatchDto } from './dto/synthetic-presence.dto';

/**
 * KS-2182 (ADR-034-v2 §2, §10.1). Два внутренних endpoint'а для
 * `apps/synthetic-bot-service`:
 *
 *   - `GET /api/internal/synthetic-users` — список synthetic-юзеров
 *     (id, username, рейтинги). Bot-service вызывает на старте task'а,
 *     чтобы знать пул для шардирования (ADR §5.1).
 *   - `POST /api/internal/synthetic-presence` — batch-update `lastSeenAt`
 *     для своих botId. Bot-service пишет presence пакетами (ADR §6.1,
 *     `presence.service.ts` v2).
 *
 * Оба за `InternalKeyGuard`. Оба применяют `WHERE isSynthetic = true` и
 * на выдаче, и на проверке входных userId (см. ADR §2.2: «нельзя через
 * дыру обновить presence обычного пользователя»).
 */
@Controller('internal')
@UseGuards(InternalKeyGuard)
export class InternalUsersController {
  private readonly logger = new Logger(InternalUsersController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('synthetic-users')
  async listSyntheticUsers(): Promise<SyntheticUserListItem[]> {
    // `User.username` в схеме nullable (pending OAuth/Telegram юзеры),
    // но synthetic'и всегда имеют username (генерится seeder'ом).
    // На всякий случай фильтруем null — bot-service'у такие записи не
    // нужны (без username нельзя коннектиться).
    const users = await this.prisma.user.findMany({
      where: { isSynthetic: true, username: { not: null } },
      select: {
        id: true,
        username: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
      },
      orderBy: { username: 'asc' },
    });

    return users
      .filter((u): u is typeof u & { username: string } => u.username !== null)
      .map((u) => ({
        id: u.id,
        username: u.username,
        rating: {
          bullet: u.ratingBullet,
          blitz: u.ratingBlitz,
          rapid: u.ratingRapid,
          classical: u.ratingClassical,
        },
      }));
  }

  @Post('synthetic-presence')
  async updateSyntheticPresence(
    @Body() dto: SyntheticPresenceBatchDto,
    @Req() req: Request,
  ): Promise<SyntheticPresenceBatchResponse> {
    const userIds = dto.updates.map((u) => u.userId);

    // Validate-первым-проходом (ADR-034-v2 GWT-сценарий 5):
    //   "массив из 49 synthetic + 1 обычный → 403, ни одна запись не
    //   обновлена". Делаем pre-check + транзакцию updateMany'ев,
    //   чтобы pre-check был источником истины (race с админ-флипом
    //   isSynthetic в момент batch'а — экзотика, защищаться не от чего:
    //   admin сам ставит флаг, не bot-service).
    const found = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, isSynthetic: true },
    });

    const requesterIp = readClientIp(req);

    if (found.length !== userIds.length) {
      const foundIds = new Set(found.map((u) => u.id));
      const missing = userIds.filter((id) => !foundIds.has(id));
      this.logger.warn(
        `synthetic-presence: refused, ${missing.length} userIds not found ip=${requesterIp}`,
      );
      throw new ForbiddenException(
        'One or more userIds are not synthetic users',
      );
    }

    const nonSynthetic = found.filter((u) => !u.isSynthetic);
    if (nonSynthetic.length > 0) {
      this.logger.warn(
        `synthetic-presence: refused, ${nonSynthetic.length} non-synthetic userIds in batch ip=${requesterIp}`,
      );
      throw new ForbiddenException(
        'One or more userIds are not synthetic users',
      );
    }

    // Все валидны — применяем атомарной транзакцией. Если ошибка
    // на любой строке — откатываемся целиком (ADR §2.2).
    const updated = await this.prisma.$transaction(
      dto.updates.map((u) =>
        this.prisma.user.update({
          where: { id: u.userId },
          data: { lastSeenAt: new Date(u.lastSeenAt) },
          select: { id: true },
        }),
      ),
    );

    this.logger.log(
      `synthetic-presence: updated ${updated.length} ip=${requesterIp}`,
    );

    return { updated: updated.length };
  }
}

function readClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip ?? 'unknown';
}
