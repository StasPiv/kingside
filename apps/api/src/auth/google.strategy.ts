import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';

export interface OAuthProfile {
  provider: string;
  providerId: string;
  email: string | null;
  displayName: string;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID', ''),
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET', ''),
      callbackURL: configService.get<string>(
        'GOOGLE_CALLBACK_URL',
        'http://localhost:3001/auth/google/callback',
      ),
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): void {
    const email: string | null =
      profile.emails?.[0]?.value ?? null;

    const oauthProfile: OAuthProfile = {
      provider: 'google',
      providerId: profile.id,
      email,
      displayName: profile.displayName ?? profile.id,
    };

    done(null, oauthProfile);
  }
}
