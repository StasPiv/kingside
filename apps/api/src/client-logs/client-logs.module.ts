import { Module } from '@nestjs/common';
import { ClientLogsController } from './client-logs.controller';
import { IpRateLimitGuard } from './ip-rate-limit.guard';

@Module({
  controllers: [ClientLogsController],
  providers: [IpRateLimitGuard],
})
export class ClientLogsModule {}
