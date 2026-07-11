import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Тонкий клиент Telegram Bot API для модуля занятий (KS-4880 /
 * ADR-160 §4). Прямые HTTP-вызовы `api.telegram.org` — по образцу
 * `feedback.service.ts`, без библиотеки бота.
 *
 * Username бота (для deep-link `t.me/<bot>?start=...`) берётся через
 * `getMe` и кэшируется в памяти процесса — отдельный env не нужен,
 * username однозначно определяется токеном.
 */
@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly botToken: string;
  private cachedUsername: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
  }

  get configured(): boolean {
    return this.botToken.length > 0;
  }

  /** Username бота из getMe (кэш в памяти на весь lifetime процесса). */
  async getBotUsername(): Promise<string> {
    if (!this.configured) {
      throw new ServiceUnavailableException('TELEGRAM_BOT_TOKEN is not configured');
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
