import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GameStatus } from './GameShell';

/**
 * KS-4290 / ADR-134 §2: единый sticky-ряд действий партии для мобильной
 * вёрстки страницы игры (≤899px). На desktop ≥900px компонент не
 * рендерится (его не подключают в GameShell, плюс CSS-правило
 * `.game-action-bar { display: none }` страхует от ошибочного монтажа).
 *
 * Контекстный по статусу партии:
 *  - `waiting` (поиск соперника, pre-game): резерв под одну primary-
 *    кнопку «Отменить поиск». В этой задаче не материализуется (страница
 *    игры открывается уже на `active`); место заложено, наполнение
 *    делается в KS-4293.
 *  - `active`: четыре кнопки — «Сдаться», «Ничья», «Чат», «Ещё». «Чат»
 *    и «Ещё» сейчас пробрасывают наружу `onChatClick`/`onMoreClick`,
 *    но если соответствующий handler не передан — рендерится disabled-
 *    плейсхолдер, чтобы геометрия (4 равных кнопки) не менялась между
 *    задачами серии (KS-4292 chat-sheet, KS-4294 resign confirm).
 *  - `finished`: pill «Партия завершена ▲» во всю ширину. По клику
 *    раскрывает контролируемый `GameResultSheet` через
 *    `onExpandResult`.
 *
 * Меню «Ещё» — простой dropdown в первом проходе (полноценный bottom-
 * sheet — потенциально отдельной задачей, см. описание KS-4290). Пункты:
 *  - звук (mute/unmute);
 *  - подсказка/help — пробрасывается прокси-функцией если есть;
 *  - возврат в лобби — `react-router-dom` Link через коллбэк.
 *
 * Ширина:
 *  - 320-359px: режим icons-only (без лейбла под иконкой);
 *  - 360-899px: иконка + короткий лейбл.
 */

export interface GameActionBarProps {
  status: GameStatus;
  /** Может ли игрок сейчас сдаться (status='active' + есть колбэк). */
  canResign: boolean;
  onResign?: () => void;
  /** Предложение ничьей доступно: статус active + не идёт уже открытое предложение. */
  canOfferDraw: boolean;
  onOfferDraw?: () => void;
  /** Открыть чат — bottom-sheet, KS-4292. Если не передан — кнопка disabled. */
  onChatClick?: () => void;
  /**
   * KS-4293 (ADR-134 §4): число непрочитанных сообщений; рисуется
   * бейджем над иконкой «💬». 0/undefined — бейдж скрыт. >99 —
   * показывается «99+».
   */
  chatUnreadCount?: number;
  /** Звук партии (mute/unmute). */
  muted: boolean;
  onToggleMute: () => void;
  /** Возврат в лобби — пункт меню «Ещё». */
  onBackToLobby?: () => void;
  /**
   * KS-4295 (ADR-134 §9). Пункт «Помощь» в меню «⋮ Ещё». Если не
   * передан — пункт не рендерится. На mobile это единственный путь
   * к справке: настольная `.help-btn` скрыта CSS-правилом.
   */
  onHelp?: () => void;
  /**
   * KS-4288 интеграция: pill свёрнутого `<GameResultSheet>`. Если в момент
   * `status='finished'` родитель хочет показать в action-bar полоску
   * «Партия завершена ▲» — он передаёт `resultPillLabel` и
   * `onExpandResult`. По клику action-bar вызывает `onExpandResult`, и
   * `GameResultSheet` разворачивается обратно из collapsed в expanded.
   */
  resultPillLabel?: string;
  onExpandResult?: () => void;
  /**
   * KS-4292 (ADR-134 §6). В ветке `status='waiting'` рендерится
   * primary-кнопка «Отменить поиск». Если коллбэк не передан —
   * waiting-ветка остаётся пустым spacer'ом (как было заложено в
   * KS-4290).
   */
  onCancelSearch?: () => void;
}

const RESIGN_CONFIRM_WINDOW_MS = 2000;

export function GameActionBar({
  status,
  canResign,
  onResign,
  canOfferDraw,
  onOfferDraw,
  onChatClick,
  muted,
  onToggleMute,
  onBackToLobby,
  resultPillLabel,
  onExpandResult,
  onCancelSearch,
  chatUnreadCount = 0,
  onHelp,
}: GameActionBarProps) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  // KS-4294 / ADR-134 §7: двухтаповое подтверждение «Сдаться».
  // Первый тап ставит `resignArmed=true` и таймер 2 с на сброс.
  // Второй тап в окне — реально вызывает `onResign`. Если 2 с
  // прошли без второго тапа, состояние сбрасывается — нужен снова
  // первый тап.
  const [resignArmed, setResignArmed] = useState(false);
  const resignTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearResignTimer = () => {
    if (resignTimerRef.current) {
      clearTimeout(resignTimerRef.current);
      resignTimerRef.current = null;
    }
  };
  // Сброс при unmount и при смене статуса (если партия закончилась,
  // armed-состояние не должно «висеть» до следующей партии).
  useEffect(() => {
    return () => {
      clearResignTimer();
    };
  }, []);
  useEffect(() => {
    if (status !== 'active') {
      clearResignTimer();
      setResignArmed(false);
    }
  }, [status]);

  const handleResignClick = () => {
    if (!onResign) return;
    if (resignArmed) {
      clearResignTimer();
      setResignArmed(false);
      onResign();
      return;
    }
    setResignArmed(true);
    clearResignTimer();
    resignTimerRef.current = setTimeout(() => {
      setResignArmed(false);
      resignTimerRef.current = null;
    }, RESIGN_CONFIRM_WINDOW_MS);
  };

  useEffect(() => {
    if (!moreOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!moreRef.current) return;
      if (!moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [moreOpen]);

  if (status === 'finished') {
    return (
      <div className="game-action-bar game-action-bar--finished" data-testid="game-action-bar">
        {resultPillLabel && onExpandResult ? (
          <button
            type="button"
            className="game-action-bar__pill"
            data-testid="game-action-bar-result-pill"
            onClick={onExpandResult}
          >
            {resultPillLabel} ▲
          </button>
        ) : null}
      </div>
    );
  }

  if (status === 'waiting') {
    // KS-4292 / ADR-134 §6: primary-кнопка «Отменить поиск» во всю
    // ширину. Если коллбэк не передан — остаёмся пустым spacer'ом,
    // как было заложено в KS-4290 (например, страница `/play/local-bot`,
    // где «поиска соперника» нет).
    return (
      <div
        className="game-action-bar game-action-bar--waiting"
        data-testid="game-action-bar"
        aria-hidden={!onCancelSearch}
      >
        {onCancelSearch && (
          <button
            type="button"
            className="game-action-bar__pill game-action-bar__pill--danger"
            data-testid="game-action-bar-cancel-search"
            onClick={onCancelSearch}
          >
            {t('game.cancelSearch', 'Cancel search')}
          </button>
        )}
      </div>
    );
  }

  // status === 'active'
  return (
    <div className="game-action-bar game-action-bar--active" data-testid="game-action-bar">
      <button
        type="button"
        className={`game-action-bar__btn${resignArmed ? ' game-action-bar__btn--armed' : ''}`}
        data-testid="game-action-bar-resign"
        data-armed={resignArmed ? 'true' : undefined}
        onClick={handleResignClick}
        disabled={!canResign || !onResign}
        aria-label={
          resignArmed
            ? t('game.confirmResign', 'Confirm resign')
            : t('game.resign', 'Resign')
        }
      >
        <span className="game-action-bar__icon" aria-hidden="true">🏳</span>
        <span className="game-action-bar__label">
          {resignArmed
            ? t('game.confirm', 'Confirm?')
            : t('game.resign', 'Resign')}
        </span>
      </button>
      <button
        type="button"
        className="game-action-bar__btn"
        data-testid="game-action-bar-draw"
        onClick={onOfferDraw}
        disabled={!canOfferDraw || !onOfferDraw}
        aria-label={t('game.offerDraw', 'Offer draw')}
      >
        <span className="game-action-bar__icon" aria-hidden="true">½</span>
        <span className="game-action-bar__label">{t('game.offerDraw', 'Draw')}</span>
      </button>
      <button
        type="button"
        className="game-action-bar__btn"
        data-testid="game-action-bar-chat"
        onClick={onChatClick}
        disabled={!onChatClick}
        aria-label={t('game.chat', 'Chat')}
      >
        <span className="game-action-bar__icon-wrap">
          <span className="game-action-bar__icon" aria-hidden="true">💬</span>
          {chatUnreadCount > 0 && (
            <span
              className="game-action-bar__badge"
              data-testid="game-action-bar-chat-badge"
            >
              {chatUnreadCount > 99 ? '99+' : chatUnreadCount}
            </span>
          )}
        </span>
        <span className="game-action-bar__label">{t('game.chat', 'Chat')}</span>
      </button>
      <div className="game-action-bar__more-wrap" ref={moreRef}>
        <button
          type="button"
          className="game-action-bar__btn"
          data-testid="game-action-bar-more"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          aria-label={t('game.more', 'More')}
        >
          <span className="game-action-bar__icon" aria-hidden="true">⋮</span>
          <span className="game-action-bar__label">{t('game.more', 'More')}</span>
        </button>
        {moreOpen && (
          <div
            className="game-action-bar__more-menu"
            role="menu"
            data-testid="game-action-bar-more-menu"
          >
            <button
              type="button"
              role="menuitem"
              className="game-action-bar__more-item"
              data-testid="game-action-bar-mute"
              onClick={() => {
                onToggleMute();
                setMoreOpen(false);
              }}
            >
              <span aria-hidden="true">{muted ? '🔇' : '🔊'}</span>
              <span>
                {muted ? t('game.unmute', 'Unmute') : t('game.mute', 'Mute')}
              </span>
            </button>
            {onHelp && (
              <button
                type="button"
                role="menuitem"
                className="game-action-bar__more-item"
                data-testid="game-action-bar-help"
                onClick={() => {
                  onHelp();
                  setMoreOpen(false);
                }}
              >
                <span aria-hidden="true">?</span>
                <span>{t('common.help', 'Help')}</span>
              </button>
            )}
            {onBackToLobby && (
              <button
                type="button"
                role="menuitem"
                className="game-action-bar__more-item"
                data-testid="game-action-bar-lobby"
                onClick={() => {
                  onBackToLobby();
                  setMoreOpen(false);
                }}
              >
                <span aria-hidden="true">←</span>
                <span>{t('game.backToLobby', 'Back to lobby')}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
