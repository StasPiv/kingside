import {
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { OAuthProfile } from './google.strategy';
import {
  FacebookAuthGuard,
  GoogleAuthGuard,
} from './oauth-auth.guard';

/**
 * KS-2111: после ADR-018 (снятие глобального префикса `/api` в API) основные
 * маршруты живут без `/api`, однако Google/Facebook OAuth Console и переменные
 * `GOOGLE_CALLBACK_URL` / `FACEBOOK_CALLBACK_URL` исторически указывают на
 * `/api/auth/<provider>/callback`. Чтобы не править внешние конфиги (Google
 * Cloud Console / Facebook App Dashboard) и сохранить совместимость с уже
 * выданными redirect URI, регистрируем callback-эндпоинты по пути с префиксом
 * `api/auth`. Initiation-маршруты (`/auth/google`, `/auth/facebook`) остаются
 * в основном `AuthController`.
 */
@Controller('api/auth')
export class OAuthCallbackController {
  private readonly logger = new Logger(OAuthCallbackController.name);

  constructor(private readonly authService: AuthService) {}

  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(
    @Request()
    req: {
      user: OAuthProfile;
      headers: Record<string, string | string[] | undefined>;
    },
    @Res() res: Response,
  ) {
    const profile = req.user;
    this.logCallbackEntry('Google', profile, req.headers);
    try {
      const tokens = await this.authService.findOrCreateOAuthUser(profile);
      this.logger.log(`[Google OAuth] tokens generated, redirecting to frontend`);
      return this.redirectWithTokens(res, tokens);
    } catch (err) {
      this.logger.error(
        `[Google OAuth] findOrCreateOAuthUser failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const url = new URL('/login', this.resolveFrontendOrigin());
      url.searchParams.set('oauthError', '1');
      this.setNoStoreHeaders(res);
      return res.redirect(url.toString());
    }
  }

  @UseGuards(FacebookAuthGuard)
  @Get('facebook/callback')
  async facebookCallback(
    @Request()
    req: {
      user: OAuthProfile;
      headers: Record<string, string | string[] | undefined>;
    },
    @Res() res: Response,
  ) {
    const profile = req.user;
    this.logCallbackEntry('Facebook', profile, req.headers);
    try {
      const tokens = await this.authService.findOrCreateOAuthUser(profile);
      this.logger.log(`[Facebook OAuth] tokens generated, redirecting to frontend`);
      return this.redirectWithTokens(res, tokens);
    } catch (err) {
      this.logger.error(
        `[Facebook OAuth] findOrCreateOAuthUser failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const url = new URL('/login', this.resolveFrontendOrigin());
      url.searchParams.set('oauthError', '1');
      this.setNoStoreHeaders(res);
      return res.redirect(url.toString());
    }
  }

  /**
   * KS-2788. Лог входа в callback с маркерами prefetch / bfcache /
   * service-worker. Помогает различать сценарии (mobile Chrome
   * Back-button с bfcache, browser prefetch, link rel=prerender).
   */
  private logCallbackEntry(
    provider: 'Google' | 'Facebook',
    profile: OAuthProfile,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    const identity = profile?.email ?? profile?.providerId ?? 'unknown';
    const purpose = headers['sec-purpose'] ?? headers['purpose'];
    const mode = headers['sec-fetch-mode'];
    const dest = headers['sec-fetch-dest'];
    const site = headers['sec-fetch-site'];
    const user = headers['sec-fetch-user'];
    const flags = [
      purpose ? `sec-purpose=${purpose}` : null,
      mode ? `sec-fetch-mode=${mode}` : null,
      dest ? `sec-fetch-dest=${dest}` : null,
      site ? `sec-fetch-site=${site}` : null,
      user ? `sec-fetch-user=${user}` : null,
    ].filter(Boolean);
    this.logger.log(
      `[${provider} OAuth] callback received for ${identity}${flags.length ? ` ${flags.join(' ')}` : ''}`,
    );
  }

  /**
   * KS-2788. На 302 ответе callback'а блокируем bfcache самой
   * api-страницы: Chrome mobile при Back-button иначе возвращает
   * пользователя на старый URL с одноразовым `code`. Симметрично
   * meta `Cache-Control: no-store` на /oauth/callback HTML (frontend
   * KS-2785).
   */
  private setNoStoreHeaders(res: Response): void {
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, max-age=0',
    );
    res.setHeader('Pragma', 'no-cache');
  }

  private redirectWithTokens(
    res: Response,
    tokens: {
      accessToken: string;
      refreshToken: string;
      requiresUsernameSetup: boolean;
      isNewUser: boolean;
    },
  ) {
    const url = new URL('/oauth/callback', this.resolveFrontendOrigin());
    url.searchParams.set('accessToken', tokens.accessToken);
    url.searchParams.set('refreshToken', tokens.refreshToken);
    if (tokens.requiresUsernameSetup) {
      url.searchParams.set('requiresUsernameSetup', 'true');
    }
    url.searchParams.set('isNewUser', tokens.isNewUser ? 'true' : 'false');
    this.logger.log(
      `[OAuth] redirect to ${url.origin}/oauth/callback?accessToken=...`,
    );
    this.setNoStoreHeaders(res);
    return res.redirect(url.toString());
  }

  /**
   * KS-2112: формирование redirect URL для OAuth-callback'ов.
   *
   * Источник истины — отдельная переменная `FRONTEND_URL` (один origin, без CSV).
   * Если она не задана, fallback — первый элемент `CORS_ORIGIN.split(',')`
   * (исторически на проде там CSV `https://kingside.site,https://www.kingside.site`,
   * см. KS-2112). Локальный дефолт — `http://localhost:5173`.
   *
   * Возвращается ровно `URL.origin` (схема + хост + порт), чтобы случайно
   * указанный путь/query не попали в base URL и не сломали `new URL(path, base)`.
   * При невалидном значении бросаем 500 — лучше явная ошибка, чем битый redirect
   * с JWT в URL на чужой хост.
   */
  private resolveFrontendOrigin(): string {
    const candidate =
      process.env.FRONTEND_URL?.trim() ||
      process.env.CORS_ORIGIN?.split(',')[0]?.trim() ||
      'http://localhost:5173';

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      this.logger.error(
        `[OAuth] invalid frontend origin: "${candidate}". Set FRONTEND_URL to a single valid URL (e.g. https://kingside.site).`,
      );
      throw new InternalServerErrorException(
        'OAuth redirect misconfigured: invalid FRONTEND_URL/CORS_ORIGIN',
      );
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.logger.error(
        `[OAuth] unsupported frontend origin protocol "${parsed.protocol}" in "${candidate}"`,
      );
      throw new InternalServerErrorException(
        'OAuth redirect misconfigured: unsupported FRONTEND_URL protocol',
      );
    }

    return parsed.origin;
  }
}
