import {
  Body,
  Controller,
  Get,
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

    // Webhook mode: return JSON response
    if (this.chatService.isWebhookMode) {
      try {
        const response = await this.chatService.getResponse(userId, body.message, conversationId, siteUrl);
        return res.json({ conversationId, response });
      } catch (e: any) {
        return res.status(500).json({ error: e.message, conversationId });
      }
    }

    // Fallback: SSE stream via Anthropic API
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
