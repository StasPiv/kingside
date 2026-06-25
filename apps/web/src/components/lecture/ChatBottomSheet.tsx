import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * KS-4009 / ADR-121 Phase 1 §3.2. Мобильная шторка чата лекции.
 *
 * Три точки открытия:
 *   - `collapsed` — закрыта (компонент рендерится, но скрыт; сохраняем
 *     state, чтобы при повторном открытии не пересчитывать всё).
 *   - `compact` — 40% высоты экрана (≈300 px), доска сверху видна,
 *     можно читать сообщения, не уходя со страницы.
 *   - `full` — 85% высоты экрана (≈600 px), доска скрыта под шторкой.
 *
 * Жесты:
 *   - Свайп вниз с handle (полоска сверху) — переход на следующую
 *     ниже точку (full→compact→collapsed). Порог 40 px.
 *   - Свайп вверх — наверх (compact→full).
 *   - Tap на handle — переключает compact↔full.
 *   - Tap на backdrop (виден только в full) — collapsed.
 *
 * Шторка живёт «поверх доски»: position:fixed снизу, доска под ней
 * остаётся интерактивной в compact-режиме.
 */

export type ChatBottomSheetMode = 'collapsed' | 'compact' | 'full';

const HEIGHT_BY_MODE: Record<ChatBottomSheetMode, string> = {
  collapsed: '0vh',
  compact: '40vh',
  full: '85vh',
};

const SWIPE_THRESHOLD_PX = 40;

export interface ChatBottomSheetProps {
  /** Текущее состояние шторки. */
  mode: ChatBottomSheetMode;
  /** Сменить состояние шторки. */
  onModeChange: (mode: ChatBottomSheetMode) => void;
  /** Контент — обычно `<LectureChatPanel … />`. */
  children: React.ReactNode;
}

export function ChatBottomSheet({
  mode,
  onModeChange,
  children,
}: ChatBottomSheetProps) {
  const { t } = useTranslation();
  const touchStartYRef = useRef<number | null>(null);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);

  // ── Жесты на handle ─────────────────────────────────────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
    setDragOffsetPx(0);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const start = touchStartYRef.current;
    if (start === null) return;
    const dy = (e.touches[0]?.clientY ?? start) - start;
    // Только вниз даём «тащить» (вверх ловим как переход в full).
    if (dy > 0) setDragOffsetPx(dy);
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchStartYRef.current;
      touchStartYRef.current = null;
      setDragOffsetPx(0);
      if (start === null) return;
      const dy = (e.changedTouches[0]?.clientY ?? start) - start;
      if (Math.abs(dy) < SWIPE_THRESHOLD_PX) return;
      if (dy > 0) {
        // Вниз: на ступеньку ниже.
        if (mode === 'full') onModeChange('compact');
        else if (mode === 'compact') onModeChange('collapsed');
      } else {
        // Вверх: на ступеньку выше.
        if (mode === 'compact') onModeChange('full');
        else if (mode === 'collapsed') onModeChange('compact');
      }
    },
    [mode, onModeChange],
  );

  const handleHandleClick = useCallback(() => {
    if (mode === 'compact') onModeChange('full');
    else if (mode === 'full') onModeChange('compact');
    else onModeChange('compact');
  }, [mode, onModeChange]);

  // ── Esc закрывает шторку ────────────────────────────────────────────
  useEffect(() => {
    if (mode === 'collapsed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onModeChange('collapsed');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, onModeChange]);

  const isOpen = mode !== 'collapsed';

  return (
    <>
      {/* Backdrop только для full-режима */}
      {mode === 'full' && (
        <div
          data-testid="chat-bottom-sheet-backdrop"
          onClick={() => onModeChange('collapsed')}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.3)',
            zIndex: 998,
          }}
        />
      )}
      <div
        data-testid="chat-bottom-sheet"
        data-mode={mode}
        role="dialog"
        aria-label={t('lectureChat.title', 'Lecture chat')}
        aria-hidden={!isOpen}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          height: HEIGHT_BY_MODE[mode],
          transform: `translateY(${dragOffsetPx}px)`,
          transition:
            touchStartYRef.current === null
              ? 'height 0.2s ease, transform 0.2s ease'
              : 'none',
          background: '#fff',
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          boxShadow: '0 -2px 12px rgba(0,0,0,0.15)',
          zIndex: 999,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
      >
        <div
          data-testid="chat-bottom-sheet-handle"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onClick={handleHandleClick}
          role="button"
          tabIndex={0}
          aria-label={t('lectureChat.handleAria', 'Resize chat')}
          style={{
            padding: '8px 0 4px',
            cursor: 'grab',
            touchAction: 'none',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <span
            style={{
              width: 40,
              height: 4,
              background: '#ccc',
              borderRadius: 2,
            }}
          />
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: '0 8px 8px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Контент рендерим всегда (не размонтируем при collapsed) — */}
          {/* иначе разлогинятся сокеты подписки и lost-state. */}
          {children}
        </div>
      </div>
    </>
  );
}
