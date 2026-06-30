/**
 * KS-4689 / ADR-147 §4.1 + §4.3 + §5. Контракты payload контекстных
 * подсказок: WS-событие `hint:show` (push для авторизованных, push
 * через pending-очередь для гостей) и REST lifecycle.
 *
 * Используется:
 *   - backend `HintsService` / `MessageGateway` (T8) — формирует
 *     `HintShowPayload` из строки таблицы `hints` для конкретного
 *     actor'а;
 *   - backend `HintsController.lifecycle` (T8) — принимает
 *     `HintLifecyclePayload` от клиента и пишет в `actor_events`
 *     (`hint_shown` / `hint_dismissed` / `hint_acted` / `hint_ignored`)
 *     + обновляет `ActorHintState`;
 *   - frontend `<HintHost>` (T9) — рендерит popover/bottom-sheet
 *     по `HintShowPayload`, шлёт обратно `HintLifecyclePayload`.
 */
import type { HintAnchor } from './hint-anchors.js';

/**
 * Положение popover'а относительно anchor (десктоп). На мобильном
 * (<768px) рендер всегда `bottom-sheet` независимо от значения —
 * адаптация на клиенте (ADR-147 §4.2).
 */
export type HintPlacement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'overlay'
  | 'bottom-sheet';

/**
 * Локали проекта (`i18n` в таблице `hints`). Совпадает с `BlogLocale`
 * (см. `blog.ts`) — общий набор для всего двуязычного контента.
 */
export type HintLocale = 'ru' | 'en';

/**
 * Payload WS-события `hint:show` для авторизованных и тело массива
 * `GET /hints/pending` для гостей (ADR-147 §4.1). Все строки уже
 * локализованы под текущую `actor`-локаль на сервере (поле `i18n` в
 * `Hint.i18n[locale]` сжимается в плоский payload). Клиент НЕ выбирает
 * локаль, не парсит i18n-структуру — это упрощает клиент и переносит
 * локализацию в одно место.
 */
export interface HintShowPayload {
  /** UUID записи `hints.id`. Используется для lifecycle ack
   *  (`HintLifecyclePayload.hintId`). */
  hintId: string;
  /** Стабильный человекочитаемый ключ подсказки (`hints.key`,
   *  напр. `analyze-your-game`). Дублирует `hintId` для аналитики
   *  и для логов: проще читать в Grafana. */
  key: string;
  /** Локаль, в которой пришли тексты (`i18n[locale]`). */
  locale: HintLocale;
  /** Заголовок подсказки. */
  title: string;
  /** Основной текст подсказки. */
  body: string;
  /** Подпись CTA-кнопки. `null` — кнопки нет, подсказка
   *  информационная (закрывается крестиком/ttl). */
  ctaLabel: string | null;
  /**
   * KS-4823. Развёрнутый текст инструкции (показывается клиентом по
   * кнопке «Подробнее» внутри popover). `null` — кнопка не появляется.
   * Берётся из `Hint.i18n[locale].instructionBody`, max 2000 символов
   * на стороне админ-DTO.
   */
  instructionBody: string | null;
  /** Относительный URL внутри SPA для перехода по CTA.
   *  Взаимоисключающее с `ctaEvent`. */
  ctaHref: string | null;
  /** Клиентский event для in-page-действия (напр.
   *  `open_board_settings` → открыть `BoardSettingsModal`).
   *  Взаимоисключающее с `ctaHref`. */
  ctaEvent: string | null;
  /** Ключ DOM-узла, к которому привязывается подсказка
   *  (см. `hint-anchors.ts`). */
  anchor: HintAnchor;
  /** Положение popover'а (десктоп). */
  placement: HintPlacement;
  /**
   * Автозакрытие подсказки на клиенте через N секунд бездействия.
   * `0` — закрывается только вручную (× / CTA). Если ttl истёк без
   * действия — клиент шлёт `HintLifecyclePayload { kind: 'ignored' }`.
   */
  ttlSec: number;
}

/**
 * Тип события жизненного цикла подсказки (ADR-147 §4.3 + §5.3).
 *
 *   - `shown`     — `<HintHost>` успешно отрендерил подсказку (анкор
 *                   найден, popover/sheet смонтирован). Сразу после
 *                   показа.
 *   - `dismissed` — пользователь явно закрыл (×). Запускается
 *                   `cooldownSec` до следующего возможного показа.
 *   - `acted`     — пользователь кликнул CTA (или сработал
 *                   `acceptedBy`-smart-dismiss, см. §5.1).
 *                   `suppressedUntil = now() + 365 days`.
 *   - `ignored`   — `ttlSec` истёк без действия.
 */
export type HintLifecycleKind = 'shown' | 'dismissed' | 'acted' | 'ignored';

/**
 * Причина dismiss (опциональная, заполняется только когда полезна
 * для аналитики и фильтрации; иначе `null`).
 *
 *   - `no_anchor`     — клиент не нашёл DOM-узел с указанным
 *                       `data-hint-anchor` (см. ADR-147 §4.2 п.2).
 *                       Сервер фиксирует и в текущем page-view
 *                       подсказку не повторяет.
 *   - `close_button`  — пользователь нажал крестик.
 *   - `cta_clicked`   — комбинируется с `kind='acted'`, для аналитики
 *                       различия «явно кликнул» vs «smart-dismiss».
 *   - `accepted_by`   — smart-dismiss: после показа произошло событие
 *                       из `Hint.acceptedBy` (`kind='acted'`).

 *   - `ttl_expired`   — для `kind='ignored'` (избыточно, оставлено
 *                       для симметрии форматов лога).
 *   - `quiet_page`    — KS-4806 / ADR-153 §2.4. SPA-навигация увела
 *                       пользователя на «тихую» страницу
 *                       (`isQuietPage(pathname) === true`) до того,
 *                       как `<HintHost>` нашёл anchor. Клиент шлёт
 *                       `kind='ignored', reason='quiet_page'` вместо
 *                       ожидания 30-секундного MutationObserver-таймаута:
 *                       быстрее освобождает session-quota и снижает шум
 *                       метрик `no_anchor`.
 */
export type HintLifecycleReason =
  | 'no_anchor'
  | 'close_button'
  | 'cta_clicked'
  | 'accepted_by'
  | 'ttl_expired'
  | 'quiet_page';

/**
 * Payload, который клиент шлёт серверу при изменении состояния
 * подсказки. На бэке маппится в `actor_events` (типы `hint_shown` /
 * `hint_dismissed` / `hint_acted` / `hint_ignored`) и параллельно
 * обновляет `ActorHintState` (см. ADR-147 §4.3).
 *
 * Контракт REST: `POST /hints/:hintId/lifecycle` для авторизованных
 * (под `JwtAuthGuard`) и `POST /guest/hints/:hintId/lifecycle` для
 * гостей (под `GuestIdGuard` на подписанном cookie). `hintId` в URL
 * и в теле должны совпадать — расхождение → 400 (защита от опечатки
 * клиента и от чужих hint'ов в шумных логах).
 */
export interface HintLifecyclePayload {
  /** UUID `hints.id` — тот же, что в `HintShowPayload.hintId`. */
  hintId: string;
  /** Стадия жизненного цикла. */
  kind: HintLifecycleKind;
  /** Причина (опционально, см. `HintLifecycleReason`). */
  reason: HintLifecycleReason | null;
}
