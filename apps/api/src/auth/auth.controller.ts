import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  Res,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  GoogleAuthGuard,
  FacebookAuthGuard,
} from './oauth-auth.guard';
import { OAuthProfile } from './google.strategy';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: any) {
    return this.authService.getMe(req.user.id);
  }

  // Google OAuth
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Redirects to Google
  }

  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(@Request() req: any, @Res() res: Response) {
    const profile = req.user as OAuthProfile;
    this.logger.log(`[Google OAuth] callback received for ${profile?.email ?? profile?.providerId ?? 'unknown'}`);
    try {
      const tokens = await this.authService.findOrCreateOAuthUser(profile);
      this.logger.log(`[Google OAuth] tokens generated, redirecting to frontend`);
      return this.redirectWithTokens(res, tokens);
    } catch (err) {
      this.logger.error(`[Google OAuth] findOrCreateOAuthUser failed: ${err instanceof Error ? err.message : String(err)}`);
      const frontendUrl = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/login?oauthError=1`);
    }
  }

  // Facebook OAuth
  @UseGuards(FacebookAuthGuard)
  @Get('facebook')
  facebookAuth() {
    // Redirects to Facebook
  }

  @UseGuards(FacebookAuthGuard)
  @Get('facebook/callback')
  async facebookCallback(@Request() req: any, @Res() res: Response) {
    const profile = req.user as OAuthProfile;
    this.logger.log(`[Facebook OAuth] callback received for ${profile?.email ?? profile?.providerId ?? 'unknown'}`);
    try {
      const tokens = await this.authService.findOrCreateOAuthUser(profile);
      this.logger.log(`[Facebook OAuth] tokens generated, redirecting to frontend`);
      return this.redirectWithTokens(res, tokens);
    } catch (err) {
      this.logger.error(`[Facebook OAuth] findOrCreateOAuthUser failed: ${err instanceof Error ? err.message : String(err)}`);
      const frontendUrl = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
      return res.redirect(`${frontendUrl}/login?oauthError=1`);
    }
  }

  private redirectWithTokens(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ) {
    const frontendUrl = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
    const url = new URL('/oauth/callback', frontendUrl);
    url.searchParams.set('accessToken', tokens.accessToken);
    url.searchParams.set('refreshToken', tokens.refreshToken);
    this.logger.log(`[OAuth] redirect to ${url.origin}/oauth/callback?accessToken=...`);
    return res.redirect(url.toString());
  }
}
