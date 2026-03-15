import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, StrategyOptions } from 'passport-oauth2';
import { OAuthProfile } from './google.strategy';

@Injectable()
export class ChessdotcomStrategy extends PassportStrategy(
  Strategy,
  'chessdotcom',
) {
  constructor(configService: ConfigService) {
    const options: StrategyOptions = {
      authorizationURL: 'https://oauth.chess.com/authorize',
      tokenURL: 'https://oauth.chess.com/token',
      clientID: configService.get<string>('CHESSDOTCOM_CLIENT_ID', ''),
      clientSecret: configService.get<string>('CHESSDOTCOM_CLIENT_SECRET', ''),
      callbackURL: configService.get<string>(
        'CHESSDOTCOM_CALLBACK_URL',
        'http://localhost:3001/auth/chessdotcom/callback',
      ),
      scope: ['openid', 'profile', 'email'],
    };
    super(options);
  }

  async userProfile(
    accessToken: string,
    done: (err: any, profile?: any) => void,
  ): Promise<void> {
    try {
      const response = await fetch('https://api.chess.com/pub/account', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = (await response.json()) as {
        username?: string;
        email?: string;
        '@id'?: string;
      };
      done(null, data);
    } catch (err) {
      done(err);
    }
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: (err: any, user?: any) => void,
  ): void {
    const providerId: string =
      profile['@id'] ?? profile.username ?? _accessToken;

    const oauthProfile: OAuthProfile = {
      provider: 'chessdotcom',
      providerId,
      email: profile.email ?? null,
      displayName: profile.username ?? providerId,
    };

    done(null, oauthProfile);
  }
}
