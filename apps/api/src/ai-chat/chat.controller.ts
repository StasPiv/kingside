import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { ChatAssistantService } from './chat-assistant.service';

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);
  constructor(private readonly chatService: ChatAssistantService) {}

  /**
   * POST /api/chat — send message, receive SSE stream or JSON.
   * Body: { message: string, conversationId?: string }
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  async chat(
    @Request() req: AuthenticatedRequest,
    @Body() body: { message: string; conversationId?: string },
    @Res() res: Response,
  ) {
    const userId = req.user.id;
    const siteUrl = (req.headers.origin as string) || undefined;

    // Validate message length
    this.chatService.validateMessageLength(body.message ?? '');

    // Rate limit check (throws 429 with structured JSON)
    try {
      await this.chatService.checkRateLimit(userId);
    } catch (e: any) {
      if (e.status === 429) {
        const body = e.response;
        res.setHeader('Retry-After', String(body.retryAfter ?? 60));
        return res.status(429).json(body);
      }
      throw e;
    }
    await this.chatService.incrementRateLimit(userId);

    // Get or create conversation
    const conversationId = await this.chatService.getOrCreateConversation(userId, body.conversationId);

    // KS-3213 (откат KS-3211): на проде api НЕ имеет Anthropic-ключа,
    // чат идёт через webhook (внешний MCP-сервер тащит tools из
    // /_mcp/tools). Наши 4 lesson-tools теперь помечены ТАКЖЕ @McpTool
    // (KS-3213), так что webhook их подхватывает.
    if (this.chatService.isWebhookMode) {
      try {
        const response = await this.chatService.getResponse(userId, body.message, conversationId, siteUrl);
        return res.json({ conversationId, response });
      } catch (e: any) {
        // KS-3228: логируем error + stack — без этого 500 в проде
        // приходилось диагностировать по косвенным признакам. Сервис
        // уже логирует stage-detail; здесь — итоговая фиксация.
        this.logger.error(
          `chat[user=${userId.slice(0, 8)}] failed: ${e?.message ?? e}`,
          (e as Error)?.stack,
        );
        return res.status(500).json({
          error: e?.message ?? 'Internal error',
          conversationId,
        });
      }
    }

    // Fallback: SSE stream via Anthropic API (dev/локал без webhook).
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Conversation-Id', conversationId);
    res.flushHeaders();

    try {
      // KS-3205: streamResponse теперь yield'ит ChatStreamEvent
      // (см. assistant-tools.ts). Каждый event сериализуется в
      // одну SSE-строку. Финальное `[DONE]`-сообщение шлёт сам
      // generator (`event.type === 'done'`); добавляем conversationId
      // для UX.
      for await (const event of this.chatService.streamResponse(
        userId,
        body.message,
        conversationId,
        siteUrl,
      )) {
        if (event.type === 'done') {
          res.write(
            `data: ${JSON.stringify({ done: true, conversationId })}\n\n`,
          );
        } else {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
    }

    res.end();
  }

  /**
   * GET /api/chat/limits — current rate limit usage.
   */
  @UseGuards(JwtAuthGuard)
  @Get('limits')
  getLimits(@Request() req: AuthenticatedRequest) {
    return this.chatService.getLimits(req.user.id);
  }

  /**
   * GET /api/chat/conversations — list user's conversations.
   */
  @UseGuards(JwtAuthGuard)
  @Get('conversations')
  getConversations(@Request() req: AuthenticatedRequest) {
    return this.chatService.getConversations(req.user.id);
  }

  /**
   * GET /api/chat/conversations/:id — get conversation with messages.
   */
  @UseGuards(JwtAuthGuard)
  @Get('conversations/:id')
  getConversation(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.getConversation(req.user.id, id);
  }
}
