/**
 * Unit-тесты tool-use loop'а `ChatAssistantService.streamResponse`
 * (KS-3205 / ADR-074 §10 B1).
 *
 * Покрываем (per acceptance):
 *   1. один tool вызывается и возвращает результат → текст финального
 *      turn'а стримится в `text`-event'ах.
 *   2. прерывание при достижении MAX_TOOL_TURNS=8 → `error`-event.
 *   3. ошибка из tool'а пробрасывается обратно ассистенту через
 *      `tool_result.is_error=true` и `error`-event на клиента.
 *   4. tools пуст (NoOp) → loop вырождается в один turn, никаких
 *      tool_call events.
 *
 * Anthropic SDK подменяется через `jest.mock('@anthropic-ai/sdk', …)`
 * — `messages.create` возвращает заранее сложенный массив responses
 * (по одному на turn).
 */

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ChatAssistantService } from './chat-assistant.service';
import {
  AssistantToolsProvider,
  AnthropicToolDef,
  ChatStreamEvent,
  MAX_TOOL_TURNS,
} from './assistant-tools';

// ── Mock Anthropic SDK ──────────────────────────────────────────────
//
// SDK импортируется динамически через `import('@anthropic-ai/sdk')`,
// поэтому мокируем модуль целиком.
const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: mockMessagesCreate };
  }
  return { __esModule: true, default: FakeAnthropic };
});

// ── Helpers ─────────────────────────────────────────────────────────

const userId = 'user-1';
const conversationId = 'conv-1';
const message = 'Hello assistant';

function makeService(provider: AssistantToolsProvider): ChatAssistantService {
  const prisma = {
    chatAssistantMessage: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    chatConversation: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: conversationId }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: conversationId, title: null }),
      delete: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ username: 'tester' }),
    },
  } as unknown as ConstructorParameters<typeof ChatAssistantService>[0];

  const redis = {} as ConstructorParameters<typeof ChatAssistantService>[1];

  const configMap: Record<string, string> = {
    ANTHROPIC_API_KEY: 'test-key',
    CHAT_MODEL: 'claude-sonnet-4-20250514',
    CHAT_MAX_TOKENS: '1024',
    AI_CHAT_WEBHOOK_URL: '',
    WEBHOOK_AUTH_TOKEN: '',
    CHAT_RATE_LIMIT_PER_MIN: '10',
    CHAT_RATE_LIMIT_PER_DAY: '100',
    CHAT_GLOBAL_DAILY_LIMIT: '1000',
    CHAT_MAX_MSG_LENGTH: '2000',
    SITE_URL: 'https://example.test',
  };
  const config: ConfigService = {
    get: (key: string, def?: string) => configMap[key] ?? def ?? '',
  } as unknown as ConfigService;

  const jwt = { sign: () => 'jwt-token' } as unknown as JwtService;

  const contextCollector = {
    collectContext: jest.fn().mockResolvedValue({
      profile: {
        username: 'tester',
        ratingBullet: 1500,
        ratingBlitz: 1500,
        ratingRapid: 1500,
        ratingClassical: 1500,
        ratingPuzzle: 1500,
        gamesPlayedBullet: 0,
        gamesPlayedBlitz: 0,
        gamesPlayedRapid: 0,
        gamesPlayedClassical: 0,
        puzzleStreak: 0,
        memberSince: '2026-01-01',
      },
      puzzleStats: {
        totalAttempted: 0,
        totalSolved: 0,
        solveRate: 0,
        currentStreak: 0,
      },
      recentGames: [],
      ratingHistory: [],
      recentPuzzleAttempts: [],
    }),
  } as unknown as ConstructorParameters<typeof ChatAssistantService>[4];

  const featureFlags = {
    getFlags: jest.fn().mockResolvedValue({}),
  } as unknown as ConstructorParameters<typeof ChatAssistantService>[5];

  return new ChatAssistantService(
    prisma,
    redis,
    config,
    jwt,
    contextCollector,
    featureFlags,
    provider,
  );
}

async function collect(
  gen: AsyncGenerator<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const FAKE_TOOL: AnthropicToolDef = {
  name: 'echo',
  description: 'Returns the input back',
  input_schema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
};

// ── Tests ───────────────────────────────────────────────────────────

describe('ChatAssistantService.streamResponse — tool-use loop (KS-3205)', () => {
  beforeEach(() => {
    mockMessagesCreate.mockReset();
  });

  it('tools пуст (NoOp) → один turn, никаких tool_call events', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello back!' }],
    });
    const provider: AssistantToolsProvider = {
      listTools: async () => [],
      execute: async () => {
        throw new Error('not reached');
      },
    };
    const service = makeService(provider);

    const events = await collect(
      service.streamResponse(userId, message, conversationId),
    );

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    // tools НЕ передаётся (пустой массив опускается).
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.tools).toBeUndefined();

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(0);
    const texts = events
      .filter((e): e is { type: 'text'; text: string } => e.type === 'text')
      .map((e) => e.text);
    expect(texts.join('')).toBe('Hello back!');
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('один tool вызывается, результат проброшен модели, финальный текст стримится', async () => {
    // Turn 1: модель просит вызвать echo({value:"hi"})
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Sure, let me check.' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'echo',
          input: { value: 'hi' },
        },
      ],
    });
    // Turn 2: модель формулирует финальный ответ.
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Tool said: hi' }],
    });

    const execute = jest.fn().mockResolvedValue('hi');
    const provider: AssistantToolsProvider = {
      listTools: async () => [FAKE_TOOL],
      execute,
    };
    const service = makeService(provider);

    const events = await collect(
      service.streamResponse(userId, message, conversationId),
    );

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    // tools передаётся в каждом turn'е.
    for (const call of mockMessagesCreate.mock.calls) {
      expect(call[0].tools).toEqual([FAKE_TOOL]);
    }
    // tool вызван один раз с теми же аргументами.
    expect(execute).toHaveBeenCalledWith(userId, 'echo', { value: 'hi' });

    // События: text (preamble) → tool_call running → tool_call ok →
    //         text (final) → done.
    const types = events.map((e) => e.type);
    expect(types).toEqual(['text', 'tool_call', 'tool_call', 'text', 'done']);

    const toolCalls = events.filter(
      (e): e is Extract<ChatStreamEvent, { type: 'tool_call' }> =>
        e.type === 'tool_call',
    );
    expect(toolCalls[0]).toMatchObject({
      id: 'tu_1',
      name: 'echo',
      status: 'running',
    });
    expect(toolCalls[1]).toMatchObject({
      id: 'tu_1',
      name: 'echo',
      status: 'ok',
      output: 'hi',
    });

    // На второй turn в messages пришёл assistant с tool_use + user с
    // tool_result.
    const secondCallMessages = mockMessagesCreate.mock.calls[1][0]
      .messages as Array<{ role: string; content: unknown }>;
    const lastTwo = secondCallMessages.slice(-2);
    expect(lastTwo[0].role).toBe('assistant');
    expect(lastTwo[1].role).toBe('user');
    const toolResultBlocks = lastTwo[1].content as Array<Record<string, unknown>>;
    expect(toolResultBlocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'hi',
    });
    expect(toolResultBlocks[0].is_error).toBeUndefined();
  });

  it('ошибка в tool пробрасывается обратно модели и наружу как tool_call error', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu_2',
          name: 'echo',
          input: { value: 'boom' },
        },
      ],
    });
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Sorry, tool failed.' }],
    });

    const execute = jest.fn().mockRejectedValue(new Error('boom!'));
    const provider: AssistantToolsProvider = {
      listTools: async () => [FAKE_TOOL],
      execute,
    };
    const service = makeService(provider);

    const events = await collect(
      service.streamResponse(userId, message, conversationId),
    );

    const errorEvent = events.find(
      (e): e is Extract<ChatStreamEvent, { type: 'tool_call' }> =>
        e.type === 'tool_call' && e.status === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error).toBe('boom!');

    // tool_result пробросился с is_error=true.
    const secondCallMessages = mockMessagesCreate.mock.calls[1][0]
      .messages as Array<{ role: string; content: unknown }>;
    const userMsg = secondCallMessages[secondCallMessages.length - 1];
    const blocks = userMsg.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_2',
      is_error: true,
      content: 'boom!',
    });

    // Финальный текст стримится из второго turn'а.
    const finalText = events
      .filter((e): e is { type: 'text'; text: string } => e.type === 'text')
      .map((e) => e.text)
      .join('');
    expect(finalText).toBe('Sorry, tool failed.');
  });

  it('MAX_TOOL_TURNS=8: бесконечный tool_use прерывается ошибкой', async () => {
    // Модель упорно вызывает tool на каждом turn'е.
    for (let i = 0; i < MAX_TOOL_TURNS + 1; i++) {
      mockMessagesCreate.mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `tu_${i}`,
            name: 'echo',
            input: { value: `${i}` },
          },
        ],
      });
    }
    const execute = jest.fn().mockResolvedValue('ok');
    const provider: AssistantToolsProvider = {
      listTools: async () => [FAKE_TOOL],
      execute,
    };
    const service = makeService(provider);

    const events = await collect(
      service.streamResponse(userId, message, conversationId),
    );

    expect(mockMessagesCreate).toHaveBeenCalledTimes(MAX_TOOL_TURNS);
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_TURNS);

    const errorEvent = events.find((e) => e.type === 'error') as
      | Extract<ChatStreamEvent, { type: 'error' }>
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error).toContain(`MAX_TOOL_TURNS=${MAX_TOOL_TURNS}`);
  });

  it('ANTHROPIC_API_KEY пуст → дружелюбное сообщение, без вызова SDK', async () => {
    const service = makeService({
      listTools: async () => [],
      execute: async () => 'x',
    });
    // Перетираем apiKey приватно — в реальном сценарии config.get
    // возвращает '' и поле остаётся пустым.
    (service as unknown as { apiKey: string }).apiKey = '';

    const events = await collect(
      service.streamResponse(userId, message, conversationId),
    );

    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(events[0]).toEqual({
      type: 'text',
      text: 'AI chat is not configured. Please set ANTHROPIC_API_KEY.',
    });
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});
