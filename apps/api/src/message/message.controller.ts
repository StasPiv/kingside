import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MessageService } from './message.service';
import { MessageGateway } from './message.gateway';
import { SendMessageDto } from './dto/send-message.dto';
import { MessageHistoryDto } from './dto/message-history.dto';

@UseGuards(JwtAuthGuard)
@Controller('messages')
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly messageGateway: MessageGateway,
  ) {}

  @Post()
  async sendMessage(@Request() req: AuthenticatedRequest, @Body() dto: SendMessageDto) {
    const message = await this.messageService.sendMessage(
      req.user.id,
      dto.receiverId,
      dto.text,
    );

    this.messageGateway.notifyNewMessage(message, req.user.username);

    return message;
  }

  @Get('conversations')
  getConversations(@Request() req: AuthenticatedRequest) {
    return this.messageService.getConversations(req.user.id);
  }

  @Get('unread-count')
  getUnreadCount(@Request() req: AuthenticatedRequest) {
    return this.messageService.getUnreadCount(req.user.id);
  }

  @Get(':userId')
  getMessageHistory(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() dto: MessageHistoryDto,
  ) {
    return this.messageService.getMessageHistory(
      req.user.id,
      userId,
      dto.limit,
      dto.offset,
    );
  }

  @Patch(':userId/read')
  markAsRead(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.messageService.markAsRead(req.user.id, userId);
  }
}
