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
} from '@floating-ui/react';
import type { Placement } from '@floating-ui/react';
import type { HintShowPayload } from '@kingside/shared';
import { useAuth } from '../../context/AuthContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { readAnalyticsConsentCookie } from '../../lib/events';
import { messagesSocket } from '../../socket';
import { useHintPull } from '../../hooks/useHintPull';
import { sendHintLifecycle } from './hintsApi';

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
  const consentGiven = useMemo(
    () => Boolean(user) || readAnalyticsConsentCookie(),
    [user],
  );
  const [hint, setHint] = useState<HintShowPayload | null>(null);

  // Гость поллит pending; user — WS.
  useHintPull({
    enabled: !isAuthorized && consentGiven,
    onHint: setHint,
  });

  // WS для авторизованного.
  useEffect(() => {
    if (!isAuthorized || !token) return;
    messagesSocket.auth = { token };
    if (!messagesSocket.connected) messagesSocket.connect();
    const onShow = (payload: HintShowPayload) => {
      setHint(payload);
    };
    messagesSocket.on('hint:show', onShow);
    return () => {
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
      void sendHintLifecycle({
        hintId: hint.hintId,
        kind: 'ignored',
        reason: 'no_anchor',
        token,
      });
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

function HintPopover({ hint, anchorEl, onDismiss, onCta }: PaneProps): ReactElement {
  const floatingPlacement = mapPlacement(hint.placement);
  // KS-4708: возвращаем computed `placement` из @floating-ui — после flip()
  // он может отличаться от `floatingPlacement` (например, top → bottom при
  // нехватке места). Layout (KS-4705/hints.css) рисует стрелку по
  // `data-placement` атрибуту, нам нужен именно фактический.
  const { refs, floatingStyles, placement } = useFloating({
    open: true,
    placement: floatingPlacement,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    refs.setReference(anchorEl);
  }, [anchorEl, refs]);

  // @floating-ui возвращает placement вида `top-start` / `bottom-end`.
  // Стрелка нужна по основной стороне, поэтому отрезаем модификатор.
  const sidePlacement = placement.split('-')[0];

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
