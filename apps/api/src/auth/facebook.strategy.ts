import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-facebook';
import { OAuthProfile } from './google.strategy';

@Injectable()
export class FacebookStrategy extends PassportStrategy(Strategy, 'facebook') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('FACEBOOK_APP_ID', ''),
      clientSecret: configService.get<string>('FACEBOOK_APP_SECRET', ''),
      callbackURL: configService.get<string>(
        'FACEBOOK_CALLBACK_URL',
        'http://localhost:3001/auth/facebook/callback',
      ),
      profileFields: ['id', 'displayName', 'emails'],
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

    const oauthProfile: OAuthProfile = {
      provider: 'facebook',
      providerId: profile.id,
      email,
      displayName: profile.displayName ?? profile.id,
    };

    done(null, oauthProfile);
  }
}
