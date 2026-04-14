import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ContextCollectorService } from './context-collector.service';
import { buildSystemPrompt } from './system-prompt';

const MAX_MESSAGES_PER_CONVERSATION = 50;
const MAX_CONVERSATIONS_PER_USER = 10;
const RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_PER_DAY = 100;
const HISTORY_LIMIT = 10;

@Injectable()
export class ChatAssistantService {
  private readonly logger = new Logger(ChatAssistantService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly contextCollector: ContextCollectorService,
  ) {
    this.apiKey = this.config.get<string>('ANTHROPIC_API_KEY', '');
    this.model = this.config.get<string>('CHAT_MODEL', 'claude-3-haiku-20240307');
    this.maxTokens = parseInt(this.config.get<string>('CHAT_MAX_TOKENS', '1024'), 10);
  }

  async checkRateLimit(userId: string): Promise<void> {
    const minKey = `chat:rate:min:${userId}`;
    const dayKey = `chat:rate:day:${userId}`;

    const [minCount, dayCount] = await Promise.all([
      this.redis.get(minKey),
      this.redis.get(dayKey),
    ]);

    if (parseInt(minCount ?? '0', 10) >= RATE_LIMIT_PER_MIN) {
      throw new ForbiddenException('Rate limit: max 10 messages per minute');
    }
    if (parseInt(dayCount ?? '0', 10) >= RATE_LIMIT_PER_DAY) {
      throw new ForbiddenException('Rate limit: max 100 messages per day');
    }
  }

  async incrementRateLimit(userId: string): Promise<void> {
    const minKey = `chat:rate:min:${userId}`;
    const dayKey = `chat:rate:day:${userId}`;

    const pipe = this.redis.pipeline();
    pipe.incr(minKey);
    pipe.expire(minKey, 60);
    pipe.incr(dayKey);
    pipe.expire(dayKey, 86400);
    await pipe.exec();
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

  async *streamResponse(
    userId: string,
    message: string,
    conversationId: string,
    siteUrl?: string,
  ): AsyncGenerator<string> {
    if (!this.apiKey) {
      yield 'AI chat is not configured. Please set ANTHROPIC_API_KEY.';
      return;
    }

    // Collect context and build system prompt
    const context = await this.contextCollector.collectContext(userId);
    const resolvedSiteUrl = siteUrl || this.config.get<string>('SITE_URL', 'https://kingside.site');
    const systemPrompt = buildSystemPrompt(context, resolvedSiteUrl);

    // Get conversation history
    const history = await this.getHistory(conversationId);
    const messages = [
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: message },
    ];

    // Dynamic import Anthropic SDK
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });

    const stream = client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages,
    });

    let fullResponse = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && 'delta' in event) {
        const delta = event.delta as { type: string; text?: string };
        if (delta.type === 'text_delta' && delta.text) {
          fullResponse += delta.text;
          yield delta.text;
        }
      }
    }

    // Save both messages
    await this.saveMessage(conversationId, 'user', message);
    await this.saveMessage(conversationId, 'assistant', fullResponse);

    // Auto-title: use first message as title if conversation is new
    const conv = await this.prisma.chatConversation.findUnique({ where: { id: conversationId } });
    if (conv && !conv.title) {
      const title = message.slice(0, 100);
      await this.prisma.chatConversation.update({
        where: { id: conversationId },
        data: { title },
      });
    }
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
