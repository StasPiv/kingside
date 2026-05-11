/**
 * KS-2784. Exception filter для `OAuthCallbackController`.
 *
 * Контекст: после успешного первого callback'а от Google/Facebook
 * пользовательский браузер иногда повторно дёргает тот же
 * `/api/auth/<provider>/callback` URL с уже использованным `code`
 * (PWA service worker / back-forward cache / повторный mount
 * SPA-страницы). Google/Facebook отвечают 400 на повторное
 * использование кода → passport-oauth2 бросает `TokenError: Bad
 * Request` → NestJS default-handler отдаёт 500-JSON, пользователь
 * видит белый экран с ошибкой.
 *
 * Mitigation: перехватываем ЛЮБЫЕ ошибки в OAuth-callback ветке и
 * делаем 302-redirect на `/login?oauthError=1`. Корень (повторный
 * hit с тем же code) лечится на фронте — KS-2785 (history.replaceState
 * + exclude `/api/auth/*` из SW cache).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class OAuthCallbackErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(OAuthCallbackErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ url?: string }>();

    const errMsg =
      exception instanceof Error ? exception.message : String(exception);
    const errName = exception instanceof Error ? exception.name : 'Unknown';
    this.logger.warn(
      `[OAuth] callback error path=${req?.url ?? 'unknown'} ${errName}: ${errMsg} — redirecting to /login?oauthError=1`,
    );

    let origin: string;
    try {
      origin = resolveFrontendOrigin();
    } catch (e) {
      // Не падаем дальше — если даже origin битый, отдаём 500 без
      // компрометирующих данных (passport-токены наружу не уезжают).
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `[OAuth] cannot resolve frontend origin, returning 500: ${msg}`,
      );
      if (!res.headersSent) {
        res
          .status(500)
          .json({ statusCode: 500, message: 'OAuth misconfigured' });
      }
      return;
    }

    const url = new URL('/login', origin);
    url.searchParams.set('oauthError', '1');
    if (!res.headersSent) {
      res.redirect(url.toString());
    }
  }
}

/**
 * Дубликат `resolveFrontendOrigin` из `OAuthCallbackController`.
 * Логика общая — берём `FRONTEND_URL` / первый из `CORS_ORIGIN` CSV
 * / localhost-дефолт. Кидаем явную ошибку при невалидном URL —
 * лучше 500, чем редирект на чужой хост.
 */
export function resolveFrontendOrigin(): string {
  const candidate =
    process.env.FRONTEND_URL?.trim() ||
    process.env.CORS_ORIGIN?.split(',')[0]?.trim() ||
    'http://localhost:5173';
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InternalServerErrorException(
      'OAuth redirect misconfigured: invalid FRONTEND_URL/CORS_ORIGIN',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InternalServerErrorException(
      'OAuth redirect misconfigured: unsupported FRONTEND_URL protocol',
    );
  }
  return parsed.origin;
}
