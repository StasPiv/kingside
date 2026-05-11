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
    @Request() req: { user: OAuthProfile },
    @Res() res: Response,
  ) {
    const profile = req.user;
    this.logger.log(
      `[Google OAuth] callback received for ${profile?.email ?? profile?.providerId ?? 'unknown'}`,
    );
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
      return res.redirect(url.toString());
    }
  }

  @UseGuards(FacebookAuthGuard)
  @Get('facebook/callback')
  async facebookCallback(
    @Request() req: { user: OAuthProfile },
    @Res() res: Response,
  ) {
    const profile = req.user;
    this.logger.log(
      `[Facebook OAuth] callback received for ${profile?.email ?? profile?.providerId ?? 'unknown'}`,
    );
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
      return res.redirect(url.toString());
    }
  }

  private redirectWithTokens(
    res: Response,
    tokens: {
      accessToken: string;
      refreshToken: string;
      requiresUsernameSetup: boolean;
    },
  ) {
    const url = new URL('/oauth/callback', this.resolveFrontendOrigin());
    url.searchParams.set('accessToken', tokens.accessToken);
    url.searchParams.set('refreshToken', tokens.refreshToken);
    if (tokens.requiresUsernameSetup) {
      url.searchParams.set('requiresUsernameSetup', 'true');
    }
    this.logger.log(
      `[OAuth] redirect to ${url.origin}/oauth/callback?accessToken=...`,
    );
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
