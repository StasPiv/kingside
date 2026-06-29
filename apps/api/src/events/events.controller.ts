/**
 * KS-4695 / ADR-147 §2.2. `POST /events` — ingest endpoint фронтенда.
 *
 * Контракт: см. `dto/create-events.dto.ts` (DTO зафиксирован T2,
 * KS-4684, commit 73183b8 — менять без согласования с frontend нельзя).
 *
 * Authn:
 *   - JWT через `Authorization: Bearer <…>` → actor.type='user'.
 *     ВАЛИДАЦИЯ ТОКЕНА не вешается guard'ом: events — лог-канал, не
 *     business-API. Достаточно decode (`jwt.decode`) + проверка
 *     срока — это уже делает существующий LastSeenMiddleware. Здесь
 *     повторяем decode локально, чтобы не звать БД.
 *   - Иначе — `(req as RequestWithGuest).guestId`, который проставил
 *     GuestIdMiddleware при наличии валидного `analytics_consent`.
 *   - Если ни того ни другого нет — события молча отбрасываются
 *     (202 Accepted, response `{accepted:0}`). Это поведение из
 *     ADR §6.2: «без согласия не трекаем», но не 401 — фронт-скрипт
 *     не должен спамить ошибками.
 *
 * IP rate-limit: переиспользуем `IpRateLimitGuard` от `/logs` — он
 * простой и достаточный (10 req/min/ip). Для events можно было бы
 * больший лимит, но 10 batch'ей по 50 событий = 500 событий/мин/ip,
 * что выше `actor_events_ingested_total` p99 одного пользователя.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IpRateLimitGuard } from '../client-logs/ip-rate-limit.guard';
import { RequestWithGuest } from '../common/guest-id.middleware';
import { CreateEventsDto, assertPayloadSizes } from './dto/create-events.dto';
import { EventsService } from './events.service';
import type { Actor } from './events.types';

interface JwtPayload {
  sub?: string;
  exp?: number;
}

@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(
    private readonly events: EventsService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Принимает batch до 50 событий. Возвращает счётчики — для удобства
   * фронта в debug-режиме (он их не использует в продовом коде, но
   * Network-tab отвечает «было дело»).
   */
  @Post()
  @UseGuards(IpRateLimitGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(
    @Body() dto: CreateEventsDto,
    @Req() req: Request,
  ): Promise<{ accepted: number; dropped: number }> {
    try {
      assertPayloadSizes(dto);
    } catch (err) {
      throw new UnprocessableEntityException(
        err instanceof Error ? err.message : 'invalid payload',
      );
    }

    const actor = this.resolveActor(req);

    // KS-4787: диагностический лог входа в ingest. Печатает что
    // фронт реально присылает в `/events`. После закрытия KS-4787 —
    // снести. Префикс `ks-diag` симметричен фронтовому в
    // 027a7296 (frontend), чтобы grep по test-hints логам собирал
    // обе стороны цепочки.
    const types = dto.events.map((e) => e.type).join(',');
    const auth = req.headers.authorization;
    const hasBearer = typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ');
    const actorTag = actor ? `${actor.type}:${actor.id.slice(0, 8)}` : 'none';
    this.logger.log(
      `[ks-diag ingest] count=${dto.events.length} types=${types} bearer=${hasBearer} actor=${actorTag}`,
    );

    if (!actor) {
      // Нет ни JWT, ни guest-id — нет согласия. Drop всё.
      this.logger.log(
        `[ks-diag ingest] DROPPED all ${dto.events.length} events: no actor (bearer=${hasBearer})`,
      );
      return { accepted: 0, dropped: dto.events.length };
    }

    let accepted = 0;
    for (const e of dto.events) {
      const ts = parseTs(e.ts);
      const ok = await this.events.track(actor, e.type, e.payload ?? null, {
        occurredAt: ts,
      });
      if (ok) accepted += 1;
    }
    if (accepted < dto.events.length) {
      this.logger.log(
        `[ks-diag ingest] partial accept=${accepted}/${dto.events.length} actor=${actorTag}`,
      );
    }
    return { accepted, dropped: dto.events.length - accepted };
  }

  private resolveActor(req: Request): Actor | null {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      const payload = this.safeDecodeJwt(token);
      if (payload?.sub && !payload.sub.startsWith('pending:')) {
        // Не проверяем срок: events — лог-канал, не business-API
        // (а истекший токен не должен молча отбрасывать «честное»
        // событие пользователя). Если фронт прислал откровенно
        // битый JWT (нет sub) — fall-through на guest.
        return { type: 'user', id: payload.sub };
      }
    }

    const guestId = (req as RequestWithGuest).guestId;
    if (guestId) return { type: 'guest', id: guestId };

    return null;
  }

  private safeDecodeJwt(token: string): JwtPayload | null {
    try {
      const payload = this.jwt.decode<JwtPayload>(token);
      return payload ?? null;
    } catch {
      return null;
    }
  }
}

function parseTs(value: string): Date | undefined {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
}
