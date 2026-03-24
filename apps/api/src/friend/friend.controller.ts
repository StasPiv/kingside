import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { FriendService } from './friend.service';
import { MessageGateway } from '../message/message.gateway';

@UseGuards(JwtAuthGuard)
@Controller('friends')
export class FriendController {
  constructor(
    private readonly friendService: FriendService,
    private readonly messageGateway: MessageGateway,
  ) {}

  @Post('request/:userId')
  async sendRequest(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const result = await this.friendService.sendRequest(req.user.id, userId);
    this.messageGateway.notifyFriendRequestReceived(userId, {
      requestId: result.id,
      user: { id: req.user.id, username: req.user.username ?? 'anonymous' },
    });
    return result;
  }

  @Post('accept/:requestId')
  async acceptRequest(
    @Request() req: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    const result = await this.friendService.acceptRequest(req.user.id, requestId);
    this.messageGateway.notifyFriendRequestAccepted(result.requester.id, {
      requestId: result.id,
      user: { id: req.user.id, username: req.user.username ?? 'anonymous' },
    });
    return result;
  }

  @Post('decline/:requestId')
  declineRequest(
    @Request() req: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.friendService.declineRequest(req.user.id, requestId);
  }

  @Delete(':friendshipId')
  removeFriend(
    @Request() req: AuthenticatedRequest,
    @Param('friendshipId', ParseUUIDPipe) friendshipId: string,
  ) {
    return this.friendService.removeFriend(req.user.id, friendshipId);
  }

  @Get()
  getFriends(@Request() req: AuthenticatedRequest) {
    return this.friendService.getFriends(req.user.id);
  }

  @Get('status/:userId')
  getStatus(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.friendService.getStatus(req.user.id, userId);
  }

  @Get('requests')
  getIncomingRequests(@Request() req: AuthenticatedRequest) {
    return this.friendService.getIncomingRequests(req.user.id);
  }
}
