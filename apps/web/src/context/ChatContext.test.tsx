import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { ChatProvider, useChat } from './ChatContext';

/**
 * KS-3210 (ADR-074 §10 F1): покрытие SSE-парсера в ChatProvider.
 *
 * Цель: проверить, что:
 *  1. `tool_call` (running) добавляет элемент в `messages[last].toolCalls`.
 *  2. `tool_call` (ok / error) с тем же `id` мутирует элемент (не
 *     дублирует).
 *  3. `text`-event'ы продолжают стримить content, не ломая toolCalls.
 *  4. Финальный текст и tool-calls сосуществуют в одном assistant-msg.
 *
 * Mock `fetch` возвращает Response с подменённым `body.getReader()`,
 * который отдаёт чанки SSE в формате `data: {...}\n`. localStorage
 * token — заглушка, чтобы Authorization-header не падал.
 */

function ssePart(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

function mockSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (i >= chunks.length) return { done: true };
      const value = encoder.encode(chunks[i++]);
      return { done: false, value };
    },
  };
  const body = {
    getReader: () => reader,
  } as unknown as ReadableStream<Uint8Array>;
  return new Response(null, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Conversation-Id': 'conv-1',
    },
  }) as unknown as Response & { body: typeof body } extends Response
    ? Response
    : never extends never
      ? never
      : never;
  // Note: проще создать объект «вручную» — Response в jsdom не позволяет
  // подменить body. См. workaround ниже.
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unused = mockSseResponse; // silence eslint, реальный fetch-mock ниже

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function installFetchMock(chunks: string[]): void {
  const encoder = new TextEncoder();
  let i = 0;
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (i >= chunks.length) return { done: true };
      return { done: false, value: encoder.encode(chunks[i++]) };
    },
  };
  const fakeResponse = {
    ok: true,
    status: 200,
    headers: new Headers({
      'Content-Type': 'text/event-stream',
      'X-Conversation-Id': 'conv-1',
    }),
    body: { getReader: () => reader },
    async json() {
      return {};
    },
  } as unknown as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => fakeResponse),
  );
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

describe('ChatContext — KS-3210 tool_call SSE parser', () => {
  it('tool_call running → ok мутирует одну запись по id', async () => {
    installFetchMock([
      ssePart({ type: 'text', text: 'Sure, ' }),
      ssePart({
        type: 'tool_call',
        id: 'tool-1',
        name: 'create_user_course',
        input: { title: 'X' },
        status: 'running',
      }),
      ssePart({
        type: 'tool_call',
        id: 'tool-1',
        name: 'create_user_course',
        input: { title: 'X' },
        status: 'ok',
        output: '{"id":"c-1"}',
      }),
      ssePart({ type: 'text', text: 'done.' }),
      ssePart({ done: true, conversationId: 'conv-1' }),
    ]);

    const { result } = renderHook(() => useChat(), { wrapper });

    await act(async () => {
      await result.current.sendMessage('make a course');
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });

    const msgs = result.current.messages;
    // user + assistant
    expect(msgs).toHaveLength(2);
    const last = msgs[1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('Sure, done.');
    expect(last.toolCalls).toBeDefined();
    expect(last.toolCalls).toHaveLength(1);
    expect(last.toolCalls?.[0]).toMatchObject({
      id: 'tool-1',
      name: 'create_user_course',
      status: 'ok',
      output: '{"id":"c-1"}',
    });
  });

  it('tool_call error → статус error, поле error сохраняется', async () => {
    installFetchMock([
      ssePart({
        type: 'tool_call',
        id: 'tool-1',
        name: 'broken_tool',
        input: {},
        status: 'running',
      }),
      ssePart({
        type: 'tool_call',
        id: 'tool-1',
        name: 'broken_tool',
        input: {},
        status: 'error',
        error: 'Permission denied',
      }),
      ssePart({ done: true, conversationId: 'conv-1' }),
    ]);

    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));

    const last = result.current.messages.at(-1)!;
    expect(last.toolCalls).toHaveLength(1);
    expect(last.toolCalls?.[0].status).toBe('error');
    expect(last.toolCalls?.[0].error).toBe('Permission denied');
  });

  it('несколько tool_call по разным id → разные элементы массива', async () => {
    installFetchMock([
      ssePart({
        type: 'tool_call',
        id: 'a',
        name: 'tool_a',
        status: 'running',
      }),
      ssePart({
        type: 'tool_call',
        id: 'b',
        name: 'tool_b',
        status: 'running',
      }),
      ssePart({
        type: 'tool_call',
        id: 'a',
        name: 'tool_a',
        status: 'ok',
        output: 'A',
      }),
      ssePart({
        type: 'tool_call',
        id: 'b',
        name: 'tool_b',
        status: 'ok',
        output: 'B',
      }),
      ssePart({ done: true, conversationId: 'conv-1' }),
    ]);

    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.sendMessage('multi');
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));

    const last = result.current.messages.at(-1)!;
    expect(last.toolCalls).toHaveLength(2);
    expect(last.toolCalls?.[0].id).toBe('a');
    expect(last.toolCalls?.[0].status).toBe('ok');
    expect(last.toolCalls?.[1].id).toBe('b');
    expect(last.toolCalls?.[1].status).toBe('ok');
  });

  it('фатальная ошибка цикла (type:error) → текст в content, нет tool-call', async () => {
    installFetchMock([
      ssePart({ type: 'text', text: 'Partial answer' }),
      ssePart({ type: 'error', error: 'Tool loop limit exceeded' }),
      ssePart({ done: true, conversationId: 'conv-1' }),
    ]);

    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.sendMessage('hi');
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));

    const last = result.current.messages.at(-1)!;
    expect(last.content).toContain('Partial answer');
    expect(last.content).toContain('Tool loop limit exceeded');
    expect(last.toolCalls).toBeUndefined();
  });
});
