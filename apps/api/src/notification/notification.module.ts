import { Module, forwardRef } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [forwardRef(() => MessageModule)],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
