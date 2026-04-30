import {
  Body,
  Controller,
  ForbiddenException,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import * as crypto from 'crypto';
import { SyntheticTokenResponse } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { InternalKeyGuard } from './internal-key.guard';
import { SyntheticTokenDto } from './dto/synthetic-token.dto';

/**
 * KS-2182 (ADR-034-v2 §2.2). Внутренний endpoint выдачи JWT для
 * synthetic-бота. Доступ — за `InternalKeyGuard` (см. этот файл рядом),
 * только из VPC.
 *
 * Контракт:
 *   - Body: `{ botUserId: <uuid> }` (валидируется class-validator'ом).
 *   - Response: `{ accessToken, expiresIn }` — `expiresIn` в секундах.
 *   - 403, если у указанного user'а `isSynthetic = false`. Это критично:
 *     иначе через дыру можно нагенерить JWT для любого user.id (см. ADR
 *     §2.2, "критично — иначе через дыру…").
 *   - 404, если user не существует. Отдельно от 403, чтобы bot-service
 *     отличал «бот удалён из БД» от «попытка эскалации».
 *   - JWT-payload `{sub, username}` — полностью совпадает с обычными
 *     JWT-токенами (`generateTokens` в `AuthService`). Никаких bot-only
 *     флагов (ADR §2.1: «любой bot-only signal в токене проникает в логи
 *     и может быть использован живыми пользователями для детекции»).
 *
 * Логирование (ADR §2.3): без значения токена, только `userId`,
 * `requesterIp`, `tokenHash` (SHA256 свежевыданного access-токена). Это
 * позволяет коррелировать логи bot-service'а с api-логами при подозрении
 * на ошибочную ротацию, не складывая JWT в plaintext.
 *
 * TTL — 15 минут (`JWT_EXPIRES_IN` дефолт, как у живых; ADR §11 п.2).
 */
@Controller('internal/auth')
@UseGuards(InternalKeyGuard)
export class InternalAuthController {
  private readonly logger = new Logger(InternalAuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post('synthetic-token')
  async issueSyntheticToken(
    @Body() dto: SyntheticTokenDto,
    @Req() req: Request,
  ): Promise<SyntheticTokenResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.botUserId },
      select: { id: true, username: true, isSynthetic: true },
    });

    const requesterIp = readClientIp(req);

    if (!user) {
      this.logger.warn(
        `synthetic-token: user not found userId=${dto.botUserId} ip=${requesterIp}`,
      );
      throw new NotFoundException('User not found');
    }

    if (!user.isSynthetic) {
      this.logger.warn(
        `synthetic-token: refused for non-synthetic user userId=${user.id} ip=${requesterIp} reason=isSynthetic=false`,
      );
      throw new ForbiddenException('User is not synthetic');
    }

    const expiresInSec = parseExpiresInSeconds(
      this.config.get<string>('JWT_EXPIRES_IN', '15m'),
    );

    const accessToken = this.jwtService.sign(
      { sub: user.id, username: user.username },
      { expiresIn: expiresInSec },
    );

    const tokenHash = sha256(accessToken);
    this.logger.log(
      `synthetic-token: issued userId=${user.id} ip=${requesterIp} tokenHash=${tokenHash} expiresIn=${expiresInSec}`,
    );

    return { accessToken, expiresIn: expiresInSec };
  }
}

function readClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip ?? 'unknown';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Парсит `JWT_EXPIRES_IN` ('15m', '900s', '1h', число) в секунды.
 * Endpoint должен вернуть `expiresIn: number` — bot-service ставит TTL
 * Redis-кэша на (expiresIn − 120) сек.
 */
export function parseExpiresInSeconds(value: string | number): number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    // Не парсится — fallback на 15 минут (как дефолт ADR).
    return 900;
  }
  const num = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor =
    unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return num * factor;
}
