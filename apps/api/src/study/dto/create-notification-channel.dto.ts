import { IsIn } from 'class-validator';
import type { NotificationChannelType } from '@kingside/shared';

/**
 * Тело `POST /study/channels` (KS-4880 / ADR-160 §4).
 * Email — фаза 2 (SMTP-инфраструктуры нет), поэтому в v1 принимаем
 * только telegram и onsite.
 */
export class CreateNotificationChannelDto {
  @IsIn(['telegram', 'onsite'])
  type!: NotificationChannelType;
}
