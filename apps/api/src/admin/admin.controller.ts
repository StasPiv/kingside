import {
  Body, Controller, DefaultValuePipe, Delete, Get, Param,
  ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('feedback')
  listFeedback(
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('sort') sort?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.adminService.listFeedback({ type, status, sort, limit, offset });
  }

  @Get('feedback/new')
  newFeedback(@Query('since') since?: string) {
    return this.adminService.newFeedback(since);
  }

  @Patch('feedback/:id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: string },
  ) {
    return this.adminService.updateFeedbackStatus(id, body.status);
  }

  @Delete('feedback/:id')
  deleteFeedback(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteFeedback(id);
  }

  @Post('feedback/:id/comments')
  addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { message: string },
  ) {
    return this.adminService.addSupportComment(id, body.message);
  }

  @Delete('users/cleanup-bots')
  cleanupBots() {
    return this.adminService.cleanupBots();
  }

  @Delete('feedback/:feedbackId/comments/:commentId')
  deleteComment(
    @Param('feedbackId', ParseUUIDPipe) feedbackId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.adminService.deleteComment(commentId, feedbackId);
  }

  @Get('chat/conversations')
  listChatConversations(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.adminService.listChatConversations(limit, offset);
  }

  @Get('chat/conversations/:id/messages')
  getChatMessages(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getChatMessages(id);
  }
}
