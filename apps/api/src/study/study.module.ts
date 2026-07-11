import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { StudyController } from './study.controller';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { StudyScheduleService } from './study-schedule.service';
import { NotificationChannelService } from './notification-channel.service';
import { StudySessionService } from './study-session.service';
import { TelegramBotService } from './telegram-bot.service';
import { StudyPlanGeneratorService } from './study-plan-generator.service';
import { StudyProfileService } from './study-profile.service';
import { StudyGeneratorScheduler } from './study-generator.scheduler';
import { StudyDispatcherScheduler } from './study-dispatcher.scheduler';

/**
 * Модуль занятий (ADR-160):
 * - KS-4880 (задача 1): CRUD расписания и каналов уведомлений +
 *   Telegram /start-webhook.
 * - KS-4881 (задача 2): генератор занятий — таблица правил §2 +
 *   cron EVERY_HOUR с Redis-lock.
 * - KS-4882 (задача 3): диспетчер уведомлений — cron EVERY_MINUTE,
 *   onsite + Telegram, ретраи, i18n en/ru.
 * Трекинг прогресса — задача 5 epic'а.
 *
 * PrismaModule и RedisModule — глобальные, импорт не нужен.
 */
@Module({
  imports: [NotificationModule],
  controllers: [StudyController, TelegramWebhookController],
  providers: [
    StudyScheduleService,
    NotificationChannelService,
    StudySessionService,
    TelegramBotService,
    StudyPlanGeneratorService,
    StudyProfileService,
    StudyGeneratorScheduler,
    StudyDispatcherScheduler,
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
