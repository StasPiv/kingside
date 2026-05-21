import {
  Inject,
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { ContextCollectorService } from './context-collector.service';
import { buildSystemPrompt } from './system-prompt';
import {
  ASSISTANT_TOOLS_PROVIDER,
  AssistantToolsProvider,
  ChatStreamEvent,
  MAX_TOOL_TURNS,
} from './assistant-tools';

const MAX_MESSAGES_PER_CONVERSATION = 50;
const MAX_CONVERSATIONS_PER_USER = 10;
const HISTORY_LIMIT = 10;

@Injectable()
export class ChatAssistantService {
  private readonly logger = new Logger(ChatAssistantService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  readonly rateLimitPerMin: number;
  readonly rateLimitPerDay: number;
  readonly globalDailyLimit: number;
  readonly maxMsgLength: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly contextCollector: ContextCollectorService,
    private readonly featureFlags: FeatureFlagsService,
    @Inject(ASSISTANT_TOOLS_PROVIDER)
    private readonly toolsProvider: AssistantToolsProvider,
  ) {
    this.apiKey = this.config.get<string>('ANTHROPIC_API_KEY', '');
    this.model = this.config.get<string>('CHAT_MODEL', 'claude-sonnet-4-20250514');
    this.maxTokens = parseInt(this.config.get<string>('CHAT_MAX_TOKENS', '1024'), 10);
    this.webhookUrl = this.config.get<string>('AI_CHAT_WEBHOOK_URL', '');
    this.webhookSecret = this.config.get<string>('WEBHOOK_AUTH_TOKEN', '');
    this.rateLimitPerMin = parseInt(this.config.get<string>('CHAT_RATE_LIMIT_PER_MIN', '10'), 10);
    this.rateLimitPerDay = parseInt(this.config.get<string>('CHAT_RATE_LIMIT_PER_DAY', '100'), 10);
    this.globalDailyLimit = parseInt(this.config.get<string>('CHAT_GLOBAL_DAILY_LIMIT', '1000'), 10);
    this.maxMsgLength = parseInt(this.config.get<string>('CHAT_MAX_MSG_LENGTH', '2000'), 10);
  }

  get isWebhookMode(): boolean {
    return !!this.webhookUrl;
  }

  /**
   * KS-3211 / регрессия ADR-074. Webhook-режим (KS-1481) делегирует
   * запрос внешнему MCP-серверу, у которого свой `tools[]` — наши
   * `@McpToolForAssistant` (in-process) туда не попадают. Controller
   * использует этот метод чтобы решить: если у текущего юзера есть
   * хотя бы один assistant-tool, нужно идти через `streamResponse`
   * (in-process Anthropic SDK с tool-use loop'ом из KS-3205), даже если
   * `AI_CHAT_WEBHOOK_URL` задан.
   *
   * Fail-safe: при ошибке listTools (Redis/DI/что-то ещё) — возвращаем
   * false и оставляем legacy webhook-маршрут, чтобы не уронить чат.
   */
  async hasAssistantTools(userId: string): Promise<boolean> {
    try {
      const tools = await this.toolsProvider.listTools(userId);
      return tools.length > 0;
    } catch (e) {
      this.logger.warn(
        `hasAssistantTools failed for user=${userId}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  validateMessageLength(message: string): void {
    if (message.length > this.maxMsgLength) {
      throw new BadRequestException(`Message too long: max ${this.maxMsgLength} characters`);
    }
  }

  async checkRateLimit(userId: string): Promise<void> {
    const minKey = `chat:rate:min:${userId}`;
    const dayKey = `chat:rate:day:${userId}`;
    const globalKey = `chat:rate:global:${new Date().toISOString().slice(0, 10)}`;

    const [minCount, dayCount, globalCount] = await Promise.all([
      this.redis.get(minKey),
      this.redis.get(dayKey),
      this.redis.get(globalKey),
    ]);

    const minUsed = parseInt(minCount ?? '0', 10);
    const dayUsed = parseInt(dayCount ?? '0', 10);
    const globalUsed = parseInt(globalCount ?? '0', 10);

    if (minUsed >= this.rateLimitPerMin) {
      throw new HttpException({
        error: 'rate_limit',
        retryAfter: 60,
        limits: { perMinute: { used: minUsed, max: this.rateLimitPerMin }, perDay: { used: dayUsed, max: this.rateLimitPerDay } },
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (dayUsed >= this.rateLimitPerDay) {
      throw new HttpException({
        error: 'rate_limit',
        retryAfter: this.secondsUntilMidnight(),
        limits: { perMinute: { used: minUsed, max: this.rateLimitPerMin }, perDay: { used: dayUsed, max: this.rateLimitPerDay } },
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (globalUsed >= this.globalDailyLimit) {
      throw new HttpException({
        error: 'rate_limit',
        retryAfter: this.secondsUntilMidnight(),
        limits: { perMinute: { used: minUsed, max: this.rateLimitPerMin }, perDay: { used: dayUsed, max: this.rateLimitPerDay }, globalDaily: { used: globalUsed, max: this.globalDailyLimit } },
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async incrementRateLimit(userId: string): Promise<void> {
    const minKey = `chat:rate:min:${userId}`;
    const dayKey = `chat:rate:day:${userId}`;
    const globalKey = `chat:rate:global:${new Date().toISOString().slice(0, 10)}`;

    const pipe = this.redis.pipeline();
    pipe.incr(minKey);
    pipe.expire(minKey, 60);
    pipe.incr(dayKey);
    pipe.expire(dayKey, 86400);
    pipe.incr(globalKey);
    pipe.expire(globalKey, 86400);
    await pipe.exec();
  }

  async getLimits(userId: string) {
    const minKey = `chat:rate:min:${userId}`;
    const dayKey = `chat:rate:day:${userId}`;
    const globalKey = `chat:rate:global:${new Date().toISOString().slice(0, 10)}`;

    const [minCount, dayCount, globalCount] = await Promise.all([
      this.redis.get(minKey),
      this.redis.get(dayKey),
      this.redis.get(globalKey),
    ]);

    return {
      perMinute: { used: parseInt(minCount ?? '0', 10), max: this.rateLimitPerMin, resetsIn: 60 },
      perDay: { used: parseInt(dayCount ?? '0', 10), max: this.rateLimitPerDay, resetsIn: this.secondsUntilMidnight() },
      globalDaily: { used: parseInt(globalCount ?? '0', 10), max: this.globalDailyLimit },
      maxMessageLength: this.maxMsgLength,
    };
  }

  private secondsUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
  }

  async getOrCreateConversation(userId: string, conversationId?: string): Promise<string> {
    if (conversationId) {
      const conv = await this.prisma.chatConversation.findFirst({
        where: { id: conversationId, userId },
      });
      if (conv) return conv.id;
    }

    // Check conversation limit
    const count = await this.prisma.chatConversation.count({ where: { userId } });
    if (count >= MAX_CONVERSATIONS_PER_USER) {
      // Delete oldest
      const oldest = await this.prisma.chatConversation.findFirst({
        where: { userId },
        orderBy: { updatedAt: 'asc' },
      });
      if (oldest) {
        await this.prisma.chatConversation.delete({ where: { id: oldest.id } });
      }
    }

    const conv = await this.prisma.chatConversation.create({
      data: { userId },
    });
    return conv.id;
  }

  async saveMessage(conversationId: string, role: string, content: string): Promise<void> {
    // Check message limit
    const count = await this.prisma.chatAssistantMessage.count({ where: { conversationId } });
    if (count >= MAX_MESSAGES_PER_CONVERSATION) {
      // Delete oldest messages to stay within limit
      const oldest = await this.prisma.chatAssistantMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: 2,
        select: { id: true },
      });
      await this.prisma.chatAssistantMessage.deleteMany({
        where: { id: { in: oldest.map((m) => m.id) } },
      });
    }

    await this.prisma.chatAssistantMessage.create({
      data: { conversationId, role, content },
    });

    await this.prisma.chatConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  async getHistory(conversationId: string): Promise<Array<{ role: string; content: string }>> {
    const messages = await this.prisma.chatAssistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });
    return messages.reverse();
  }

  /**
   * KS-3205 / ADR-074 §10 B1. SSE-генератор ответа ассистента с
   * поддержкой tool-use loop'а.
   *
   * Контракт: yield'ит `ChatStreamEvent`-ы:
   *   - `text`     — токены финального assistant-сообщения (или сообщение
   *                  об ошибке инициализации, если ANTHROPIC_API_KEY пуст).
   *   - `tool_call`— фазы tool-use (`running` → `ok`/`error`).
   *   - `error`    — фатальная ошибка (MAX_TOOL_TURNS, исключение из SDK).
   *   - `done`     — конец stream'а.
   *
   * Loop: каждый turn вызывает `messages.create` с tools. Если
   * `stop_reason==='tool_use'` — выполняем все `tool_use`-блоки,
   * пушим `assistant`+`tool_result` в messages, повторяем (макс.
   * `MAX_TOOL_TURNS` итераций). На `end_turn`/`stop_sequence` —
   * стримим текст финального ответа.
   *
   * Tools берутся из `AssistantToolsProvider` (KS-3206 подключит
   * `McpAssistantRegistry`; до тех пор NoOp = пусто, loop сразу
   * вырождается в один обычный turn).
   */
  async *streamResponse(
    userId: string,
    message: string,
    conversationId: string,
    siteUrl?: string,
  ): AsyncGenerator<ChatStreamEvent> {
    if (!this.apiKey) {
      yield {
        type: 'text',
        text: 'AI chat is not configured. Please set ANTHROPIC_API_KEY.',
      };
      yield { type: 'done' };
      return;
    }

    // Collect context and build system prompt.
    // KS-2962 / ADR-062 §9: snapshot флагов читается на каждый запрос,
    // не кэшируется в самом промте (флаги runtime-меняемые).
    const context = await this.contextCollector.collectContext(userId);
    const flags = await this.featureFlags.getFlags();
    const resolvedSiteUrl = siteUrl || this.config.get<string>('SITE_URL', 'https://kingside.site');
    const systemPrompt = buildSystemPrompt(context, flags, resolvedSiteUrl);

    // Get conversation history
    const history = await this.getHistory(conversationId);
    // messages в формате Anthropic Messages API: assistant-ответы с
    // tool_use и user-ответы с tool_result хранятся внутри loop'а как
    // массив content-блоков. История из БД — простые text-сообщения.
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: message },
    ];

    // Список tool'ов для текущего пользователя.
    let tools: Awaited<ReturnType<AssistantToolsProvider['listTools']>>;
    try {
      tools = await this.toolsProvider.listTools(userId);
    } catch (e) {
      this.logger.warn(
        `toolsProvider.listTools failed for user=${userId}: ${(e as Error).message}`,
      );
      tools = [];
    }

    // Dynamic import Anthropic SDK
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });

    let fullResponse = '';
    let turn = 0;
    try {
      while (turn < MAX_TOOL_TURNS) {
        turn += 1;
        // Если tools пуст — Anthropic SDK не примет пустой массив для
        // tools в свежих ревизиях API. Опускаем поле полностью.
        const createParams: {
          model: string;
          max_tokens: number;
          system: string;
          messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
          tools?: typeof tools;
        } = {
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemPrompt,
          messages,
        };
        if (tools.length > 0) createParams.tools = tools;

        const response = await client.messages.create(
          createParams as Parameters<typeof client.messages.create>[0],
        );

        const stopReason = (response as { stop_reason?: string }).stop_reason ?? null;
        const content = (response as { content?: Array<Record<string, unknown>> }).content ?? [];

        // Если модель не вызывает tools — нормальный финальный turn.
        // Стримим текст блок-за-блоком (без content_block_delta — SDK
        // нам уже отдал полное сообщение). Для UX это «псевдо-стрим»,
        // но в B1 фокус на tool-use loop'е; реальный SSE streaming
        // конкретного финального turn'а можно подключить отдельно.
        if (stopReason !== 'tool_use') {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              fullResponse += block.text;
              yield { type: 'text', text: block.text };
            }
          }
          break;
        }

        // stop_reason === 'tool_use'. Сохраняем assistant-сообщение
        // (со ВСЕМИ content-блоками — text/tool_use), затем для каждого
        // tool_use-блока выполняем tool и собираем tool_result-блоки в
        // следующее user-сообщение.
        messages.push({ role: 'assistant', content });
        // Текст перед tool_use — тоже стримим (модель часто пишет
        // «сейчас посмотрю …» прежде чем дёрнуть tool).
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            fullResponse += block.text;
            yield { type: 'text', text: block.text };
          }
        }

        const toolResults: Array<Record<string, unknown>> = [];
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const toolUseId = String(block.id ?? '');
          const toolName = String(block.name ?? '');
          const toolInput = block.input ?? {};
          yield {
            type: 'tool_call',
            id: toolUseId,
            name: toolName,
            input: toolInput,
            status: 'running',
          };
          try {
            const output = await this.toolsProvider.execute(
              userId,
              toolName,
              toolInput,
            );
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: output,
            });
            yield {
              type: 'tool_call',
              id: toolUseId,
              name: toolName,
              input: toolInput,
              status: 'ok',
              output,
            };
          } catch (e) {
            const errMsg = (e as Error).message ?? String(e);
            this.logger.warn(
              `tool '${toolName}' failed for user=${userId}: ${errMsg}`,
            );
            // Пробрасываем ошибку обратно модели — она сможет
            // отрепортовать пользователю / попробовать другой tool.
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              is_error: true,
              content: errMsg,
            });
            yield {
              type: 'tool_call',
              id: toolUseId,
              name: toolName,
              input: toolInput,
              status: 'error',
              error: errMsg,
            };
          }
        }
        messages.push({ role: 'user', content: toolResults });
      }

      if (turn >= MAX_TOOL_TURNS) {
        // Hit лимит — не дали финальный текст. Сообщаем фронту явной
        // ошибкой; assistant-сообщение в БД сохраним как fullResponse
        // (то, что модель успела сгенерировать в тексте до tool_use'ов).
        const errMsg = `tool-use loop exceeded MAX_TOOL_TURNS=${MAX_TOOL_TURNS}`;
        this.logger.warn(`${errMsg} for user=${userId}`);
        yield { type: 'error', error: errMsg };
      }
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      this.logger.error(`streamResponse failed for user=${userId}: ${errMsg}`);
      yield { type: 'error', error: errMsg };
    }

    // Save both messages (даже при ошибке — fullResponse может быть
    // не пуст, и его лучше сохранить).
    await this.saveMessage(conversationId, 'user', message);
    if (fullResponse.length > 0) {
      await this.saveMessage(conversationId, 'assistant', fullResponse);
    }

    // Auto-title: use first message as title if conversation is new
    const conv = await this.prisma.chatConversation.findUnique({ where: { id: conversationId } });
    if (conv && !conv.title) {
      const title = message.slice(0, 100);
      await this.prisma.chatConversation.update({
        where: { id: conversationId },
        data: { title },
      });
    }

    yield { type: 'done' };
  }

  async getResponse(
    userId: string,
    message: string,
    conversationId: string,
    siteUrl?: string,
  ): Promise<string> {
    // Collect context and build system prompt.
    // KS-2962 / ADR-062 §9: snapshot флагов читается на каждый запрос,
    // не кэшируется в самом промте (флаги runtime-меняемые).
    const context = await this.contextCollector.collectContext(userId);
    const flags = await this.featureFlags.getFlags();
    const resolvedSiteUrl = siteUrl || this.config.get<string>('SITE_URL', 'https://kingside.site');
    const systemPrompt = buildSystemPrompt(context, flags, resolvedSiteUrl);

    // Get conversation history
    const history = await this.getHistory(conversationId);
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // KS-2947: `userToken` отправляется в webhook → MCP-сервер
    // прокладывает его как Bearer в публичный API. Раньше токен
    // подписывался с `{ sub }` и `expiresIn: '2m'`:
    //   - 2m — слишком короткий бюджет на webhook + Claude
    //     (latency + thinking + 2-3 tool call'а) и токен мог истечь
    //     посреди диалога → API отвечал 401 → ассистент видел
    //     «API не отвечает». Поднимаем до 15m — совпадает с обычным
    //     `JWT_EXPIRES_IN` для пользовательских токенов.
    //   - `{ sub }` без `username` означал, что `JwtStrategy.validate`
    //     возвращал `req.user.username = undefined`; endpoint'ы,
    //     полагающиеся на username (не критичные для MCP, но
    //     всё-таки), могли падать. Прокидываем username из БД.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    const userToken = this.jwtService.sign(
      { sub: userId, username: user?.username ?? null },
      { expiresIn: '15m' },
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    let responseText: string;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.webhookSecret) headers['Authorization'] = `Bearer ${this.webhookSecret}`;
      const res = await fetch(this.webhookUrl, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ message, systemPrompt, history: messages, userId, userToken }),
      });
      if (!res.ok) {
        this.logger.warn(`AI webhook failed: ${res.status}`);
        throw new Error(`AI webhook returned ${res.status}`);
      }
      const data = await res.json() as { response?: string };
      responseText = data.response ?? '';
    } finally {
      clearTimeout(timer);
    }

    // Save both messages
    await this.saveMessage(conversationId, 'user', message);
    await this.saveMessage(conversationId, 'assistant', responseText);

    // Auto-title
    const conv = await this.prisma.chatConversation.findUnique({ where: { id: conversationId } });
    if (conv && !conv.title) {
      const title = message.slice(0, 100);
      await this.prisma.chatConversation.update({
        where: { id: conversationId },
        data: { title },
      });
    }

    return responseText;
  }

  async getConversations(userId: string) {
    return this.prisma.chatConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async getConversation(userId: string, conversationId: string) {
    const conv = await this.prisma.chatConversation.findFirst({
      where: { id: conversationId, userId },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, role: true, content: true, createdAt: true } },
      },
    });
    return conv;
  }
}
