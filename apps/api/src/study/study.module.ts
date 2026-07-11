import { Module } from '@nestjs/common';
import { StudyController } from './study.controller';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { StudyScheduleService } from './study-schedule.service';
import { NotificationChannelService } from './notification-channel.service';
import { TelegramBotService } from './telegram-bot.service';

/**
 * Модуль занятий (KS-4880 / ADR-160, задача 1 из 6): CRUD расписания
 * и каналов уведомлений + Telegram /start-webhook. Генератор занятий,
 * диспетчер уведомлений и трекинг прогресса — задачи 2, 3, 5 epic'а.
 *
 * PrismaModule и RedisModule — глобальные, импорт не нужен.
 */
@Module({
  controllers: [StudyController, TelegramWebhookController],
  providers: [StudyScheduleService, NotificationChannelService, TelegramBotService],
  exports: [StudyScheduleService, NotificationChannelService, TelegramBotService],
})
export class StudyModule {}
