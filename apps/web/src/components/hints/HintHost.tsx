import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import { useLocation } from 'react-router-dom';
import { isQuietPage, type HintShowPayload } from '@kingside/shared';
import { useAuth } from '../../context/AuthContext';
import { isAnalyticsConsentGiven } from '../../lib/events';
import { messagesSocket } from '../../socket';
import { useHintPull } from '../../hooks/useHintPull';
import { useLazySocket } from '../../hooks/useLazySocket';
import { useInfoBar } from '../info-bar/InfoBar';
import { sendHintLifecycle } from './hintsApi';
import type { UserWithConsent } from '../cookie-banner/consentTypes';

/**
 * KS-4703 / ADR-147 §4 + KS-4815. Глобальный хост контекстных подсказок.
 *
 * Источники:
 *   - **Авторизованный** — WS `hint:show` через `messagesSocket`
 *     (room `user:<id>`, KS-4701).
 *   - **Гость** — pull `GET /hints/pending` каждые 15с + внеочередные
 *     запросы при page_view и idle 30с (см. `useHintPull`). Без cookie
 *     `analytics_consent=1` pull выключен.
 *
 * KS-4815: рендер anchor-less. Активная подсказка пушится в общую
 * `<InfoBar />` под header'ом — без floating-ui, без DOM-поиска anchor'а,
 * без MutationObserver. Поле `anchor` в payload приходит, но фронт его
 * игнорирует (схема БД сохранена для обратной совместимости и для
 * админ-аналитики).
 *
 * Один активный hint за раз — новый replace'ит старый.
 * Lifecycle: shown → (dismissed | acted | ignored) через
 * `POST /hints/:hintId/{kind}`.
 */
export function HintHost(): ReactElement | null {
  const { user, token } = useAuth();
  const isAuthorized = Boolean(user);
  const { push: pushInfoBar, clear: clearInfoBar } = useInfoBar();
  // KS-4718: реагируем на смену consent (event из CookieBanner) — без
  // bump'а useMemo не пересчитается до reload, и pull-loop для гостя
  // никогда не стартует после accept.
  const [consentBump, setConsentBump] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChange = () => setConsentBump((b) => b + 1);
    window.addEventListener('kingside:consent-changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('kingside:consent-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  const consentGiven = useMemo(
    () => isAnalyticsConsentGiven(user as UserWithConsent | null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, consentBump],
  );
  const [hint, setHint] = useState<HintShowPayload | null>(null);

  // Гость поллит pending; user — WS.
  useHintPull({
    enabled: !isAuthorized && consentGiven,
    onHint: setHint,
  });

  // WS для авторизованного.
  // KS-4805 / ADR-153 §2.1. HintHost — perm-owner messagesSocket в
  // течение всей авторизованной сессии. useLazySocket с refcount
  // гарантирует, что socket остаётся connected, даже когда
  // PlayPage/MessagesPage/FriendsPage/GamePage mount/unmount — их ref
  // меняет refcount, но никогда не достигает нуля, пока HintHost
  // держит ref. Room `user:<id>` непрерывно жива → backend
  // `emitHintShow` доставляется live.
  useLazySocket(messagesSocket);

  useEffect(() => {
    if (!isAuthorized || !token) return;
    const onShow = (payload: HintShowPayload) => {
      // eslint-disable-next-line no-console
      console.warn('[HintHost] hint:show received', payload);
      setHint(payload);
    };
    messagesSocket.on('hint:show', onShow);
    return () => {
      messagesSocket.off('hint:show', onShow);
    };
  }, [isAuthorized, token]);

  // При переходе guest→user или logout сбрасываем активный hint.
  useEffect(() => {
    setHint(null);
  }, [isAuthorized]);

  // KS-4813 / ADR-153 §2.4. SPA-навигация на «тихую» страницу
  // (`/live/*`, `/broadcast/*`, `/lecture/:id`, `/admin/*`) при
  // активной подсказке — отменяем её c `ignored{quiet_page}`. Бэкенд
  // тоже отсекает quiet-page до DSL (HintsService.checkFor), но
  // активный hint, оставшийся с предыдущего route, нужно убрать руками.
  const { pathname } = useLocation();
  useEffect(() => {
    if (!hint) return;
    if (!isQuietPage(pathname)) return;
    void sendHintLifecycle({
      hintId: hint.hintId,
      kind: 'ignored',
      reason: 'quiet_page',
      token,
    });
    setHint(null);
  }, [pathname, hint, token]);

  // KS-4815. Закрытие подсказки — общий путь для крестика / CTA / TTL /
  // программного сброса.
  const finish = useCallback(
    (
      kind: 'dismissed' | 'acted' | 'ignored',
      reason: 'close_button' | 'cta_clicked' | 'ttl_expired' | null,
    ) => {
      if (!hint) return;
      void sendHintLifecycle({
        hintId: hint.hintId,
        kind,
        reason,
        token,
      });
      setHint(null);
    },
    [hint, token],
  );

  // CTA: внутренний переход через href (SPA hard-redirect остаётся как
  // раньше — родитель HintHost'а живёт outside Router'а для самых ранних
  // случаев), либо dispatch CustomEvent для in-page handler'ов.
  const handleCta = useCallback(() => {
    if (!hint) return;
    if (hint.ctaHref) {
      window.location.assign(hint.ctaHref);
    } else if (hint.ctaEvent) {
      window.dispatchEvent(
        new CustomEvent('kingside:hint-cta', {
          detail: { event: hint.ctaEvent, hintId: hint.hintId },
        }),
      );
    }
    finish('acted', 'cta_clicked');
  }, [hint, finish]);

  const handleDismiss = useCallback(() => {
    finish('dismissed', 'close_button');
  }, [finish]);

  // KS-4815. Пуш активной подсказки в общий InfoBar. POST shown — один
  // раз на каждый hint (по `hint.hintId` зависимости эффект сработает
  // на каждой новой подсказке). Очистка InfoBar при cleanup безопасна:
  // `clear(id)` снимает запись только если id совпадает с текущей.
  useEffect(() => {
    if (!hint || !consentGiven) return;
    pushInfoBar({
      id: hint.hintId,
      title: hint.title,
      body: hint.body,
      cta: hint.ctaLabel
        ? { label: hint.ctaLabel, onClick: handleCta }
        : undefined,
      onDismiss: handleDismiss,
      testid: 'hint-info-bar',
      dataAttrs: { 'data-hint-key': hint.key, 'data-hint-popover': '' },
    });
    void sendHintLifecycle({
      hintId: hint.hintId,
      kind: 'shown',
      reason: null,
      token,
    });
    return () => {
      clearInfoBar(hint.hintId);
    };
  }, [
    hint,
    consentGiven,
    token,
    pushInfoBar,
    clearInfoBar,
    handleCta,
    handleDismiss,
  ]);

  // TTL: авто-ignored через `ttlSec` секунд.
  useEffect(() => {
    if (!hint || !hint.ttlSec || hint.ttlSec <= 0) return;
    const id = setTimeout(() => {
      finish('ignored', 'ttl_expired');
    }, hint.ttlSec * 1000);
    return () => clearTimeout(id);
  }, [hint, finish]);

  // KS-4815. HintHost больше не рендерит UI напрямую — он publisher
  // для `<InfoBar />`, который сам стоит в `<MainLayout />`.
  return null;
}
