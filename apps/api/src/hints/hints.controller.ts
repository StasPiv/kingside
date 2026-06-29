/**
 * KS-4701 / ADR-147 §4.1 + §4.3. Public-эндпоинты для подсказок:
 *
 *   GET  /hints/pending                        — pull для guest.
 *   POST /hints/:hintId/{shown|dismissed|acted|ignored} — lifecycle
 *                                               (user или guest).
 *
 * **Pull для гостя (`GET /hints/pending`)**:
 *   - Guard цепочка `IpRateLimitGuard` + `GuestIdGuard`. Дополнительный
 *     cookie-rate-limit 6/мин — фронт T9 поллит раз в 15с (4/мин),
 *     с запасом на ad-hoc rebursts.
 *   - Атомарный `LPOP` из `hints:pending:<guest_id>` — каждый
 *     запрос забирает следующую подсказку и удаляет её из очереди.
 *     Возвращает массив длиной 0 или 1 (один payload за раз —
 *     стабильнее UX чем «1+N» батч).
 *
 * **Lifecycle (POST /hints/:hintId/<kind>)**:
 *   - Authn: JWT user ИЛИ подписанный guest_id cookie. Без обоих → 401.
 *   - kind ∈ {shown, dismissed, acted, ignored} — отдельные пути,
 *     чтобы не отдавать enum как сегмент URL (читабельность + кэш-
 *     friendly).
 *   - Идемпотентность: повторный shown увеличивает `shownCount` (это
 *     legit — несколько render'ов в SPA-переходах). dismissed/acted
 *     — последний выигрывает.
 *   - Метрики `hints_{shown|acted|dismissed|ignored}_total{key,actor_type}`
 *     инкрементируются на каждый успешный вызов.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IpRateLimitGuard } from '../client-logs/ip-rate-limit.guard';
import type { RequestWithGuest } from '../common/guest-id.middleware';
import { EventsService } from '../events/events.service';
import { EventsPrismaService } from '../events/events-prisma.service';
import { GuestIdGuard } from '../guest/guest-id.guard';
import { RedisService } from '../redis/redis.service';
import { HintLifecycleBodyDto } from './hints-lifecycle.dto';
import { HintsMetricsService } from './hints-metrics.service';
import type { Actor } from '../events/events.types';

const PENDING_KEY_PREFIX = 'hints:pending:';
const PULL_THROTTLE_KEY_PREFIX = 'hints:pull-throttle:';
const PULL_MAX_PER_MIN = 6;

interface JwtPayload {
  sub?: string;
}

@Controller('hints')
export class HintsController {
  private readonly logger = new Logger(HintsController.name);

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: HintsMetricsService,
    private readonly prismaSvc: EventsPrismaService,
    private readonly events: EventsService,
    private readonly jwt: JwtService,
  ) {}

  /* ─── GET /hints/pending (guest) ─────────────────────────── */

  @Get('pending')
  @UseGuards(IpRateLimitGuard, GuestIdGuard)
  async pending(@Req() req: RequestWithGuest): Promise<unknown[]> {
    const guestId = req.guestId!;
    // Cookie-throttle 6/мин. Отдельно от IpRateLimitGuard (тот по
    // X-Forwarded-For — корпоративные NAT'ы могут гонять много
    // гостей с одного IP).
    const allowed = await this.cookieThrottle(guestId);
    if (!allowed) {
      throw new ForbiddenException('hints pull rate-limit: 6 requests/min');
    }
    try {
      const raw = await this.redis.lpop(`${PENDING_KEY_PREFIX}${guestId}`);
      if (!raw) return [];
      try {
        return [JSON.parse(raw) as unknown];
      } catch {
        // Битый JSON в очереди — пропускаем, лог.
        this.logger.warn(`pending guest=${guestId}: malformed json in queue, dropped`);
        return [];
      }
    } catch (err) {
      this.logger.warn(`pending guest=${guestId} LPOP failed: ${(err as Error).message}`);
      return [];
    }
  }

  /* ─── POST /hints/:hintId/{kind} (user или guest) ───────── */

  @Post(':hintId/shown')
  @HttpCode(HttpStatus.NO_CONTENT)
  shown(
    @Param('hintId', new ParseUUIDPipe()) hintId: string,
    @Body() body: HintLifecycleBodyDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.handleLifecycle('shown', hintId, body, req);
  }

  @Post(':hintId/dismissed')
  @HttpCode(HttpStatus.NO_CONTENT)
  dismissed(
    @Param('hintId', new ParseUUIDPipe()) hintId: string,
    @Body() body: HintLifecycleBodyDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.handleLifecycle('dismissed', hintId, body, req);
  }

  @Post(':hintId/acted')
  @HttpCode(HttpStatus.NO_CONTENT)
  acted(
    @Param('hintId', new ParseUUIDPipe()) hintId: string,
    @Body() body: HintLifecycleBodyDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.handleLifecycle('acted', hintId, body, req);
  }

  @Post(':hintId/ignored')
  @HttpCode(HttpStatus.NO_CONTENT)
  ignored(
    @Param('hintId', new ParseUUIDPipe()) hintId: string,
    @Body() body: HintLifecycleBodyDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.handleLifecycle('ignored', hintId, body, req);
  }

  /* ─── helpers ───────────────────────────────────────────── */

  private async handleLifecycle(
    kind: 'shown' | 'dismissed' | 'acted' | 'ignored',
    hintId: string,
    body: HintLifecycleBodyDto,
    req: Request,
  ): Promise<void> {
    const actor = this.resolveActor(req);
    if (!actor) throw new UnauthorizedException();

    // Гейт consent: после отзыва согласия lifecycle-события бессмысленно
    // писать — `actor_hint_states` относится к analytics-данным.
    if (!(await this.events.hasConsent(actor))) {
      // Возвращаем 204 без побочек — фронт не должен спамить ошибками.
      return;
    }

    const owner = this.prismaSvc.getOwner();
    if (!owner) return;

    // Гарантируем что hint существует — иначе 400 (а не FK-error).
    const hint = await owner.hint.findUnique({
      where: { id: hintId },
      select: { id: true, key: true, deletedAt: true },
    });
    if (!hint || hint.deletedAt) {
      throw new BadRequestException(`hint ${hintId} not active`);
    }

    const now = new Date();
    try {
      switch (kind) {
        case 'shown': {
          // KS-4788 / ADR-151 §2.2 + §4.3. `shown` теперь client-ack:
          // пишет ТОЛЬКО shownAckAt + инкремент shownCount. lastShownAt
          // не трогаем — это server-emit поле, его пишет HintsService.checkFor.
          // Если ack пришёл без предшествующего checkFor (ручной POST,
          // аномалия) — lastShownAt останется NULL, replay такую строку
          // не выберет, последствий нет.
          const beforeAck = await owner.actorHintState.findUnique({
            where: { actorId_hintId: { actorId: actor.id, hintId } },
            select: { lastShownAt: true },
          });
          await owner.actorHintState.upsert({
            where: { actorId_hintId: { actorId: actor.id, hintId } },
            create: {
              actorId: actor.id,
              actorType: actor.type,
              hintId,
              shownCount: 1,
              shownAckAt: now,
            },
            update: { shownCount: { increment: 1 }, shownAckAt: now },
          });
          this.metrics.shown.inc({ key: hint.key, actor_type: actor.type });
          // KS-4788 §7. Лаг ack vs emit (только когда есть legit emit).
          if (beforeAck?.lastShownAt) {
            const lagSec = (now.getTime() - beforeAck.lastShownAt.getTime()) / 1000;
            if (lagSec >= 0) {
              this.metrics.shownAckLag.observe({ actor_type: actor.type }, lagSec);
            }
          }
          break;
        }
        case 'dismissed':
          await owner.actorHintState.upsert({
            where: { actorId_hintId: { actorId: actor.id, hintId } },
            create: {
              actorId: actor.id,
              actorType: actor.type,
              hintId,
              dismissedAt: now,
            },
            update: { dismissedAt: now },
          });
          this.metrics.dismissed.inc({ key: hint.key, actor_type: actor.type });
          break;
        case 'acted':
          await owner.actorHintState.upsert({
            where: { actorId_hintId: { actorId: actor.id, hintId } },
            create: {
              actorId: actor.id,
              actorType: actor.type,
              hintId,
              actedAt: now,
              suppressedUntil: new Date(now.getTime() + 365 * 86_400_000),
            },
            update: {
              actedAt: now,
              suppressedUntil: new Date(now.getTime() + 365 * 86_400_000),
            },
          });
          this.metrics.acted.inc({ key: hint.key, actor_type: actor.type });
          break;
        case 'ignored':
          // KS-4788 / ADR-151 §2.2. ttl истёк без действия — клиент
          // подтверждает «видел и не закрыл явно». Пишем shownAckAt
          // (это тоже ack-факт), lastShownAt не трогаем. Раньше
          // (KS-4699 §5.3) писали lastShownAt=now — после ADR-151 это
          // приводило бы к ложному replay-кандидату.
          await owner.actorHintState.upsert({
            where: { actorId_hintId: { actorId: actor.id, hintId } },
            create: {
              actorId: actor.id,
              actorType: actor.type,
              hintId,
              shownAckAt: now,
            },
            update: { shownAckAt: now },
          });
          this.metrics.ignored.inc({ key: hint.key, actor_type: actor.type });
          break;
      }
    } catch (err) {
      this.logger.warn(
        `lifecycle ${kind} hint=${hintId} actor=${actor.type}:${actor.id} failed: ${(err as Error).message}`,
      );
    }
  }

  private resolveActor(req: Request): Actor | null {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      try {
        const payload = this.jwt.decode<JwtPayload>(token);
        if (payload?.sub && !payload.sub.startsWith('pending:')) {
          return { type: 'user', id: payload.sub };
        }
      } catch { /* fall through */ }
    }
    const guestId = (req as RequestWithGuest).guestId;
    if (guestId) return { type: 'guest', id: guestId };
    return null;
  }

  /** Cookie-уровневый throttle 6/мин на pull. */
  private async cookieThrottle(guestId: string): Promise<boolean> {
    try {
      const key = `${PULL_THROTTLE_KEY_PREFIX}${guestId}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, 60);
      return n <= PULL_MAX_PER_MIN;
    } catch {
      // Redis down → fail-open чтобы фронт не залип (события всё равно
      // в очереди не накопятся — pending тоже Redis).
      return true;
    }
  }
}
