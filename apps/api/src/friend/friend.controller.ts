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

@UseGuards(JwtAuthGuard)
@Controller('friends')
export class FriendController {
  constructor(private readonly friendService: FriendService) {}

  @Post('request/:userId')
  sendRequest(
    @Request() req: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.friendService.sendRequest(req.user.id, userId);
  }

  @Post('accept/:requestId')
  acceptRequest(
    @Request() req: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.friendService.acceptRequest(req.user.id, requestId);
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

  @Get('requests')
  getIncomingRequests(@Request() req: AuthenticatedRequest) {
    return this.friendService.getIncomingRequests(req.user.id);
  }
}
