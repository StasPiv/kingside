import { describe, it, expect } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';
import { ChatToolCalls } from './ChatToolCalls';
import type { ToolCallEvent } from '../hooks/useChatStream';

/**
 * KS-3210 (ADR-074 §10 F1): unit-тесты на 3 статуса tool_call.
 * Парсер SSE покрыт в ChatContext.test.tsx — здесь только UI.
 */
describe('<ChatToolCalls>', () => {
  it('пустой массив → null (не рендерит ul)', () => {
    const { container } = renderWithProviders(<ChatToolCalls items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('running → спиннер + «{name} — выполняется…»', () => {
    const items: ToolCallEvent[] = [
      { id: 't1', name: 'create_user_course', status: 'running' },
    ];
    renderWithProviders(<ChatToolCalls items={items} />);
    const el = screen.getByTestId('chat-tool-call-t1');
    expect(el.getAttribute('data-status')).toBe('running');
    expect(el.getAttribute('data-name')).toBe('create_user_course');
    expect(el.querySelector('.chat-tool-call__spinner')).toBeTruthy();
    expect(el.textContent).toContain('create_user_course');
    expect(el.textContent?.toLowerCase()).toMatch(/running|выполняется/);
  });

  it('ok → ✓ + «Выполнено: {name}», output в data-атрибуте', () => {
    const items: ToolCallEvent[] = [
      {
        id: 't1',
        name: 'list_lesson_steps',
        status: 'ok',
        output: '{"steps":5}',
      },
    ];
    renderWithProviders(<ChatToolCalls items={items} />);
    const el = screen.getByTestId('chat-tool-call-t1');
    expect(el.getAttribute('data-status')).toBe('ok');
    expect(el.getAttribute('data-output')).toBe('{"steps":5}');
    expect(el.querySelector('.chat-tool-call__spinner')).toBeNull();
    expect(el.textContent).toContain('list_lesson_steps');
    expect(el.textContent).toMatch(/Completed|Выполнено/);
    // Сам output в тексте не отображается — приватная служебная инфа.
    expect(el.textContent).not.toContain('{"steps":5}');
  });

  it('error → ❌ + сообщение из event.error', () => {
    const items: ToolCallEvent[] = [
      {
        id: 't1',
        name: 'create_user_course',
        status: 'error',
        error: 'Lesson title already taken',
      },
    ];
    renderWithProviders(<ChatToolCalls items={items} />);
    const el = screen.getByTestId('chat-tool-call-t1');
    expect(el.getAttribute('data-status')).toBe('error');
    expect(el.textContent).toContain('create_user_course');
    expect(el.textContent).toContain('Lesson title already taken');
  });

  it('рендерит несколько tool-calls в порядке массива', () => {
    const items: ToolCallEvent[] = [
      { id: 't1', name: 'first_tool', status: 'ok', output: 'x' },
      { id: 't2', name: 'second_tool', status: 'running' },
    ];
    renderWithProviders(<ChatToolCalls items={items} />);
    const list = screen.getByTestId('chat-tool-calls');
    const children = list.querySelectorAll('[data-testid^="chat-tool-call-"]');
    expect(children.length).toBe(2);
    expect(children[0].getAttribute('data-testid')).toBe(
      'chat-tool-call-t1',
    );
    expect(children[1].getAttribute('data-testid')).toBe(
      'chat-tool-call-t2',
    );
  });
});
