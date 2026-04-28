import {
  Controller,
  Get,
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
      const frontendUrl = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/login?oauthError=1`);
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
      const frontendUrl = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/login?oauthError=1`);
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
    const frontendUrl = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
    const url = new URL('/oauth/callback', frontendUrl);
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
}
