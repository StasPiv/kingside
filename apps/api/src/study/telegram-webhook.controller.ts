import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannelService } from './notification-channel.service';
import { TelegramBotService } from './telegram-bot.service';

/** Подмножество Telegram Update, нужное обработчику /start. */
interface TelegramUpdateBody {
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
}

/**
 * Webhook Telegram-бота (KS-4880 / ADR-160 §4).
 *
 * `POST /api/study/telegram/webhook` — публичный endpoint (без JWT):
 * его вызывает Telegram. Защита — `X-Telegram-Bot-Api-Secret-Token`:
 * при регистрации webhook'а (`setWebhook`) передаётся `secret_token`
 * из env `TELEGRAM_WEBHOOK_SECRET`, Telegram возвращает его в каждом
 * запросе. Если env задан — заголовок обязан совпасть (401 иначе);
 * не задан — проверка выключена (локальная разработка).
 *
 * Обрабатывается только `/start <token>`: токен → верификация
 * telegram-канала (chat_id → NotificationChannel.address,
 * verified_at = now). Остальные update'ы игнорируются с 200 —
 * иначе Telegram будет ретраить их бесконечно.
 */
@Controller('study/telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly channels: NotificationChannelService,
    private readonly telegramBot: TelegramBotService,
    config: ConfigService,
  ) {
    this.webhookSecret = config.get<string>('TELEGRAM_WEBHOOK_SECRET', '');
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleUpdate(
    @Body() update: TelegramUpdateBody,
    @Headers('x-telegram-bot-api-secret-token') secretHeader?: string,
  ): Promise<{ ok: true }> {
    if (this.webhookSecret && secretHeader !== this.webhookSecret) {
      throw new UnauthorizedException();
    }

    const text = update?.message?.text;
    const chatId = update?.message?.chat?.id;
    if (!text || chatId === undefined || chatId === null) return { ok: true };

    const match = /^\/start[ =]+(\S+)/.exec(text.trim());
    if (!match) return { ok: true };

    const verified = await this.channels.verifyTelegramByToken(
      match[1],
      String(chatId),
    );
    if (verified) {
      await this.telegramBot.sendMessage(
        String(chatId),
        '✅ Telegram подключён: сюда будут приходить напоминания о занятиях Kingside.',
      );
    } else {
      this.logger.warn(`/start with unknown or expired token from chat ${chatId}`);
      await this.telegramBot.sendMessage(
        String(chatId),
        'Ссылка устарела. Запросите новую в настройках уведомлений на сайте.',
      );
    }
    return { ok: true };
  }
}
