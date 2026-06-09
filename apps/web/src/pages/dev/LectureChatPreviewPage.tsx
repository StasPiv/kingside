import { useState } from 'react';
import type { LectureChatErrorEvent, LectureChatMessage } from '@kingside/shared';
import { LectureChatPanel } from '../../components/lecture/LectureChatPanel';
import { ChatBadgeIndicator } from '../../components/lecture/ChatBadgeIndicator';
import {
  ChatBottomSheet,
  type ChatBottomSheetMode,
} from '../../components/lecture/ChatBottomSheet';

/**
 * KS-4009 / ADR-121 Phase 1. Dev-only песочница для визуальной
 * проверки чата лекции и снятия приёмочных скриншотов desktop +
 * mobile для тренера и ученика.
 *
 * Доступ: `/__dev/lecture-chat` (роут добавлен в `App.tsx`).
 */

const MESSAGES: LectureChatMessage[] = [
  {
    id: 'm1',
    lectureId: 'lec-demo',
    authorId: 'student-1',
    authorUsername: 'lara',
    text: 'Доброе утро! Спасибо за лекцию.',
    createdAt: '2026-06-09T08:00:00.000Z',
    isTrainerMessage: false,
    pinned: false,
    deletedAt: null,
    kind: 'user',
  },
  {
    id: 'm2',
    lectureId: 'lec-demo',
    authorId: 'owner-1',
    authorUsername: 'coach_alex',
    text: 'Привет всем. Начнём с защиты Каро-Канн — посмотрим главные планы за чёрных.',
    createdAt: '2026-06-09T08:01:12.000Z',
    isTrainerMessage: true,
    pinned: false,
    deletedAt: null,
    kind: 'user',
  },
  {
    id: 'm3',
    lectureId: 'lec-demo',
    authorId: 'student-2',
    authorUsername: 'maxim',
    text: 'А вариант с f6 в позиции с e5 уже устаревший?',
    createdAt: '2026-06-09T08:02:34.000Z',
    isTrainerMessage: false,
    pinned: false,
    deletedAt: null,
    kind: 'user',
  },
  {
    id: 'm4',
    lectureId: 'lec-demo',
    authorId: 'owner-1',
    authorUsername: 'coach_alex',
    text: 'Хороший вопрос — сейчас покажу на доске.',
    createdAt: '2026-06-09T08:02:50.000Z',
    isTrainerMessage: true,
    pinned: false,
    deletedAt: null,
    kind: 'user',
  },
  {
    id: 'm5',
    lectureId: 'lec-demo',
    authorId: 'student-3',
    authorUsername: 'nina',
    text: '[удалено]',
    createdAt: '2026-06-09T08:03:11.000Z',
    isTrainerMessage: false,
    pinned: false,
    deletedAt: '2026-06-09T08:03:30.000Z',
    kind: 'user',
  },
];

type Mode = 'owner-desktop' | 'viewer-mobile' | 'anon-mobile' | 'muted-viewer';

function readSceneFromQuery(): Mode {
  if (typeof window === 'undefined') return 'owner-desktop';
  const sp = new URLSearchParams(window.location.search);
  const s = sp.get('scene');
  if (
    s === 'owner-desktop' ||
    s === 'viewer-mobile' ||
    s === 'anon-mobile' ||
    s === 'muted-viewer'
  ) {
    return s;
  }
  return 'owner-desktop';
}

export default function LectureChatPreviewPage() {
  const [scene, setScene] = useState<Mode>(() => readSceneFromQuery());
  const [sheetMode, setSheetMode] = useState<ChatBottomSheetMode>('compact');
  const [error, setError] = useState<LectureChatErrorEvent | null>(null);

  const triggerRateLimit = () =>
    setError({ code: 'rate_limited', message: 'too fast' });

  const noop = () => {};

  const sharedPanelProps = {
    messages: MESSAGES,
    loadingSnapshot: false,
    lastError: error,
    onSend: noop,
    onDelete: noop,
    onMute: noop,
    onClearError: () => setError(null),
  };

  return (
    <div
      data-testid="lecture-chat-preview"
      style={{
        padding: 24,
        maxWidth: 1080,
        margin: '0 auto',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ marginBottom: 4 }}>Lecture chat preview</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        KS-4009 · ADR-121 Phase 1 · песочница для приёмочных скриншотов.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {(
          [
            ['owner-desktop', 'Тренер · десктоп'],
            ['viewer-mobile', 'Ученик · мобильный'],
            ['anon-mobile', 'Аноним · мобильный'],
            ['muted-viewer', 'Ученик · выключен'],
          ] as Array<[Mode, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-testid={`scene-${id}`}
            onClick={() => setScene(id)}
            style={{
              padding: '6px 12px',
              background: scene === id ? '#1e88e5' : '#eee',
              color: scene === id ? '#fff' : '#333',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          data-testid="trigger-rate-limit"
          onClick={triggerRateLimit}
          style={{
            padding: '6px 12px',
            background: '#fdecea',
            color: '#8a1f1f',
            border: '1px solid #f3c2c0',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Симулировать rate-limit
        </button>
      </div>

      {scene === 'owner-desktop' && (
        <div
          data-testid="scene-owner-desktop-frame"
          style={{
            width: 360,
            height: 600,
            border: '1px solid #ddd',
            borderRadius: 8,
            overflow: 'hidden',
            background: '#f8f9fa',
            padding: 8,
          }}
        >
          <LectureChatPanel
            {...sharedPanelProps}
            mutedSelf={false}
            mode="owner"
            currentUserId="owner-1"
          />
        </div>
      )}

      {scene === 'viewer-mobile' && (
        <div
          data-testid="scene-viewer-mobile-frame"
          style={{
            position: 'relative',
            width: 375,
            height: 720,
            border: '1px solid #ddd',
            borderRadius: 24,
            overflow: 'hidden',
            background: '#222',
          }}
        >
          {/* «Доска» лекции — заглушка для контекста скриншота */}
          <div
            style={{
              padding: 16,
              color: '#fff',
              fontSize: 13,
              opacity: 0.7,
            }}
          >
            Лекция · доска тренера
          </div>
          <div style={{ position: 'absolute', top: 8, right: 8 }}>
            <ChatBadgeIndicator
              unreadCount={3}
              isLive
              onOpen={() => setSheetMode('compact')}
            />
          </div>
          <ChatBottomSheet mode={sheetMode} onModeChange={setSheetMode}>
            <LectureChatPanel
              {...sharedPanelProps}
              mutedSelf={false}
              mode="viewer"
              currentUserId="student-1"
            />
          </ChatBottomSheet>
        </div>
      )}

      {scene === 'anon-mobile' && (
        <div
          data-testid="scene-anon-mobile-frame"
          style={{
            position: 'relative',
            width: 375,
            height: 720,
            border: '1px solid #ddd',
            borderRadius: 24,
            overflow: 'hidden',
            background: '#222',
          }}
        >
          <div
            style={{
              padding: 16,
              color: '#fff',
              fontSize: 13,
              opacity: 0.7,
            }}
          >
            Лекция · доска тренера
          </div>
          <ChatBottomSheet mode="compact" onModeChange={() => {}}>
            <LectureChatPanel
              {...sharedPanelProps}
              mutedSelf={false}
              mode="anonymous"
              currentUserId={null}
            />
          </ChatBottomSheet>
        </div>
      )}

      {scene === 'muted-viewer' && (
        <div
          data-testid="scene-muted-viewer-frame"
          style={{
            width: 360,
            height: 600,
            border: '1px solid #ddd',
            borderRadius: 8,
            overflow: 'hidden',
            background: '#f8f9fa',
            padding: 8,
          }}
        >
          <LectureChatPanel
            {...sharedPanelProps}
            mutedSelf
            mode="viewer"
            currentUserId="student-3"
          />
        </div>
      )}
    </div>
  );
}
