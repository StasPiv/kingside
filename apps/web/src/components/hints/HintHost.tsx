import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import ReactDOM from 'react-dom';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  arrow,
} from '@floating-ui/react';
import type { Placement } from '@floating-ui/react';
import type { HintShowPayload } from '@kingside/shared';
import { useAuth } from '../../context/AuthContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { isAnalyticsConsentGiven } from '../../lib/events';
import { messagesSocket } from '../../socket';
import { useHintPull } from '../../hooks/useHintPull';
import { sendHintLifecycle } from './hintsApi';
import type { UserWithConsent } from '../cookie-banner/consentTypes';

/**
 * KS-4703 / ADR-147 §4. Глобальный хост контекстных подсказок.
 *
 * Источники:
 *   - **Авторизованный** — WS `hint:show` через `messagesSocket`
 *     (room `user:<id>`, KS-4701).
 *   - **Гость** — pull `GET /hints/pending` каждые 15с + внеочередные
 *     запросы при page_view и idle 30с (см. `useHintPull`). Без cookie
 *     `analytics_consent=1` pull выключен.
 *
 * Один активный hint за раз — новый replace'ит старый.
 * Lifecycle: shown → (dismissed | acted | ignored) через
 * `POST /hints/:hintId/{kind}`.
 */
export function HintHost(): ReactElement | null {
  const { user, token } = useAuth();
  const isAuthorized = Boolean(user);
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
  // KS-4737. messagesSocket — глобальный, шарится с MessagesPage,
  // PlayPage, GamePage, FriendsPage через useLazySocket. Когда любой
  // из них unmount'ится, useLazySocket вызывает s.disconnect() →
  // HintHost остаётся подписан на 'hint:show', но socket disconnected
  // и backend emit в room user:<id> уходит в пустоту. Фиксим: на
  // событие 'disconnect' переподключаемся (с тем же handshake-auth),
  // чтобы room user:<id> заново join'нулся на серверной стороне.
  useEffect(() => {
    if (!isAuthorized || !token) return;
    messagesSocket.auth = { token };
    const ensureConnected = () => {
      if (!messagesSocket.connected) messagesSocket.connect();
    };
    ensureConnected();
    const onConnect = () => {
      // eslint-disable-next-line no-console
      console.warn('[HintHost] WS /messages connected, room user:<id> joined');
    };
    const onDisconnect = (reason: string) => {
      // eslint-disable-next-line no-console
      console.warn('[HintHost] WS /messages disconnected:', reason, '— reconnecting');
      // Небольшая задержка чтобы не толкать reconnect сразу после
      // намеренного disconnect от useLazySocket cleanup.
      setTimeout(ensureConnected, 100);
    };
    const onShow = (payload: HintShowPayload) => {
      // eslint-disable-next-line no-console
      console.warn('[HintHost] hint:show received', payload);
      setHint(payload);
    };
    messagesSocket.on('connect', onConnect);
    messagesSocket.on('disconnect', onDisconnect);
    messagesSocket.on('hint:show', onShow);
    return () => {
      messagesSocket.off('connect', onConnect);
      messagesSocket.off('disconnect', onDisconnect);
      messagesSocket.off('hint:show', onShow);
      // Не дисконнектим — сокет может быть нужен другим страницам.
    };
  }, [isAuthorized, token]);

  // При переходе guest→user или logout сбрасываем активный hint.
  useEffect(() => {
    setHint(null);
  }, [isAuthorized]);

  const handleClose = useCallback(
    (kind: 'dismissed' | 'acted' | 'ignored', reason?: 'close_button' | 'cta_clicked' | 'ttl_expired') => {
      if (!hint) return;
      void sendHintLifecycle({
        hintId: hint.hintId,
        kind,
        reason: reason ?? null,
        token,
      });
      setHint(null);
    },
    [hint, token],
  );

  if (!hint) return null;
  if (!consentGiven) return null;

  return (
    <HintRenderer
      key={hint.hintId}
      hint={hint}
      token={token}
      onClose={handleClose}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

interface RendererProps {
  hint: HintShowPayload;
  token: string | null;
  onClose: (
    kind: 'dismissed' | 'acted' | 'ignored',
    reason?: 'close_button' | 'cta_clicked' | 'ttl_expired',
  ) => void;
}

function HintRenderer({ hint, token, onClose }: RendererProps): ReactElement | null {
  const isMobile = useIsMobile();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const noAnchorFiredRef = useRef(false);
  const shownFiredRef = useRef(false);

  // Поиск anchor в DOM. Делается синхронно после первого render'а, чтобы
  // ushevcli заглавный DOM был готов.
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-hint-anchor="${hint.anchor}"]`,
    );
    setAnchorEl(el);
    if (!el && !noAnchorFiredRef.current) {
      noAnchorFiredRef.current = true;
      // KS-4737: явно диагностируем разрыв «backend прислал hint, но
      // anchor не нашёлся на странице» — частая причина «не показалась
      // подсказка» (anchor только в условно-рендеримом блоке, либо
      // пользователь dismissed его, либо не на той странице).
      // eslint-disable-next-line no-console
      console.warn(
        '[HintHost] no anchor on page for hint:',
        hint.anchor,
        '— sending ignored{no_anchor}',
      );
      void sendHintLifecycle({
        hintId: hint.hintId,
        kind: 'ignored',
        reason: 'no_anchor',
        token,
      });
    } else if (el) {
      // eslint-disable-next-line no-console
      console.warn('[HintHost] anchor resolved:', hint.anchor, el);
    }
  }, [hint.anchor, hint.hintId, token]);

  // POST shown — один раз после успешного render.
  useEffect(() => {
    if (!anchorEl) return;
    if (shownFiredRef.current) return;
    shownFiredRef.current = true;
    void sendHintLifecycle({
      hintId: hint.hintId,
      kind: 'shown',
      reason: null,
      token,
    });
  }, [anchorEl, hint.hintId, token]);

  // Auto-close по ttlSec.
  useEffect(() => {
    if (!anchorEl) return;
    if (!hint.ttlSec || hint.ttlSec <= 0) return;
    const id = setTimeout(() => {
      onClose('ignored', 'ttl_expired');
    }, hint.ttlSec * 1000);
    return () => clearTimeout(id);
  }, [anchorEl, hint.ttlSec, onClose]);

  const handleDismiss = useCallback(() => {
    onClose('dismissed', 'close_button');
  }, [onClose]);

  const handleCta = useCallback(() => {
    if (hint.ctaHref) {
      // Внутренний переход через history — у нас SPA. Простой
      // window.location.assign — нечасто, но надёжнее: на этапе T9 не
      // тянем `useNavigate` сюда (родитель — App).
      window.location.assign(hint.ctaHref);
    } else if (hint.ctaEvent) {
      // Кастомный DOM-event — слушатель в нужном компоненте.
      window.dispatchEvent(
        new CustomEvent('kingside:hint-cta', {
          detail: { event: hint.ctaEvent, hintId: hint.hintId },
        }),
      );
    }
    onClose('acted', 'cta_clicked');
  }, [hint.ctaHref, hint.ctaEvent, hint.hintId, onClose]);

  if (!anchorEl) return null;

  if (isMobile) {
    return (
      <HintBottomSheet
        hint={hint}
        anchorEl={anchorEl}
        onDismiss={handleDismiss}
        onCta={handleCta}
      />
    );
  }
  return (
    <HintPopover
      hint={hint}
      anchorEl={anchorEl}
      onDismiss={handleDismiss}
      onCta={handleCta}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Desktop popover                                                     */
/* ------------------------------------------------------------------ */

interface PaneProps {
  hint: HintShowPayload;
  anchorEl: HTMLElement;
  onDismiss: () => void;
  onCta: () => void;
}

// KS-4720. Сторона popover'а, противоположная placement — там
// «прикрепляется» стрелка к anchor.
const ARROW_OPPOSITE_SIDE: Record<string, 'top' | 'bottom' | 'left' | 'right'> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};
const ARROW_SIZE = 8;

function HintPopover({ hint, anchorEl, onDismiss, onCta }: PaneProps): ReactElement {
  const floatingPlacement = mapPlacement(hint.placement);
  const arrowRef = useRef<HTMLDivElement | null>(null);
  // KS-4708/KS-4720: возвращаем computed `placement` из @floating-ui —
  // после flip() он может отличаться от `floatingPlacement`. Стрелка
  // позиционируется через arrow() middleware (KS-4720), координаты
  // приходят в middlewareData.arrow.
  const { refs, floatingStyles, placement, middlewareData } = useFloating({
    open: true,
    placement: floatingPlacement,
    middleware: [
      offset(ARROW_SIZE + 4),
      flip(),
      shift({ padding: 8 }),
      arrow({ element: arrowRef, padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    refs.setReference(anchorEl);
  }, [anchorEl, refs]);

  // @floating-ui возвращает placement вида `top-start` / `bottom-end`.
  // Стрелка нужна по основной стороне, поэтому отрезаем модификатор.
  const sidePlacement = placement.split('-')[0];
  const arrowOpposite = ARROW_OPPOSITE_SIDE[sidePlacement] ?? 'top';
  // Координаты от arrow middleware: одна из x/y — число, другая undefined.
  const arrowX = middlewareData.arrow?.x;
  const arrowY = middlewareData.arrow?.y;
  // Размещаем стрелку: примерно вписана в popover, центр выровнен по
  // anchor (arrowX/arrowY от middleware). По «противоположной» стороне
  // выезд на половину размера, чтобы получилась треугольная вершина.
  const arrowStyle: React.CSSProperties = {
    position: 'absolute',
    width: ARROW_SIZE * 2,
    height: ARROW_SIZE * 2,
    background: 'inherit',
    transform: 'rotate(45deg)',
    pointerEvents: 'none',
    ...(arrowX != null ? { left: arrowX } : {}),
    ...(arrowY != null ? { top: arrowY } : {}),
    [arrowOpposite]: -ARROW_SIZE,
  };

  return ReactDOM.createPortal(
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className="hint-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`hint-${hint.hintId}-title`}
      data-testid="hint-popover"
      data-placement={sidePlacement}
      data-hint-popover
      data-hint-key={hint.key}
    >
      <div className="hint-popover__header">
        <h3 id={`hint-${hint.hintId}-title`} className="hint-popover__title">
          {hint.title}
        </h3>
        <button
          type="button"
          aria-label="Close"
          className="hint-popover__close"
          onClick={onDismiss}
          data-testid="hint-popover-close"
        >
          ×
        </button>
      </div>
      <p className="hint-popover__body">{hint.body}</p>
      {hint.ctaLabel && (
        <button
          type="button"
          className="hint-popover__cta"
          onClick={onCta}
          data-testid="hint-popover-cta"
        >
          {hint.ctaLabel}
        </button>
      )}
      {/* KS-4720: треугольная стрелка к anchor. Координаты от
          @floating-ui/arrow(); background: inherit, чтобы цвет совпал с
          popover'ом; layout (hints.css) при желании может уточнить
          border/shadow по `data-placement`. */}
      <div
        ref={arrowRef}
        className="hint-popover__arrow"
        data-placement={sidePlacement}
        data-testid="hint-popover-arrow"
        style={arrowStyle}
        aria-hidden="true"
      />
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Mobile bottom-sheet + anchor highlight                              */
/* ------------------------------------------------------------------ */

function HintBottomSheet({ hint, anchorEl, onDismiss, onCta }: PaneProps): ReactElement {
  // Подсветка anchor: накладываем абсолютно позиционированный outline
  // поверх anchor. Координаты подтягиваем на каждом скролле/ресайзе.
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const update = () => setRect(anchorEl.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl]);

  return ReactDOM.createPortal(
    <>
      {rect && (
        <div
          className="hint-anchor-highlight"
          data-testid="hint-anchor-highlight"
          /* KS-4708: только позиционирование в inline — оно зависит от
             runtime-координат anchor. Цвет/толщина/радиус обводки
             заданы в hints.css (KS-4705) через токен `--accent-primary`,
             чтобы соответствовать индиго-палитре сайта. */
          style={{
            position: 'fixed',
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            pointerEvents: 'none',
            zIndex: 9998,
          }}
        />
      )}
      <div
        className="hint-bottom-sheet"
        role="dialog"
        aria-modal="false"
        aria-labelledby={`hint-${hint.hintId}-title-m`}
        data-testid="hint-bottom-sheet"
        data-hint-popover
        data-hint-key={hint.key}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          paddingBottom: 'env(safe-area-inset-bottom)',
          zIndex: 9999,
        }}
      >
        <div className="hint-bottom-sheet__inner">
          <div className="hint-bottom-sheet__header">
            <h3
              id={`hint-${hint.hintId}-title-m`}
              className="hint-bottom-sheet__title"
            >
              {hint.title}
            </h3>
            <button
              type="button"
              aria-label="Close"
              className="hint-bottom-sheet__close"
              onClick={onDismiss}
              data-testid="hint-bottom-sheet-close"
            >
              ×
            </button>
          </div>
          <p className="hint-bottom-sheet__body">{hint.body}</p>
          {hint.ctaLabel && (
            <button
              type="button"
              className="hint-bottom-sheet__cta"
              onClick={onCta}
              data-testid="hint-bottom-sheet-cta"
            >
              {hint.ctaLabel}
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * `HintPlacement` из shared расширен значениями `overlay` /
 * `bottom-sheet`, которых нет в `@floating-ui/react`. Для них берём
 * fallback `bottom`. На mobile эти значения вообще не нужны
 * (используется HintBottomSheet).
 */
function mapPlacement(p: HintShowPayload['placement']): Placement {
  switch (p) {
    case 'top':
    case 'bottom':
    case 'left':
    case 'right':
      return p;
    case 'overlay':
    case 'bottom-sheet':
    default:
      return 'bottom';
  }
}
