/**
 * KS-4009 / ADR-121 Phase 1 — тесты `LectureChatPanel`.
 *
 * Покрываем критичные сценарии UI:
 *  - viewer отправляет сообщение по Enter;
 *  - тренер видит кнопку удалить и зовёт onDelete;
 *  - кнопка отправки заблокирована на пустом и превышенной длине;
 *  - аноним видит CTA вместо input;
 *  - mutedSelf скрывает форму;
 *  - rate-limit-ошибка показывается баннером.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { LectureChatMessage } from '@kingside/shared';
import { LectureChatPanel } from './LectureChatPanel';

// Простая i18n-заглушка — `useTranslation` возвращает функцию-идентитет.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string, opts?: Record<string, unknown>) => {
      if (!defaultValue) return _key;
      if (!opts) return defaultValue;
      return defaultValue.replace(/\{\{(\w+)\}\}/g, (_, k) =>
        String(opts[k] ?? ''),
      );
    },
  }),
}));

function makeMsg(over: Partial<LectureChatMessage> = {}): LectureChatMessage {
  return {
    id: 'm-1',
    lectureId: 'lec-1',
    authorId: 'u-1',
    authorUsername: 'alice',
    text: 'Hello',
    createdAt: '2026-06-09T08:00:00.000Z',
    isTrainerMessage: false,
    pinned: false,
    deletedAt: null,
    kind: 'user',
    ...over,
  };
}

const noop = () => {};

describe('LectureChatPanel', () => {
  it('viewer sends message via Enter', () => {
    const onSend = vi.fn();
    render(
      <LectureChatPanel
        messages={[]}
        mutedSelf={false}
        loadingSnapshot={false}
        lastError={null}
        mode="viewer"
        currentUserId="u-2"
        onSend={onSend}
        onDelete={noop}
        onMute={noop}
        onClearError={noop}
      />,
    );
    const input = screen.getByTestId('lecture-chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hi');
  });

  it('owner sees delete button and triggers onDelete', () => {
    const onDelete = vi.fn();
    render(
      <LectureChatPanel
        messages={[makeMsg({ authorId: 'u-99', authorUsername: 'bob' })]}
        mutedSelf={false}
        loadingSnapshot={false}
        lastError={null}
        mode="owner"
        currentUserId="owner-1"
        onSend={noop}
        onDelete={onDelete}
        onMute={noop}
        onClearError={noop}
      />,
    );
    const btn = screen.getByTestId('lecture-chat-delete');
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith('m-1');
  });

  it('send button disabled when input is empty', () => {
    render(
      <LectureChatPanel
        messages={[]}
        mutedSelf={false}
        loadingSnapshot={false}
        lastError={null}
        mode="viewer"
        currentUserId="u-1"
        onSend={noop}
        onDelete={noop}
        onMute={noop}
        onClearError={noop}
      />,
    );
    const btn = screen.getByTestId('lecture-chat-send') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('send button disabled when over 500 chars', () => {
    render(
      <LectureChatPanel
        messages={[]}
        mutedSelf={false}
        loadingSnapshot={false}
        lastError={null}
        mode="viewer"
        currentUserId="u-1"
        onSend={noop}
        onDelete={noop}
        onMute={noop}
        onClearError={noop}
      />,
    );
    const input = screen.getByTestId('lecture-chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'x'.repeat(501) } });
    const btn = screen.getByTestId('lecture-chat-send') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('anonymous mode renders CTA instead of input', () => {
    render(
      <LectureChatPanel
        messages={[]}
        mutedSelf={false}
        loadingSnapshot={false}
        lastError={null}
        mode="anonymous"
        currentUserId={null}
        onSend={noop}
        onDelete={noop}
        onMute={noop}
        onClearError={noop}
      />,
    );
    expect(screen.queryByTestId('lecture-chat-input')).toBeNull();
    expect(screen.getByTestId('lecture-chat-anon-cta')).toBeTruthy();
  });

  it('mutedSelf hides form and shows hint', () => {
    render(
      <LectureChatPanel
        messages={[]}
        mutedSelf
        loadingSnapshot={false}
        lastError={null}
        mode="viewer"
        currentUserId="u-1"
        onSend={noop}
        onDelete={noop}
        onMute={noop}
        onClearError={noop}
      />,
    );
    expect(screen.queryByTestId('lecture-chat-input')).toBeNull();
    expect(screen.getByTestId('lecture-chat-muted-hint')).toBeTruthy();
  });

  it('shows rate-limit error banner', () => {
    render(
      <LectureChatPanel
        messages={[]}
        mutedSelf={false}
        loadingSnapshot={false}
        lastError={{ code: 'rate_limited', message: 'too fast' }}
        mode="viewer"
        currentUserId="u-1"
        onSend={noop}
        onDelete={noop}
        onMute={noop}
        onClearError={noop}
      />,
    );
    const banner = screen.getByTestId('lecture-chat-error');
    expect(banner.textContent).toMatch(/Слишком быстро/);
  });

  it('trainer message is visually marked', () => {
    render(
      <LectureChatPanel
        messages={[
          makeMsg({
            id: 'm-trainer',
            authorId: 'owner-1',
            authorUsername: 'coach',
            isTrainerMessage: true,
          }),
        ]}
        mutedSelf={false}
        loadingSnapshot={false}
        lastError={null}
        mode="viewer"
        currentUserId="u-1"
        onSend={noop}
        onDelete={noop}
        onMute={noop}
        onClearError={noop}
      />,
    );
    expect(screen.getByTestId('lecture-chat-trainer-badge')).toBeTruthy();
    const msg = screen.getByTestId('lecture-chat-msg');
    expect(msg.getAttribute('data-trainer')).toBe('true');
  });
});
