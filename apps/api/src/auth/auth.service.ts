import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { I18nService } from 'nestjs-i18n';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
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
      await this.prisma.user.update({
        where: { id: byProvider.id },
        data: { lastSeenAt: new Date() },
      });
      return this.generateTokens(
        byProvider.id,
        byProvider.username,
        byProvider.requiresUsernameSetup,
      );
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
        return this.generateTokens(
          byEmail.id,
          byEmail.username,
          byEmail.requiresUsernameSetup,
        );
      }
    }

    // 3. Create new user — username set later via /users/set-username
    const user = await this.prisma.user.create({
      data: {
        username: null,
        requiresUsernameSetup: true,
        email: profile.email ?? null,
        passwordHash: null,
        oauthProvider: profile.provider,
        oauthProviderId: profile.providerId,
      },
    });

    return this.generateTokens(user.id, null, true);
  }

  private buildBaseUsername(profile: OAuthProfile): string {
    const namePart = [profile.firstName, profile.lastName]
      .filter(Boolean)
      .join('');
    const sanitizedName = namePart ? this.sanitizeUsername(namePart) : '';
    const sanitizedEmail = profile.email
      ? this.sanitizeUsername(profile.email.split('@')[0])
      : '';
    return (
      sanitizedName ||
      sanitizedEmail ||
      `user${profile.providerId.slice(0, 10)}`
    );
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

  async telegramAuth(dto: TelegramAuthDto) {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      throw new UnauthorizedException('Telegram auth not configured');
    }

    // Verify auth_date is not older than 24 hours
    const now = Math.floor(Date.now() / 1000);
    if (now - dto.auth_date > 86400) {
      throw new UnauthorizedException('Telegram auth_date is expired');
    }

    // Build data_check_string: sorted key=value pairs (excluding hash and undefined)
    const { hash, ...data } = dto;
    const checkString = Object.keys(data)
      .filter((key) => (data as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${key}=${(data as Record<string, unknown>)[key]}`)
      .join('\n');

    // secret_key = SHA256(bot_token)
    const secretKey = crypto.createHash('sha256').update(botToken).digest();
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (expectedHash !== hash) {
      throw new UnauthorizedException('Telegram hash verification failed');
    }

    const telegramId = String(dto.id);

    // Find existing user by telegram_id
    const existing = await this.prisma.user.findUnique({
      where: { telegramId },
    });

    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
      return this.generateTokens(
        existing.id,
        existing.username,
        existing.requiresUsernameSetup,
      );
    }

    // Create new user — username set later via /users/set-username
    const user = await this.prisma.user.create({
      data: {
        username: null,
        requiresUsernameSetup: true,
        email: null,
        passwordHash: null,
        telegramId,
      },
    });

    return this.generateTokens(user.id, null, true);
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

  private generateTokens(
    userId: string,
    username: string | null,
    requiresUsernameSetup = false,
  ) {
    const payload: Record<string, unknown> = { sub: userId, username };
    if (requiresUsernameSetup) {
      payload.requiresUsernameSetup = true;
    }

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_EXPIRES_IN', '15m'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN', '7d'),
    });

    return { accessToken, refreshToken, requiresUsernameSetup };
  }
}
