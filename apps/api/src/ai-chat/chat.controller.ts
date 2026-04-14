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
   * POST /api/chat — send message, receive SSE stream.
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

    // Rate limit check
    await this.chatService.checkRateLimit(userId);
    await this.chatService.incrementRateLimit(userId);

    // Get or create conversation
    const conversationId = await this.chatService.getOrCreateConversation(userId, body.conversationId);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Conversation-Id', conversationId);
    res.flushHeaders();

    try {
      for await (const chunk of this.chatService.streamResponse(userId, body.message, conversationId)) {
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true, conversationId })}\n\n`);
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }

    res.end();
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
