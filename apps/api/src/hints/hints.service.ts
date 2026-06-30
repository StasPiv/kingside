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
  isQuietPage as sharedIsAlwaysQuietPage,
  quietPagePatternToRegex,
  applyTemplate,
} from '@kingside/shared';
import type { Actor } from '../events/events.types';
import { EventsService } from '../events/events.service';
import { EventsPrismaService } from '../events/events-prisma.service';
import { MessageGateway } from '../message/message.gateway';
import { HintsLimitsService } from './hints-limits.service';
import { HintsMetricsService } from './hints-metrics.service';
import { evaluateRule } from './hints-dsl.evaluator';
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

      // 6.1 Payload — собираем СНАЧАЛА, чтобы записать готовый snapshot
      // в `actor_hint_states.last_shown_payload` (KS-4825 / ADR-154 §2.2).
      // KS-4825 / ADR-154 §2.1: server-side подстановка `{{var}}` в
      // `ctaHref` / `ctaLabel` / `instructionBody` из payload триггера.
      // Клиент шаблонов не знает — получает готовые значения.
      const rawPayload = toShowPayload(winner, locale);
      const cta = (winner.cta ?? null) as { fallbackHref?: string | null } | null;
      const payload = applyTemplate(
        rawPayload,
        {
          triggerEventType: ctx.triggerEventType,
          triggerEventPayload: ctx.triggerEventPayload ?? undefined,
        },
        cta?.fallbackHref ?? null,
      );

      // 6.2 Upsert state. KS-4825 / ADR-154 §2.2: snapshot готового
      // payload для корректного replay-on-connect (ADR-151) — клиент
      // на reconnect получит ТОТ ЖЕ payload, что упустил.
      await owner.actorHintState.upsert({
        where: { actorId_hintId: { actorId: actor.id, hintId: winner.id } },
        create: {
          actorId: actor.id,
          actorType: actor.type,
          hintId: winner.id,
          shownCount: 1,
          lastShownAt: now,
          lastShownPayload: payload as unknown as Prisma.JsonObject,
        },
        update: {
          shownCount: { increment: 1 },
          lastShownAt: now,
          lastShownPayload: payload as unknown as Prisma.JsonObject,
        },
      });
      await this.limits.markShown(actor);

      // 7. WS-emit для авторизованных. Для guest payload уже лёг в
      // `hints:pending:<guest_id>` через `HintsListener` — дублировать
      // не нужно.
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
   * KS-4788 / ADR-151 §3. Реплей контекстной подсказки при WS-handshake.
   *
   * НЕ оценивает DSL, НЕ применяет canShow/markShown, НЕ правит state —
   * чистая выборка из ActorHintState с фильтрами:
   *   - `lastShownAt > now - replayWindowSec` (свежее окна);
   *   - `dismissedAt IS NULL`, `actedAt IS NULL` (пользователь не закрыл);
   *   - `shownAckAt IS NULL OR shownAckAt < lastShownAt` (нет client-ack
   *     на последний emit);
   *   - `hint.enabled = true AND deletedAt IS NULL` (правило не выключено
   *     админом между emit и replay).
   *
   * Идемпотентен: при multi-tab / multi-handshake до первого ack клиента
   * срабатывает каждый раз (frontend `<HintHost>` дедупит по hintId).
   *
   * Возвращает массив payload'ов (0 или 1). Caller — MessageGateway —
   * эмитит их через `emitHintShow(userId, payload)`.
   */
  async replayPending(
    actor: Actor,
    locale: HintLocale = 'ru',
  ): Promise<HintShowPayload[]> {
    this.metrics.replayAttempts.inc({ actor_type: actor.type });

    const { enabled, replayWindowSec } = this.limits.getLimits();
    if (!enabled) {
      this.metrics.replaySkipped.inc({ actor_type: actor.type, reason: 'killswitch_off' });
      return [];
    }
    if (!replayWindowSec || replayWindowSec <= 0) {
      this.metrics.replaySkipped.inc({ actor_type: actor.type, reason: 'replay_off' });
      return [];
    }

    const owner = this.prismaSvc.getOwner();
    if (!owner) return [];

    const since = new Date(Date.now() - replayWindowSec * 1000);

    try {
      // `shownAckAt < lastShownAt` Prisma не выражает column-to-column,
      // отбираем кандидатов по простым фильтрам + post-фильтр в коде.
      // Per-actor строк мало (десятки max), цена post-фильтра нулевая.
      const candidates = await owner.actorHintState.findMany({
        where: {
          actorId: actor.id,
          actorType: actor.type,
          lastShownAt: { gt: since },
          dismissedAt: null,
          actedAt: null,
        },
        include: {
          hint: {
            select: {
              id: true,
              key: true,
              i18n: true,
              cta: true,
              anchor: true,
              placement: true,
              ttlSec: true,
              enabled: true,
              deletedAt: true,
            },
          },
        },
        orderBy: { lastShownAt: 'desc' },
      });

      if (candidates.length === 0) {
        this.metrics.replaySkipped.inc({ actor_type: actor.type, reason: 'no_candidate' });
        return [];
      }

      for (const s of candidates) {
        if (!s.hint || !s.hint.enabled || s.hint.deletedAt) {
          continue;
        }
        if (s.shownAckAt && s.lastShownAt && s.shownAckAt >= s.lastShownAt) {
          continue;
        }
        // KS-4825 / ADR-154 §2.2: snapshot готового payload имеет
        // приоритет — он содержит уже подставленные `{{var}}` из
        // триггерующего события. Без snapshot'а (строки до миграции,
        // или primary emit прошёл на pre-ADR-154 коде) — fallback на
        // пересборку из `Hint` без подстановки. На практике такие
        // строки старше `replayWindowSec` и сюда не доходят.
        const snapshot = s.lastShownPayload as HintShowPayload | null | undefined;
        const payload = snapshot ?? toShowPayload(s.hint, locale);
        this.metrics.replayEmitted.inc({ actor_type: actor.type });
        return [payload];
      }

      // Все кандидаты отфильтрованы — самый частый кейс «уже ack-нул».
      this.metrics.replaySkipped.inc({ actor_type: actor.type, reason: 'already_acked' });
      return [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`replayPending ${actor.type}:${actor.id}: ${msg}`);
      return [];
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

/**
 * KS-4810 / ADR-153 §2.4. Бэк опирается на общий с фронтом matcher
 * `quietPagePatternToRegex` из `@kingside/shared`, чтобы pattern'ы
 * (`/live/*`, `/lecture/:id`, ...) трактовались одинаково на обеих
 * сторонах. Локальный backend-`globMatch` для этой ветки больше не
 * нужен (`*` → `.+`, `:name` → `[^/]+`, а не один сегмент без `:`).
 *
 * Ветка `low-time-focus` остаётся backend-локальной: фронт не знает про
 * `ctx.clockLowTimeFocus`, поэтому shared `isQuietPage(pathname)`
 * покрывает только `condition='always'`. Здесь мы доп. шагом проверяем
 * pattern'ы с `condition='low-time-focus'` через общий matcher.
 *
 * Export сделан для юнит-теста; внутри модуля используется как
 * локальная функция в `checkFor`.
 */
export function isQuietPage(ctx: HintCheckContext): boolean {
  if (!ctx.page) return false;
  // Hot-path: always-quiet — один вызов общего предиката.
  if (sharedIsAlwaysQuietPage(ctx.page)) return true;
  // Slow-path: pattern'ы с condition='low-time-focus' — только если
  // активен соответствующий сигнал из game/clock.
  if (ctx.clockLowTimeFocus) {
    for (const q of HINT_QUIET_PAGES) {
      if (q.condition !== 'low-time-focus') continue;
      if (quietPagePatternToRegex(q.pattern).test(ctx.page)) return true;
    }
  }
  return false;
}

// Экспорт для unit-тестов (см. `hints.service.spec.ts` — KS-4823).
// Internal use из `HintsService.checkFor` сохраняется.
export function toShowPayload(
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
    // KS-4823. Опциональный расширенный блок инструкции (popover
    // «Подробнее»). `null` если в локали не задан.
    instructionBody: entry.instructionBody ?? null,
    ctaHref: cta?.href ?? null,
    ctaEvent: cta?.event ?? null,
    anchor: hint.anchor as HintAnchor,
    placement: hint.placement as HintPlacement,
    ttlSec: hint.ttlSec,
  };
}
