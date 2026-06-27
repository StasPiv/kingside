import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  UseGuards,
  Request,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  GoogleAuthGuard,
  FacebookAuthGuard,
} from './oauth-auth.guard';
import type { RequestWithGuest } from '../common/guest-id.middleware';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_SIG_COOKIE,
  GUEST_ID_COOKIE,
} from '../events/events.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Request() req: RequestWithGuest,
    @Res({ passthrough: true }) res: Response,
  ) {
    // KS-4697 / ADR-147 §1.1: после успешной регистрации с активным
    // guest_id — мигрируем гостевые events/agg-ключи на новый user.id
    // и сбрасываем guest_id cookie (и связанные consent-cookies),
    // чтобы дальше клиент работал как authenticated. AuthService
    // делает merge внутри.
    const result = await this.authService.register(dto, req.guestId ?? null);
    if (req.guestId) {
      // KS-4716: Domain должен совпадать с domain'ом, под которым cookie
      // выписана GuestPublicController/GuestIdMiddleware — иначе
      // Set-Cookie с Max-Age=0 не «попадает» в правильную cookie и
      // старая остаётся жить.
      const cookieDomain = this.config.get<string>('COOKIE_DOMAIN') ?? null;
      for (const name of [GUEST_ID_COOKIE, ANALYTICS_CONSENT_COOKIE, ANALYTICS_CONSENT_SIG_COOKIE]) {
        const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
        if (cookieDomain) parts.push(`Domain=${cookieDomain}`);
        res.append('Set-Cookie', parts.join('; '));
      }
    }
    return result;
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @Post('dev-bypass')
  devBypass(@Body('secret') secret: string, @Body('user') user?: string) {
    return this.authService.devBypass(secret, user);
  }

  @Post('telegram')
  telegramAuth(@Body() dto: TelegramAuthDto) {
    return this.authService.telegramAuth(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: AuthenticatedRequest) {
    return this.authService.getMe(req.user.id);
  }

  // Google OAuth — initiation. Сам callback живёт в OAuthCallbackController
  // по пути `/api/auth/google/callback` (KS-2111: redirect URI в Google Cloud
  // Console и `GOOGLE_CALLBACK_URL` исторически содержат префикс `/api`).
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Redirects to Google
  }

  // Facebook OAuth — initiation. Callback в OAuthCallbackController
  // по пути `/api/auth/facebook/callback` (см. KS-2111).
  @UseGuards(FacebookAuthGuard)
  @Get('facebook')
  facebookAuth() {
    // Redirects to Facebook
  }
}
