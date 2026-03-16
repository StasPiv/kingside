import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-facebook';
import { OAuthProfile } from './google.strategy';

@Injectable()
export class FacebookStrategy extends PassportStrategy(Strategy, 'facebook') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('FACEBOOK_APP_ID') || 'not-configured',
      clientSecret: configService.get<string>('FACEBOOK_APP_SECRET') || 'not-configured',
      callbackURL: configService.get<string>(
        'FACEBOOK_CALLBACK_URL',
        'http://localhost:3001/api/auth/facebook/callback',
      ),
      profileFields: ['id', 'displayName', 'name', 'emails', 'photos'],
      scope: ['email'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: (err: any, user?: any) => void,
  ): void {
    const email: string | null =
      profile.emails?.[0]?.value ?? null;

    const fullName = [profile.name?.givenName, profile.name?.familyName]
      .filter(Boolean)
      .join(' ');

    const displayName =
      profile.displayName || fullName || profile.id;

    const oauthProfile: OAuthProfile = {
      provider: 'facebook',
      providerId: profile.id,
      email,
      displayName,
    };

    done(null, oauthProfile);
  }
}
