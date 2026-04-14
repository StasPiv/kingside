import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContextCollectorService } from './context-collector.service';

@Module({
  imports: [AuthModule],
  providers: [ContextCollectorService],
  exports: [ContextCollectorService],
})
export class AiChatModule {}
