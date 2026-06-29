/**
 * KS-4699 / ADR-147 §3 + §4. HintsEngine — основная точка входа
 * `checkFor(actor, ctx)`. Реактивно вызывается из HintsListener на
 * ключевые события (game_end / puzzle_failed / page_view и т.д.) и
 * напрямую из транспорта T8 при pull-запросах гостя.
 *
 * Pipeline:
 *   0. Гейт consent: `EventsService.hasConsent(actor)` — без согласия
 *      возвращаем null (правила не оцениваются).
 *   1. Гейт killswitch + quiet-pages: `HintsLimitsService.getLimits().enabled`,
 *      `HINT_QUIET_PAGES` (если `condition='always'` или с low-time-focus
 *      сигналом).
 *   2. Загрузка enabled+!deletedAt hints, фильтр по `targetActorTypes`.
 *   3. Для каждого: оценка DSL → отброс non-matching. Загрузка
 *      ActorHintState батчем (одним SELECT по actorId+hintId IN ...).
 *      Отброс `suppressedUntil>now`, `shownCount>=maxShows`,
 *      `dismissedAt within cooldownSec`.
 *   4. Глобальные лимиты (throttle/session/day) — `canShow(actor)`.
 *   5. Сортировка по `priority desc, createdAt asc`, берём верхний.
 *   6. Запись/upsert ActorHintState (shownCount++, lastShownAt=now);
 *      `markShown(actor)` для счётчика сессии.
 *   7. Возврат HintShowPayload по shared-контракту (T7).
 *
 * Возврат null при любой ошибке — fail-soft. Метрика длительности
 * пишется всегда.
 */
import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import type { PrismaClient as EventsPrismaClient, Prisma } from '@kingside/events-db';
import {
  HINT_QUIET_PAGES,
  HintShowPayload,
  HintAnchor,
  HintPlacement,
  HintLocale,
} from '@kingside/shared';
import type { Actor } from '../events/events.types';
import { EventsService } from '../events/events.service';
import { EventsPrismaService } from '../events/events-prisma.service';
import { MessageGateway } from '../message/message.gateway';
import { HintsLimitsService } from './hints-limits.service';
import { HintsMetricsService } from './hints-metrics.service';
import { evaluateRule, globMatch } from './hints-dsl.evaluator';
import type { HintCheckContext, HintI18nEntry, HintCtaPayload } from './hints.types';

@Injectable()
export class HintsService {
  private readonly logger = new Logger(HintsService.name);

  constructor(
    private readonly prismaSvc: EventsPrismaService,
    private readonly events: EventsService,
    private readonly limits: HintsLimitsService,
    private readonly metrics: HintsMetricsService,
    // KS-4701: WS-emit hint:show для user-actor. `@Optional` — spec-
    // фикстуры конструируют service без MessageGateway.
    // KS-4785: forwardRef обязателен — циклический DI HintsService ⇄
    // MessageGateway. MessageModule импортирует HintsModule через
    // `forwardRef`, и тут на параметре тоже нужен `@Inject(forwardRef(…))`,
    // иначе Nest резолвит токен MessageGateway в момент конструирования
    // HintsService — а на этой стадии MessageModule ещё не дореализовался,
    // и `@Optional()` подставляет undefined (gateway=no в логах). Без
    // gateway emitHintShow никогда не вызывается → popover не доходит
    // даже до пустой room.
    @Optional() @Inject(forwardRef(() => MessageGateway))
    private readonly gateway?: MessageGateway,
  ) {}

  /**
   * Возвращает HintShowPayload или null. Не бросает.
   */
  async checkFor(
    actor: Actor,
    ctx: HintCheckContext,
    locale: HintLocale = 'ru',
  ): Promise<HintShowPayload | null> {
    const stop = this.metrics.startCheck(actor.type);
    try {
      // 0. Consent.
      if (!(await this.events.hasConsent(actor))) {
        this.logger.debug?.(`checkFor skip: no-consent actor=${actor.type}:${actor.id}`);
        return null;
      }

      // 1. Killswitch + quiet pages.
      const limits = this.limits.getLimits();
      if (!limits.enabled) {
        this.logger.debug?.(`checkFor skip: killswitch off`);
        return null;
      }
      if (ctx.page && isQuietPage(ctx)) {
        this.logger.debug?.(`checkFor skip: quiet-page page=${ctx.page}`);
        return null;
      }

      const owner = this.prismaSvc.getOwner();
      if (!owner) return null;

      // 2. Загрузка кандидатов.
      const allHints = await owner.hint.findMany({
        where: {
          enabled: true,
          deletedAt: null,
          // Фильтр targetActorTypes на стороне БД — Postgres array op
          // `has` (Prisma): targetActorTypes содержит actor.type.
          targetActorTypes: { has: actor.type },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });
      if (allHints.length === 0) return null;

      // 3+4. Эвалюация. Останавливаемся на первом, прошедшем все фильтры.
      const states = await owner.actorHintState.findMany({
        where: { actorId: actor.id, hintId: { in: allHints.map((h) => h.id) } },
      });
      const stateByHint = new Map(states.map((s) => [s.hintId, s]));
      const now = new Date();

      let winner: typeof allHints[number] | null = null;
      for (const hint of allHints) {
        // Per-hint лимиты.
        const st = stateByHint.get(hint.id);
        if (st) {
          if (st.suppressedUntil && st.suppressedUntil > now) continue;
          if (st.shownCount >= hint.maxShows) continue;
          if (
            st.dismissedAt
            && now.getTime() - st.dismissedAt.getTime() < hint.cooldownSec * 1000
          ) {
            continue;
          }
        }
        // DSL.
        const matched = await evaluateRule(hint.rule as unknown, actor, ctx, {
          events: owner,
          startAggregate: (layer) => this.metrics.startAggregateQuery(layer),
        });
        if (!matched) continue;
        winner = hint;
        break;
      }
      if (!winner) return null;

      // 5. Глобальные лимиты — pessimistic lock (throttle ставится сразу).
      if (!(await this.limits.canShow(actor))) return null;

      // 6. Upsert state.
      await owner.actorHintState.upsert({
        where: { actorId_hintId: { actorId: actor.id, hintId: winner.id } },
        create: {
          actorId: actor.id,
          actorType: actor.type,
          hintId: winner.id,
          shownCount: 1,
          lastShownAt: now,
        },
        update: {
          shownCount: { increment: 1 },
          lastShownAt: now,
        },
      });
      await this.limits.markShown(actor);

      // 7. Payload.
      const payload = toShowPayload(winner, locale);

      // KS-4701 / ADR-147 §4.1: WS-emit для авторизованных. Для guest
      // payload уже лёг в `hints:pending:<guest_id>` (HintsListener) —
      // здесь дублировать не нужно.
      if (actor.type === 'user' && this.gateway) {
        try {
          this.gateway.emitHintShow(actor.id, payload);
        } catch (err) {
          // WS-emit fail-soft: даже если сокет упал, ActorHintState
          // уже зафиксировал show — payload вернётся при следующем
          // (или caller сможет логировать факт).
          this.logger.warn(`emitHintShow failed for user=${actor.id}: ${(err as Error).message}`);
        }
      }

      return payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`checkFor ${actor.type}:${actor.id}: ${msg}`);
      return null;
    } finally {
      stop();
    }
  }

  /**
   * Smart-dismiss observer (§5.1): когда приходит событие, тип которого
   * есть в `Hint.acceptedBy` любой активной (показанной, не actedAt)
   * подсказки этого actor'а — выставляем `actedAt=now`.
   */
  async handleSmartDismiss(actor: Actor, eventType: string): Promise<void> {
    const owner = this.prismaSvc.getOwner();
    if (!owner) return;
    const windowH = this.limits.getLimits().smartDismissWindowH;
    const windowMs = windowH * 3_600_000;
    const now = new Date();
    try {
      // Кандидаты: где acceptedBy содержит eventType (Prisma array `has`).
      const candidates = await owner.hint.findMany({
        where: { acceptedBy: { has: eventType }, enabled: true, deletedAt: null },
        select: { id: true },
      });
      if (candidates.length === 0) return;
      const states = await owner.actorHintState.findMany({
        where: {
          actorId: actor.id,
          hintId: { in: candidates.map((c) => c.id) },
          actedAt: null,
          dismissedAt: null,
          lastShownAt: { gte: new Date(now.getTime() - windowMs) },
        },
        select: { hintId: true },
      });
      if (states.length === 0) return;
      await owner.actorHintState.updateMany({
        where: {
          actorId: actor.id,
          hintId: { in: states.map((s) => s.hintId) },
        },
        data: { actedAt: now, suppressedUntil: new Date(now.getTime() + 365 * 86_400_000) },
      });
    } catch (err) {
      // smart-dismiss best-effort.
      this.logger.debug?.(`handleSmartDismiss: ${(err as Error).message}`);
    }
  }
}

/* ─── helpers ─────────────────────────────────────────────────── */

function isQuietPage(ctx: HintCheckContext): boolean {
  if (!ctx.page) return false;
  for (const q of HINT_QUIET_PAGES) {
    if (!globMatch(q.pattern, ctx.page)) continue;
    if (q.condition === 'always') return true;
    if (q.condition === 'low-time-focus' && ctx.clockLowTimeFocus) return true;
  }
  return false;
}

function toShowPayload(
  hint: {
    id: string;
    key: string;
    i18n: Prisma.JsonValue;
    cta: Prisma.JsonValue | null;
    anchor: string;
    placement: string;
    ttlSec: number;
  },
  locale: HintLocale,
): HintShowPayload {
  const i18nObj = (hint.i18n ?? {}) as Record<string, HintI18nEntry | undefined>;
  // Fallback на ru при отсутствии локали; пустые строки если совсем нет.
  const entry: HintI18nEntry =
    i18nObj[locale] ?? i18nObj.ru ?? i18nObj.en ?? { title: '', body: '' };
  const cta = (hint.cta ?? null) as HintCtaPayload | null;
  return {
    hintId: hint.id,
    key: hint.key,
    locale,
    title: entry.title ?? '',
    body: entry.body ?? '',
    ctaLabel: entry.ctaLabel ?? null,
    ctaHref: cta?.href ?? null,
    ctaEvent: cta?.event ?? null,
    anchor: hint.anchor as HintAnchor,
    placement: hint.placement as HintPlacement,
    ttlSec: hint.ttlSec,
  };
}
