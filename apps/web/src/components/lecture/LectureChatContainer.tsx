import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { useTranslation } from 'react-i18next';
import { useLectureChatSocket } from '../../hooks/useLectureChatSocket';
import { LectureChatPanel } from './LectureChatPanel';
import { ChatBadgeIndicator } from './ChatBadgeIndicator';
import { ChatBottomSheet, type ChatBottomSheetMode } from './ChatBottomSheet';

/**
 * KS-4009 / ADR-121 Phase 1 §3, §5, §6. Контейнер чата лекции —
 * единая точка интеграции для AnalysisPage (тренер) и
 * LiveAnalysisViewerPage (зритель/аноним).
 *
 * Обязанности:
 *   1. Вызвать `useLectureChatSocket` (подписка + отправка).
 *   2. На десктопе рендерить `<LectureChatPanel>` фиксированной
 *      колонкой справа снизу с кнопкой-свёрткой.
 *   3. На мобильном рендерить inline-значок (без жёсткого
 *      позиционирования — родитель ставит его в нужное место полосы
 *      бейджей лекции) + нижнюю шторку `<ChatBottomSheet>`.
 *   4. Считать «непрочитанные» — растёт пока шторка/desktop-панель
 *      не открыты. При открытии — обнуляется (`lastSeenIndex` ставится
 *      на длину ленты).
 *   5. Передать корректный `mode` ('owner' / 'viewer' / 'anonymous')
 *      и `currentUserId` дочерней панели.
 *
 * Принципы:
 *   - Контейнер сам ничего не знает про текущее окружение страницы
 *     (кроме сокета и lectureId). Owner-/viewer-/anon-различия
 *     приходят сверху.
 *   - Десктоп vs мобильный определяем CSS-media query через
 *     `matchMedia('(max-width: 768px)')`.
 *   - На размонтировании контейнер не отписывается от сокета явно —
 *     `useLectureChatSocket` сам уберёт listener'ы.
 *
 * KS-4011. Раньше на мобильном значок чата позиционировался через
 * `position: fixed; top: 8; right: 8`, если родитель не передал
 * `renderBadge`. Этот fallback перекрывался верхней навигацией сайта
 * и оказывался невидим — пользователь не видел чат у зрителя на
 * `/live/:slug`. Теперь контейнер на мобильном возвращает inline-
 * значок без позиционирования (родитель `LectureBadgesBlock` сам
 * ставит контейнер рядом с `LectureAudioListenerCompact` /
 * `LectureRecordingBadge`, и значок оказывается в общей горизонтальной
 * полосе). Render-prop `renderBadge` удалён как избыточный.
 */

export interface LectureChatContainerProps {
  /** ID активной лекции; `null` — контейнер рендерит null. */
  lectureId: string | null | undefined;
  /** Сокет `/live-analysis`, обычно глобальный `liveAnalysisSocket`. */
  socket: Socket;
  /** true — текущий пользователь владелец лекции (тренер). */
  isOwner: boolean;
  /** ID текущего пользователя или null для анонима. */
  currentUserId: string | null;
}

function useIsMobile(): boolean {
  // SSR-safe: на первом рендере считаем desktop, на маунте корректируем.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 768px)');
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Chrome ≥ 14 / Safari 14+ поддерживают addEventListener; на старых
    // — fallback на addListener (deprecated).
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);
  return isMobile;
}

export function LectureChatContainer({
  lectureId,
  socket,
  isOwner,
  currentUserId,
}: LectureChatContainerProps) {
  const { t } = useTranslation();
  const chat = useLectureChatSocket({ lectureId, socket });
  const isMobile = useIsMobile();
  const [sheetMode, setSheetMode] = useState<ChatBottomSheetMode>('collapsed');
  const [lastSeenIndex, setLastSeenIndex] = useState(0);

  // Когда чат «виден» (desktop-панель ИЛИ shторка в compact/full на
  // мобильном) — обновляем lastSeenIndex до конца ленты, счётчик
  // обнуляется.
  const isChatVisible = !isMobile || sheetMode !== 'collapsed';
  useEffect(() => {
    if (!isChatVisible) return;
    setLastSeenIndex(chat.messages.length);
  }, [isChatVisible, chat.messages.length]);

  const unreadCount = useMemo(
    () => Math.max(0, chat.messages.length - lastSeenIndex),
    [chat.messages.length, lastSeenIndex],
  );

  const mode: 'owner' | 'viewer' | 'anonymous' = isOwner
    ? 'owner'
    : currentUserId
    ? 'viewer'
    : 'anonymous';

  const openSheet = useCallback(() => setSheetMode('compact'), []);

  if (!lectureId) return null;

  const panel = (
    <LectureChatPanel
      messages={chat.messages}
      mutedSelf={chat.mutedSelf}
      loadingSnapshot={chat.loadingSnapshot}
      lastError={chat.lastError}
      mode={mode}
      currentUserId={currentUserId}
      onSend={chat.sendMessage}
      onDelete={chat.deleteMessage}
      onMute={chat.muteUser}
      onClearError={chat.clearError}
    />
  );

  if (!isMobile) {
    // ── Desktop: фиксированная колонка чата справа экрана ─────────────
    // ADR-121 §3.1: «фиксированная колонка чата справа». Используем
    // `position: fixed` чтобы не зависеть от flex-структуры родительских
    // страниц (AnalysisPage / LiveAnalysisViewerPage) и не подкручивать
    // их CSS под чат. Сворачиваем через кнопку: collapsed — кружок-значок
    // в углу; open — стандартная панель 320×min(70vh,640). Используем
    // тот же `sheetMode`-state, что и для шторки: 'collapsed' →
    // свёрнуто, 'compact'/'full' → развёрнуто.
    const desktopOpen = sheetMode !== 'collapsed';
    const toggleDesktop = () =>
      setSheetMode(desktopOpen ? 'collapsed' : 'compact');
    if (!desktopOpen) {
      return (
        <button
          type="button"
          data-testid="lecture-chat-desktop-toggle"
          onClick={toggleDesktop}
          aria-label={t('lectureChat.openAria', 'Open lecture chat')}
          style={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 40,
            background: '#1e88e5',
            color: '#fff',
            border: 'none',
            borderRadius: 24,
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span aria-hidden="true">💬</span>
          <span>{t('lectureChat.openLabel', 'Chat')}</span>
          {unreadCount > 0 && (
            <span
              data-testid="lecture-chat-desktop-toggle-count"
              style={{
                background: '#fff',
                color: '#1e88e5',
                borderRadius: 10,
                padding: '0 6px',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      );
    }
    return (
      <aside
        data-testid="lecture-chat-desktop"
        className="lecture-chat-desktop"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          width: 320,
          maxWidth: 'calc(100vw - 32px)',
          height: 'min(70vh, 640px)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 40,
          boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
          borderRadius: 8,
          background: '#fff',
        }}
      >
        <button
          type="button"
          data-testid="lecture-chat-desktop-close"
          onClick={toggleDesktop}
          aria-label={t('lectureChat.collapseAria', 'Collapse chat')}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 1,
            background: 'transparent',
            border: 'none',
            color: '#999',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ×
        </button>
        {panel}
      </aside>
    );
  }

  // ── Mobile: inline-badge + bottom-sheet ──────────────────────────
  // KS-4011. Значок — inline-flex без позиционирования. Родитель
  // (`LectureBadgesBlock`) кладёт контейнер в общую горизонтальную
  // полосу со значками `LectureAudioListenerCompact` /
  // `LectureRecordingBadge`, и кнопка чата оказывается там же. Шторка
  // рендерится отдельным fixed-узлом и приклеена к низу viewport — её
  // позицию родителю задавать не нужно.
  return (
    <>
      <ChatBadgeIndicator
        unreadCount={unreadCount}
        isLive
        onOpen={openSheet}
      />
      <ChatBottomSheet mode={sheetMode} onModeChange={setSheetMode}>
        {panel}
      </ChatBottomSheet>
    </>
  );
}
