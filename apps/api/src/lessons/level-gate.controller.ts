import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LevelGateService } from './level-gate.service';

@UseGuards(JwtAuthGuard)
@Controller('lessons')
export class LevelGateController {
  constructor(private readonly service: LevelGateService) {}

  /** GET /api/lessons/level-gate — статус доступности следующего уровня. */
  @Get('level-gate')
  get(@Request() req: AuthenticatedRequest) {
    return this.service.getGate(req.user.id);
  }
}
