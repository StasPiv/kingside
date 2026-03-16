import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { I18nService } from 'nestjs-i18n';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { OAuthProfile } from './google.strategy';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  async findOrCreateOAuthUser(profile: OAuthProfile) {
    // 1. Find by provider + providerId
    const byProvider = await this.prisma.user.findFirst({
      where: {
        oauthProvider: profile.provider,
        oauthProviderId: profile.providerId,
      },
    });
    if (byProvider) {
      const sanitizedDisplay = this.sanitizeUsername(profile.displayName);
      const sanitizedEmail = profile.email
        ? this.sanitizeUsername(profile.email.split('@')[0])
        : '';
      const baseUsername =
        sanitizedDisplay ||
        sanitizedEmail ||
        `user${profile.providerId.slice(0, 10)}`;

      let finalUsername = byProvider.username;

      if (byProvider.username !== baseUsername) {
        const correctUsername = await this.uniqueUsername(baseUsername);
        if (correctUsername !== byProvider.username) {
          finalUsername = correctUsername;
          await this.prisma.user.update({
            where: { id: byProvider.id },
            data: { username: correctUsername, lastSeenAt: new Date() },
          });
          return this.generateTokens(byProvider.id, finalUsername);
        }
      }

      await this.prisma.user.update({
        where: { id: byProvider.id },
        data: { lastSeenAt: new Date() },
      });
      return this.generateTokens(byProvider.id, finalUsername);
    }

    // 2. Find by email (link accounts)
    if (profile.email) {
      const byEmail = await this.prisma.user.findUnique({
        where: { email: profile.email },
      });
      if (byEmail) {
        await this.prisma.user.update({
          where: { id: byEmail.id },
          data: {
            oauthProvider: profile.provider,
            oauthProviderId: profile.providerId,
            lastSeenAt: new Date(),
          },
        });
        return this.generateTokens(byEmail.id, byEmail.username);
      }
    }

    // 3. Create new user
    const sanitizedDisplay = this.sanitizeUsername(profile.displayName);
    const sanitizedEmail = profile.email
      ? this.sanitizeUsername(profile.email.split('@')[0])
      : '';
    const baseUsername =
      sanitizedDisplay ||
      sanitizedEmail ||
      `user${profile.providerId.slice(0, 10)}`;
    const username = await this.uniqueUsername(baseUsername);

    const user = await this.prisma.user.create({
      data: {
        username,
        email: profile.email ?? null,
        passwordHash: null,
        oauthProvider: profile.provider,
        oauthProviderId: profile.providerId,
      },
    });

    return this.generateTokens(user.id, user.username);
  }

  private sanitizeUsername(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 20);
  }

  private async uniqueUsername(base: string): Promise<string> {
    let candidate = base;
    let attempt = 0;
    while (true) {
      const existing = await this.prisma.user.findUnique({
        where: { username: candidate },
      });
      if (!existing) return candidate;
      attempt++;
      candidate = `${base}_${attempt}`;
    }
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: dto.username }, { email: dto.email }],
      },
    });

    if (existing) {
      throw new ConflictException(this.i18n.t('messages.auth.usernameOrEmailTaken'));
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        passwordHash,
      },
    });

    return this.generateTokens(user.id, user.username);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });

    if (!user) {
      throw new UnauthorizedException(this.i18n.t('messages.auth.invalidCredentials'));
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException(this.i18n.t('messages.auth.invalidCredentials'));
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException(this.i18n.t('messages.auth.invalidCredentials'));
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    });

    return this.generateTokens(user.id, user.username);
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      return this.generateTokens(payload.sub, payload.username);
    } catch {
      throw new UnauthorizedException(this.i18n.t('messages.auth.invalidRefreshToken'));
    }
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
        createdAt: true,
        locale: true,
        boardTheme: true,
        pieceSet: true,
        soundEnabled: true,
      },
    });
    return user;
  }

  private generateTokens(userId: string, username: string) {
    const payload = { sub: userId, username };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_EXPIRES_IN', '15m'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN', '7d'),
    });

    return { accessToken, refreshToken };
  }
}
