/**
 * Ошибка `BotTokenService.getToken`, обогащённая статусом ответа api.
 *
 * `status === 0` → сетевая ошибка (timeout, ECONNREFUSED и т.п.). Считаем
 * таким же 5xx (retry-able). Все иные коды по факту: 4xx — без ретрая,
 * 5xx — retry с backoff.
 */
export class BotTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BotTokenError';
  }

  /** Ответ типа 5xx или сетевая ошибка — повторяем по retry-policy. */
  isRetryable(): boolean {
    return this.status === 0 || (this.status >= 500 && this.status < 600);
  }
}
