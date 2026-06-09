import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  LECTURE_CHAT_LIMITS,
  type LectureChatErrorEvent,
  type LectureChatMessage,
} from '@kingside/shared';

/**
 * KS-4009 / ADR-121 Phase 1 §3, §5. Универсальная панель чата
 * лекции для трёх ролей (тренер / залогиненный зритель / аноним).
 *
 * Контракт:
 *   - Источник данных и обработчики приходят сверху (хук
 *     `useLectureChatSocket`); сам компонент чисто презентационный.
 *   - Список — линейный (старые → новые) с auto-scroll к низу.
 *     При ручной прокрутке вверх — lock; индикатор «новые
 *     сообщения» в углу разрешает вернуться к низу одним кликом.
 *   - Поле ввода — однострочный textarea с auto-resize до 4
 *     строк, лимит 500 unicode-codepoints, счётчик длины. Submit
 *     по Enter без Shift; Shift+Enter — перенос строки. Empty
 *     submit — no-op.
 *   - Сообщения тренера выделены акцентным фоном и маркером
 *     «Тренер» (ADR-121 §5.4).
 *   - Удалённые (`text === '[удалено]'`) рендерятся курсивом без
 *     модерации.
 *   - Тренеру у каждого пользовательского сообщения — иконки
 *     «удалить» и «выключить участника» (по клику на ник).
 *   - Анониму ввод скрыт, вместо него — CTA «Войти, чтобы
 *     писать» с переходом на /login.
 *
 * Производительности виртуализация не требует: при MAX_MESSAGES=500
 * в DOM держим ≤500 узлов, что укладывается в ~30 ms layout-а;
 * виртуализацию вынесем в Phase 2, если лекции с 1000+
 * participants реально упрутся (ADR-121 §10).
 */

export type LectureChatPanelMode = 'owner' | 'viewer' | 'anonymous';

export interface LectureChatPanelProps {
  messages: LectureChatMessage[];
  mutedSelf: boolean;
  loadingSnapshot: boolean;
  lastError: LectureChatErrorEvent | null;
  /** Режим: владелец лекции (модерация) / залогиненный зритель / аноним. */
  mode: LectureChatPanelMode;
  /** Текущий userId — нужен чтобы выделить собственные сообщения и подавить mute самого себя. */
  currentUserId?: string | null;
  /** Высота панели; по умолчанию `100%` — растягивается под родителя. */
  height?: number | string;
  /** Отправка нового сообщения. */
  onSend: (text: string) => void;
  /** Удалить сообщение (owner). */
  onDelete: (messageId: string) => void;
  /** Выключить участника на эту лекцию (owner). */
  onMute: (userId: string) => void;
  /** Сбросить ошибку после показа. */
  onClearError: () => void;
  /** Дополнительный класс. */
  className?: string;
  /** Тестовый префикс data-testid. */
  testIdPrefix?: string;
}

interface ScrollLockState {
  /** true когда ленту не нужно автоматически прокручивать к низу. */
  locked: boolean;
  /** Сколько сообщений пришло, пока пользователь был «выше». */
  pendingCount: number;
}

const ERROR_TEXT: Record<string, string> = {
  rate_limited: 'Слишком быстро. Подождите несколько секунд.',
  too_long: 'Слишком длинное сообщение.',
  too_short: 'Сообщение не должно быть пустым.',
  duplicate: 'Это сообщение вы уже отправляли.',
  muted: 'Ваш чат отключён тренером.',
  forbidden: 'Недостаточно прав.',
  closed: 'Чат закрыт — лекция завершена.',
  invalid_payload: 'Сообщение отклонено сервером.',
  not_found: 'Получатель не найден.',
  control_char: 'Сообщение содержит запрещённые символы.',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

function codepointLength(s: string): number {
  return Array.from(s).length;
}

export function LectureChatPanel({
  messages,
  mutedSelf,
  loadingSnapshot,
  lastError,
  mode,
  currentUserId = null,
  height = '100%',
  onSend,
  onDelete,
  onMute,
  onClearError,
  className,
  testIdPrefix = 'lecture-chat',
}: LectureChatPanelProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState('');
  const [scroll, setScroll] = useState<ScrollLockState>({
    locked: false,
    pendingCount: 0,
  });
  const [confirmMuteFor, setConfirmMuteFor] = useState<{
    userId: string;
    username: string;
  } | null>(null);

  // ── Auto-scroll к низу с lock'ом при ручной прокрутке вверх ────────
  const isNearBottom = useCallback((): boolean => {
    const el = listRef.current;
    if (!el) return true;
    // 64 px — порог: если пользователь прокрутил вверх дальше — считаем
    // что он читает историю, не дёргаем его новыми сообщениями.
    return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    const isNew = lastId && lastMessageIdRef.current !== lastId;
    lastMessageIdRef.current = lastId;

    if (!isNew) return;
    if (scroll.locked) {
      setScroll((s) => ({ ...s, pendingCount: s.pendingCount + 1 }));
      return;
    }
    // Иначе — гарантированно прокручиваем к концу.
    el.scrollTop = el.scrollHeight;
  }, [messages, scroll.locked]);

  const handleScroll = useCallback(() => {
    const near = isNearBottom();
    setScroll((prev) => {
      if (near) {
        if (!prev.locked && prev.pendingCount === 0) return prev;
        return { locked: false, pendingCount: 0 };
      }
      // Пользователь вверху — фиксируем lock.
      if (prev.locked) return prev;
      return { ...prev, locked: true };
    });
  }, [isNearBottom]);

  const jumpToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScroll({ locked: false, pendingCount: 0 });
  }, []);

  // ── Отправка сообщения ──────────────────────────────────────────────
  const length = useMemo(() => codepointLength(draft), [draft]);
  const overLimit = length > LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH;
  const canSend = mode !== 'anonymous' && !mutedSelf && !overLimit && draft.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!canSend) return;
    onSend(draft);
    setDraft('');
    // Возвращаем lock-state к bottom после собственной отправки.
    setScroll({ locked: false, pendingCount: 0 });
    // авто-фокус сохраняем
    textareaRef.current?.focus();
  }, [canSend, draft, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Auto-resize textarea до 4 строк.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [draft]);

  // ── Ошибки от сервера: показываем 4 сек и сбрасываем ────────────────
  useEffect(() => {
    if (!lastError) return;
    const id = setTimeout(onClearError, 4000);
    return () => clearTimeout(id);
  }, [lastError, onClearError]);

  // ── Рендер ──────────────────────────────────────────────────────────
  return (
    <div
      className={['lecture-chat-panel', className].filter(Boolean).join(' ')}
      data-testid={testIdPrefix}
      data-mode={mode}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height,
        minHeight: 0,
        background: '#fff',
        border: '1px solid #e0e0e0',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* ── Шапка ────────────────────────────────────────────────── */}
      <div
        style={{
          padding: '8px 12px',
          fontSize: 13,
          fontWeight: 600,
          color: '#333',
          borderBottom: '1px solid #eee',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>{t('lectureChat.title', 'Чат лекции')}</span>
        {mode === 'owner' && (
          <span
            style={{ fontSize: 11, color: '#888', fontWeight: 400 }}
            title={t(
              'lectureChat.moderatorHint',
              'Вы тренер: можете удалять сообщения и временно отключать участников.',
            )}
          >
            {t('lectureChat.moderator', 'модератор')}
          </span>
        )}
      </div>

      {/* ── Список сообщений ─────────────────────────────────────── */}
      <div
        ref={listRef}
        data-testid={`${testIdPrefix}-list`}
        onScroll={handleScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '8px 12px',
          fontSize: 13,
          lineHeight: 1.4,
          color: '#222',
          position: 'relative',
        }}
      >
        {loadingSnapshot && messages.length === 0 ? (
          <div
            data-testid={`${testIdPrefix}-empty`}
            style={{ color: '#999', textAlign: 'center', marginTop: 16 }}
          >
            {t('lectureChat.loading', 'Загрузка сообщений…')}
          </div>
        ) : messages.length === 0 ? (
          <div
            data-testid={`${testIdPrefix}-empty`}
            style={{ color: '#999', textAlign: 'center', marginTop: 16 }}
          >
            {t('lectureChat.empty', 'Сообщений пока нет. Будьте первым.')}
          </div>
        ) : (
          messages.map((m) => {
            const isOwnerMsg = m.isTrainerMessage;
            const isDeleted = !!m.deletedAt;
            const isSelf =
              currentUserId !== null &&
              m.authorId !== null &&
              currentUserId === m.authorId;
            const canModerate =
              mode === 'owner' && !isDeleted && m.authorId !== null && !isSelf;
            return (
              <div
                key={m.id}
                data-testid={`${testIdPrefix}-msg`}
                data-msg-id={m.id}
                data-trainer={isOwnerMsg ? 'true' : 'false'}
                data-deleted={isDeleted ? 'true' : 'false'}
                style={{
                  marginBottom: 6,
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: isOwnerMsg ? '#fff8e1' : 'transparent',
                  borderLeft: isOwnerMsg ? '3px solid #f4b400' : 'none',
                  opacity: isDeleted ? 0.55 : 1,
                  fontStyle: isDeleted ? 'italic' : 'normal',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    data-testid={`${testIdPrefix}-author`}
                    onClick={() => {
                      if (!canModerate) return;
                      setConfirmMuteFor({
                        userId: m.authorId as string,
                        username:
                          m.authorUsername ?? t('lectureChat.unknown', 'участник'),
                      });
                    }}
                    disabled={!canModerate}
                    style={{
                      fontWeight: 600,
                      color: isOwnerMsg ? '#8a6500' : '#1e88e5',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: canModerate ? 'pointer' : 'default',
                      textDecoration: canModerate ? 'underline dotted' : 'none',
                    }}
                    title={
                      canModerate
                        ? t('lectureChat.muteHint', 'Отключить участника в этой лекции')
                        : undefined
                    }
                  >
                    {m.authorUsername ?? t('lectureChat.unknown', 'участник')}
                  </button>
                  {isOwnerMsg && (
                    <span
                      data-testid={`${testIdPrefix}-trainer-badge`}
                      style={{
                        fontSize: 10,
                        color: '#8a6500',
                        background: '#fff3c4',
                        padding: '1px 5px',
                        borderRadius: 4,
                      }}
                    >
                      {t('lectureChat.trainerLabel', 'Тренер')}
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: '#999' }}>
                    {formatTime(m.createdAt)}
                  </span>
                  {canModerate && (
                    <button
                      type="button"
                      data-testid={`${testIdPrefix}-delete`}
                      onClick={() => onDelete(m.id)}
                      aria-label={t('lectureChat.deleteAria', 'Удалить сообщение')}
                      title={t('lectureChat.deleteAria', 'Удалить сообщение')}
                      style={{
                        marginLeft: 'auto',
                        background: 'none',
                        border: 'none',
                        color: '#aaa',
                        cursor: 'pointer',
                        padding: '0 4px',
                        fontSize: 13,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div
                  data-testid={`${testIdPrefix}-text`}
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {m.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Индикатор «новые сообщения» при locked scroll ────────── */}
      {scroll.locked && scroll.pendingCount > 0 && (
        <button
          type="button"
          data-testid={`${testIdPrefix}-jump`}
          onClick={jumpToBottom}
          style={{
            position: 'absolute',
            right: 16,
            bottom: 90,
            background: '#1e88e5',
            color: '#fff',
            border: 'none',
            borderRadius: 16,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
            boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
          }}
        >
          {t('lectureChat.newMessages', '↓ Новых: {{count}}', {
            count: scroll.pendingCount,
          })}
        </button>
      )}

      {/* ── Системная ошибка от сервера ──────────────────────────── */}
      {lastError && (
        <div
          data-testid={`${testIdPrefix}-error`}
          role="alert"
          style={{
            padding: '6px 12px',
            background: '#fdecea',
            color: '#8a1f1f',
            fontSize: 12,
            borderTop: '1px solid #f3c2c0',
          }}
        >
          {ERROR_TEXT[lastError.code] ?? lastError.message ?? lastError.code}
        </div>
      )}

      {/* ── Поле ввода / CTA для анонимов ────────────────────────── */}
      {mode === 'anonymous' ? (
        <div
          data-testid={`${testIdPrefix}-anon-cta`}
          style={{
            padding: '10px 12px',
            background: '#f7f7f7',
            borderTop: '1px solid #eee',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'space-between',
            fontSize: 12,
          }}
        >
          <span style={{ color: '#555' }}>
            {t('lectureChat.anonHint', 'Войдите, чтобы участвовать в чате.')}
          </span>
          <a
            href="/login"
            style={{
              padding: '4px 10px',
              background: '#1e88e5',
              color: '#fff',
              borderRadius: 4,
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            {t('lectureChat.anonCta', 'Войти')}
          </a>
        </div>
      ) : mutedSelf ? (
        <div
          data-testid={`${testIdPrefix}-muted-hint`}
          style={{
            padding: '10px 12px',
            background: '#f7f7f7',
            borderTop: '1px solid #eee',
            color: '#555',
            fontSize: 12,
          }}
        >
          {t('lectureChat.mutedSelf', 'Тренер отключил ваш чат в этой лекции.')}
        </div>
      ) : (
        <form
          data-testid={`${testIdPrefix}-form`}
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          style={{
            padding: '8px 12px',
            borderTop: '1px solid #eee',
            background: '#fafafa',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
          }}
        >
          <textarea
            ref={textareaRef}
            data-testid={`${testIdPrefix}-input`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={t('lectureChat.placeholder', 'Сообщение…')}
            aria-label={t('lectureChat.inputAria', 'Сообщение в чат лекции')}
            style={{
              flex: 1,
              resize: 'none',
              border: `1px solid ${overLimit ? '#e57373' : '#ccc'}`,
              borderRadius: 4,
              padding: '6px 8px',
              fontSize: 13,
              lineHeight: 1.35,
              fontFamily: 'inherit',
              outline: 'none',
              minHeight: 28,
              maxHeight: 96,
            }}
          />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 4,
            }}
          >
            <span
              data-testid={`${testIdPrefix}-counter`}
              style={{
                fontSize: 11,
                color: overLimit ? '#c62828' : '#999',
                whiteSpace: 'nowrap',
              }}
            >
              {length}/{LECTURE_CHAT_LIMITS.MAX_TEXT_LENGTH}
            </span>
            <button
              type="submit"
              data-testid={`${testIdPrefix}-send`}
              disabled={!canSend}
              style={{
                padding: '6px 12px',
                background: canSend ? '#1e88e5' : '#bbb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: canSend ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              {t('lectureChat.send', 'Отправить')}
            </button>
          </div>
        </form>
      )}

      {/* ── Confirm для mute ─────────────────────────────────────── */}
      {confirmMuteFor && (
        <div
          data-testid={`${testIdPrefix}-mute-confirm`}
          role="dialog"
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
          onClick={() => setConfirmMuteFor(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 8,
              padding: 16,
              maxWidth: 280,
              boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            }}
          >
            <p style={{ margin: 0, fontSize: 13, color: '#222' }}>
              {t(
                'lectureChat.muteConfirm',
                'Отключить чат пользователю {{name}} до конца лекции?',
                { name: confirmMuteFor.username },
              )}
            </p>
            <div
              style={{
                display: 'flex',
                gap: 8,
                marginTop: 12,
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                onClick={() => setConfirmMuteFor(null)}
                style={{
                  padding: '6px 12px',
                  background: '#eee',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {t('lectureChat.muteCancel', 'Отмена')}
              </button>
              <button
                type="button"
                data-testid={`${testIdPrefix}-mute-confirm-ok`}
                onClick={() => {
                  onMute(confirmMuteFor.userId);
                  setConfirmMuteFor(null);
                }}
                style={{
                  padding: '6px 12px',
                  background: '#c62828',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {t('lectureChat.muteOk', 'Отключить')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
