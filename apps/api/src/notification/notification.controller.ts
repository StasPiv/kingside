import { Controller, Get, Put, Param, Query, Request, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { NotificationService } from './notification.service';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  getAll(
    @Request() req: AuthenticatedRequest,
    @Query('unread') unread?: string,
  ) {
    return this.notificationService.getAll(req.user.id, unread === 'true');
  }

  @Get('unread-count')
  getUnreadCount(@Request() req: AuthenticatedRequest) {
    return this.notificationService.getUnreadCount(req.user.id);
  }

  @Put(':id/read')
  markAsRead(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationService.markAsRead(req.user.id, id);
  }

  @Put('read-all')
  markAllAsRead(@Request() req: AuthenticatedRequest) {
    return this.notificationService.markAllAsRead(req.user.id);
  }
}
