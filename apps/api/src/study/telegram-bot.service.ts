import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Тонкий клиент Telegram Bot API для модуля занятий (KS-4880 /
 * ADR-160 §4). Прямые HTTP-вызовы `api.telegram.org` — по образцу
 * `feedback.service.ts`, без библиотеки бота.
 *
 * KS-4891: модуль занятий работает ТОЛЬКО с ОТДЕЛЬНЫМ ботом
 * (`TELEGRAM_STUDY_BOT_TOKEN`). Использовать общий `TELEGRAM_BOT_TOKEN`
 * нельзя: у Telegram-бота ровно один webhook, и у общего бота он занят
 * инфраструктурой агентской переписки — `/start` уходил туда и
 * подтверждение канала не срабатывало. Кроме того, chat считается
 * начатым per-бот: подтверждение и отправка обязаны идти от одного
 * и того же бота.
 *
 * Пока `TELEGRAM_STUDY_BOT_TOKEN` не задан: `configured=false`,
 * подключение Telegram-канала отвечает 503 (см.
 * NotificationChannelService), диспетчер пишет ошибку в
 * StudyNotification и доставляет onsite.
 *
 * Автонастройка webhook: при старте, если заданы токен и
 * `STUDY_TELEGRAM_WEBHOOK_URL` (полный URL до
 * `/study/telegram/webhook`), вызывается `setWebhook` с
 * `secret_token = TELEGRAM_WEBHOOK_SECRET` (если задан). Идемпотентно —
 * повторный вызов с тем же URL безвреден (blue/green: оба инстанса
 * ставят одно и то же).
 *
 * Username бота (для deep-link `t.me/<bot>?start=...`) берётся через
 * `getMe` и кэшируется в памяти процесса — отдельный env не нужен,
 * username однозначно определяется токеном.
 */
@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly botToken: string;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private cachedUsername: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.botToken = this.config.get<string>('TELEGRAM_STUDY_BOT_TOKEN', '');
    this.webhookUrl = this.config.get<string>('STUDY_TELEGRAM_WEBHOOK_URL', '');
    this.webhookSecret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET', '');
  }

  get configured(): boolean {
    return this.botToken.length > 0;
  }

  async onModuleInit(): Promise<void> {
    if (!this.configured) {
      this.logger.warn(
        'TELEGRAM_STUDY_BOT_TOKEN не задан — подключение Telegram-канала занятий недоступно (KS-4891)',
      );
      return;
    }
    if (!this.webhookUrl) {
      this.logger.warn(
        'STUDY_TELEGRAM_WEBHOOK_URL не задан — setWebhook не вызывается, /start-подтверждения не придут',
      );
      return;
    }
    // Fire-and-forget: недоступность Telegram не должна ронять старт API.
    this.registerWebhook().catch((e) =>
      this.logger.error(`setWebhook failed: ${(e as Error).message}`),
    );
  }

  /** Регистрация webhook study-бота (идемпотентно). */
  async registerWebhook(): Promise<void> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: this.webhookUrl,
          allowed_updates: ['message'],
          ...(this.webhookSecret && { secret_token: this.webhookSecret }),
        }),
      },
    );
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    if (!res.ok || !body?.ok) {
      this.logger.error(
        `setWebhook(${this.webhookUrl}) failed: HTTP ${res.status} ${body?.description ?? ''}`,
      );
      return;
    }
    this.logger.log(`study bot webhook registered: ${this.webhookUrl}`);
  }

  /** Username study-бота из getMe (кэш в памяти на весь lifetime процесса). */
  async getBotUsername(): Promise<string> {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Telegram study bot is not configured (TELEGRAM_STUDY_BOT_TOKEN)',
      );
    }
    if (this.cachedUsername) return this.cachedUsername;

    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/getMe`);
    if (!res.ok) {
      this.logger.error(`getMe failed: HTTP ${res.status}`);
      throw new ServiceUnavailableException('Telegram getMe failed');
    }
    const body = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    const username = body.ok ? body.result?.username : undefined;
    if (!username) {
      throw new ServiceUnavailableException('Telegram getMe returned no username');
    }
    this.cachedUsername = username;
    return username;
  }

  /**
   * Отправка с ответом об успехе — для диспетчера (KS-4882): false
   * уходит в StudyNotification.error и ретраится следующим тиком.
   */
  async sendMessageStrict(chatId: string, text: string): Promise<boolean> {
    if (!this.configured) return false;
    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
    if (!res.ok) {
      this.logger.warn(`sendMessage to ${chatId} failed: HTTP ${res.status}`);
    }
    return res.ok;
  }

  /** Отправка сообщения в чат; ошибки логируются, не бросаются. */
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.configured) return;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      );
      if (!res.ok) {
        this.logger.warn(`sendMessage to ${chatId} failed: HTTP ${res.status}`);
      }
    } catch (e) {
      this.logger.warn(`sendMessage to ${chatId} failed: ${(e as Error).message}`);
    }
  }
}
