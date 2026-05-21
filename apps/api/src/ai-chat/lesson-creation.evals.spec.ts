/**
 * KS-3209 / ADR-074 §10 B5 — eval-сценарии «Создание уроков».
 *
 * Это **не** LLM-evals (мы не дёргаем Anthropic в CI). Это пара тестов на
 * каждый ожидаемый паттерн поведения:
 *   1) **Static prompt evals** — проверяем, что system-prompt содержит
 *      нужные инструкции (если они там есть, модель будет им следовать
 *      детерминированно при нормальной погоде).
 *   2) **Runtime evals** — гоняем `streamResponse` со сценарным mock'ом
 *      Anthropic SDK (см. chat-assistant.tool-loop.spec.ts) и проверяем,
 *      что:
 *        - когда модель шлёт `end_turn` (план без tool_use) — backend
 *          никаких tools не вызывает;
 *        - когда модель шлёт `tool_use` после «да» — backend выполняет
 *          tool через провайдер;
 *        - на «отмена» backend не делает ничего лишнего;
 *        - placeholder-логика покрывается prompt'ом (см. static eval 4);
 *        - превышение 10 шагов отсекается backend'ом (см. KS-3207 spec).
 *
 * Этот файл — финальная проверка всей цепочки B1..B5. Если все 5 evals
 * зелёные — ассистент готов к раскатке.
 */

import 'reflect-metadata';
import { buildSystemPrompt, __TESTING__ } from './system-prompt';
import type { UserContext } from './context-collector.service';
import type { FeatureFlagsSnapshot } from '@kingside/shared';

// ── Stubs ───────────────────────────────────────────────────────────

const SITE_URL = 'https://kingside.test';

const STUB_CONTEXT: UserContext = {
  profile: {
    username: 'alice',
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
    memberSince: '2024-01-01',
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
};

const FLAGS: FeatureFlagsSnapshot = {
  lessonsEnabled: true,
  puzzlesEnabled: true,
  broadcastsEnabled: true,
  tournamentsEnabled: true,
  assistantEnabled: true,
  drillsEnabled: true,
};

const PROMPT = buildSystemPrompt(STUB_CONTEXT, FLAGS, SITE_URL);

// ── Runtime harness (re-using KS-3205 mock pattern) ─────────────────

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ChatAssistantService } from './chat-assistant.service';
import type {
  AssistantToolsProvider,
  ChatStreamEvent,
} from './assistant-tools';

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: mockMessagesCreate };
  }
  return { __esModule: true, default: FakeAnthropic };
});

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
      create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ id: 'conv-1', title: null }),
      delete: jest.fn().mockResolvedValue({}),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ username: 'alice' }) },
  } as unknown as ConstructorParameters<typeof ChatAssistantService>[0];

  const redis = {} as ConstructorParameters<typeof ChatAssistantService>[1];

  const cfg: Record<string, string> = {
    ANTHROPIC_API_KEY: 'k',
    CHAT_MODEL: 'm',
    CHAT_MAX_TOKENS: '1024',
    AI_CHAT_WEBHOOK_URL: '',
    WEBHOOK_AUTH_TOKEN: '',
    CHAT_RATE_LIMIT_PER_MIN: '10',
    CHAT_RATE_LIMIT_PER_DAY: '100',
    CHAT_GLOBAL_DAILY_LIMIT: '1000',
    CHAT_MAX_MSG_LENGTH: '2000',
    SITE_URL,
  };
  const config: ConfigService = {
    get: (k: string, d?: string) => cfg[k] ?? d ?? '',
  } as unknown as ConfigService;

  const jwt = { sign: () => 't' } as unknown as JwtService;

  const ctx = {
    collectContext: jest.fn().mockResolvedValue(STUB_CONTEXT),
  } as unknown as ConstructorParameters<typeof ChatAssistantService>[4];
  const flags = {
    getFlags: jest.fn().mockResolvedValue(FLAGS),
  } as unknown as ConstructorParameters<typeof ChatAssistantService>[5];

  return new ChatAssistantService(
    prisma,
    redis,
    config,
    jwt,
    ctx,
    flags,
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

const FAKE_CREATE_COURSE_TOOL = {
  name: 'create_user_course',
  description: 'create course',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['title'],
  },
};

// ── Eval 1: план без подтверждения → tools НЕ вызываются ───────────

describe('KS-3209 eval 1: план без подтверждения → tools НЕ вызываются', () => {
  beforeEach(() => mockMessagesCreate.mockReset());

  it('prompt инструктирует не вызывать tools до подтверждения', () => {
    expect(PROMPT).toMatch(/Wait for explicit user confirmation/i);
    expect(PROMPT).toMatch(/propose a plan, do NOT call tools yet/i);
  });

  it('runtime: модель шлёт только text (план) — никаких tool_use → backend tools НЕ зовёт', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: '## План\n1. Курс «Эндшпиль для начинающих»\n2. Lesson: ладейные эндшпили (3 шага)\n\nГотово? Скажи "да" — создам.',
        },
      ],
    });
    const execute = jest.fn();
    const service = makeService({
      listTools: async () => [FAKE_CREATE_COURSE_TOOL],
      execute,
    });
    const events = await collect(
      service.streamResponse('user-1', 'сделай курс по эндшпилю', 'conv-1'),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(0);
  });
});

// ── Eval 2: подтверждение «да» → tools вызываются ──────────────────

describe('KS-3209 eval 2: подтверждение → tools вызываются', () => {
  beforeEach(() => mockMessagesCreate.mockReset());

  it('prompt перечисляет confirmation-токены (рус/eng)', () => {
    expect(PROMPT).toMatch(/да/);
    expect(PROMPT).toMatch(/yes/i);
    expect(PROMPT).toMatch(/ok/i);
    expect(PROMPT).toMatch(/confirm/i);
  });

  it('runtime: после "да" модель шлёт tool_use → backend выполняет tool', async () => {
    // turn 1: модель решает дёрнуть tool.
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Создаю курс…' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'create_user_course',
          input: { title: 'Эндшпиль' },
        },
      ],
    });
    // turn 2: финальный ответ.
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Готово: https://kingside.test/lessons/courses/endshpil' }],
    });
    const execute = jest.fn().mockResolvedValue(
      JSON.stringify({ id: 'c1', slug: 'endshpil', title: 'Эндшпиль' }),
    );
    const service = makeService({
      listTools: async () => [FAKE_CREATE_COURSE_TOOL],
      execute,
    });
    const events = await collect(
      service.streamResponse('user-1', 'да, создавай', 'conv-1'),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'user-1',
      'create_user_course',
      { title: 'Эндшпиль' },
    );
    const okCall = events.find(
      (e) => e.type === 'tool_call' && e.status === 'ok',
    );
    expect(okCall).toBeDefined();
  });
});

// ── Eval 3: отмена → tools НЕ вызываются, ассистент предлагает доработать ──

describe('KS-3209 eval 3: отмена → нет tools + предложение доработать план', () => {
  beforeEach(() => mockMessagesCreate.mockReset());

  it('prompt перечисляет cancellation-токены и инструктирует НЕ звать tools, а offer to revise', () => {
    expect(PROMPT).toMatch(/нет/);
    expect(PROMPT).toMatch(/отмена/);
    expect(PROMPT).toMatch(/cancel/i);
    expect(PROMPT).toMatch(/no/i);
    expect(PROMPT).toMatch(/do NOT call any creation tools/i);
    expect(PROMPT).toMatch(/Offer to revise the plan/i);
  });

  it('runtime: после "отмена" модель шлёт только text, никаких tool_use', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Хорошо, не создаю. Что бы ты хотел поменять — тему, уровень, количество шагов?',
        },
      ],
    });
    const execute = jest.fn();
    const service = makeService({
      listTools: async () => [FAKE_CREATE_COURSE_TOOL],
      execute,
    });
    const events = await collect(
      service.streamResponse('user-1', 'нет, отмена', 'conv-1'),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
  });
});

// ── Eval 4: запрет на выдумывание FEN/PGN/puzzle-id (KS-3226 v3) ───
//
// V2 ассистент мог создавать только text/quiz и для остального делал
// text-placeholder. V3 (KS-3226) добавил отдельные tool'ы для puzzle/
// game/drill/diagram — теперь правило формулируется не как
// «использовай text-placeholder», а как «не выдумывай позиции» (FEN/
// PGN/puzzleId). Этот блок переоформлен под новый словарь.

describe('KS-3209 eval 4: запрет на выдумывание FEN/PGN/puzzle-id (KS-3226 v3)', () => {
  it('prompt явно запрещает выдумывать FEN', () => {
    expect(PROMPT).toMatch(/НЕ выдумывай FEN/);
  });

  it('prompt явно запрещает выдумывать PGN', () => {
    expect(PROMPT).toMatch(/НЕ выдумывай PGN/);
  });

  it('prompt явно запрещает выдумывать puzzleId', () => {
    expect(PROMPT).toMatch(/НЕ выдумывай puzzleId/);
  });
});

// ── Eval 5: превышение лимита → план урезается до 15 ────────────────
//
// KS-3226 поднял лимит шагов 10 → 15.

describe('KS-3209 eval 5: >15 шагов → план урезается до 15 (KS-3226)', () => {
  it('prompt обозначает hard cap ≤15 шагов/урок и требует объяснения trim', () => {
    expect(PROMPT).toMatch(/≤\s*15|<=\s*15|15 steps per lesson/i);
    expect(PROMPT).toMatch(/trimmed|trim|hard backend cap/i);
  });

  it('prompt описывает backend-лимиты явно (text 4000, quiz 1-5×2-4, 5 курсов/час, 429)', () => {
    expect(PROMPT).toMatch(/4000/);
    expect(PROMPT).toMatch(/1.{0,5}5 questions/i);
    expect(PROMPT).toMatch(/2.{0,5}4 options/i);
    expect(PROMPT).toMatch(/5\s+`?create_user_course`?\s+calls per user per hour/i);
    expect(PROMPT).toMatch(/429/);
  });
});

// ── Sanity: LESSON_CREATION_WORKFLOW попадает в общий promt ─────────

describe('KS-3209 sanity: workflow секция включена в buildSystemPrompt', () => {
  it('секция "Lesson Creation Workflow" присутствует и идёт ПОСЛЕ features-каталога', () => {
    const idx = PROMPT.indexOf('## Lesson Creation Workflow');
    expect(idx).toBeGreaterThan(0);
    // должна идти после хотя бы одного "### " (feature heading в каталоге)
    const firstFeature = PROMPT.indexOf('### ');
    expect(firstFeature).toBeGreaterThan(0);
    expect(idx).toBeGreaterThan(firstFeature);
  });

  it('__TESTING__.LESSON_CREATION_WORKFLOW содержится дословно в выходе buildSystemPrompt', () => {
    expect(PROMPT).toContain(__TESTING__.LESSON_CREATION_WORKFLOW);
  });
});
