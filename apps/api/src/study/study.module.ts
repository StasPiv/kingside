import { Module } from '@nestjs/common';
import { StudyController } from './study.controller';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { StudyScheduleService } from './study-schedule.service';
import { NotificationChannelService } from './notification-channel.service';
import { TelegramBotService } from './telegram-bot.service';
import { StudyPlanGeneratorService } from './study-plan-generator.service';
import { StudyProfileService } from './study-profile.service';
import { StudyGeneratorScheduler } from './study-generator.scheduler';

/**
 * Модуль занятий (ADR-160):
 * - KS-4880 (задача 1): CRUD расписания и каналов уведомлений +
 *   Telegram /start-webhook.
 * - KS-4881 (задача 2): генератор занятий — таблица правил §2 +
 *   cron EVERY_HOUR с Redis-lock.
 * Диспетчер уведомлений и трекинг прогресса — задачи 3, 5 epic'а.
 *
 * PrismaModule и RedisModule — глобальные, импорт не нужен.
 */
@Module({
  controllers: [StudyController, TelegramWebhookController],
  providers: [
    StudyScheduleService,
    NotificationChannelService,
    TelegramBotService,
    StudyPlanGeneratorService,
    StudyProfileService,
    StudyGeneratorScheduler,
  ],
  exports: [
    StudyScheduleService,
    NotificationChannelService,
    TelegramBotService,
    StudyPlanGeneratorService,
    StudyProfileService,
  ],
})
export class StudyModule {}
