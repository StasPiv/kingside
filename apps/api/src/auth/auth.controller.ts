import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  Res,
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
    const tokens = await this.authService.findOrCreateOAuthUser(
      req.user as OAuthProfile,
    );
    return this.redirectWithTokens(res, tokens);
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
    const tokens = await this.authService.findOrCreateOAuthUser(
      req.user as OAuthProfile,
    );
    return this.redirectWithTokens(res, tokens);
  }

  private redirectWithTokens(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ) {
    const frontendUrl = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
    const url = new URL('/oauth/callback', frontendUrl);
    url.searchParams.set('accessToken', tokens.accessToken);
    url.searchParams.set('refreshToken', tokens.refreshToken);
    return res.redirect(url.toString());
  }
}
