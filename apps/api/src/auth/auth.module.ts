import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { OAuthCallbackController } from './oauth-callback.controller';
import { InternalAuthController } from './internal-auth.controller';
import {
  ScreenshotTokenController,
  ScreenshotTokenRateLimitGuard,
} from './screenshot-token.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { GoogleStrategy } from './google.strategy';
import { FacebookStrategy } from './facebook.strategy';
import { AdminEmailGuard } from './admin-email.guard';
import { AdminUserGuard, AdminUserService } from './admin-user.guard';
import { InternalKeyGuard } from './internal-key.guard';
// KS-4454 / ADR-139 T2: machine-to-machine аутентификация автономных
// агентов через service-account токены `ks_sa_*`.
import { ServiceAccountGuard } from './service-account.guard';
// KS-4455 / ADR-139 T3: композитный гард admin OR service-account +
// проверка scope из @RequiredScope.
import { AdminOrServiceGuard } from './admin-or-service.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { McpExclude } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): auth-флоу никогда не для ассистента (login/refresh/
// OAuth/screenshot-token). `@McpExclude` ставится на модуль как
// страховка — даже если кто-то по ошибке добавит `@McpModule`, discovery
// service увидит exclude и пропустит весь модуль.
@McpExclude()
@Module({
  imports: [
    PassportModule,
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', '15m') },
      }),
    }),
  ],
  // KS-2304: ScreenshotTokenController — POST /api/internal/screenshot-token,
  // см. ADR-039 §4. Без auth, за RedisRateLimitGuard 10/60s; гард
  // подхватывается из global RedisModule (RedisService) + Reflector.
  controllers: [
    AuthController,
    OAuthCallbackController,
    InternalAuthController,
    ScreenshotTokenController,
  ],
  providers: [
    AuthService,
    JwtStrategy,
    GoogleStrategy,
    FacebookStrategy,
    // KS-1963: AdminEmailGuard — для @UseGuards в admin-роутах
    // (`/lessons/admin/*`, см. концепт KS-1962 §4).
    AdminEmailGuard,
    // KS-2108: AdminUserGuard / AdminUserService — whitelist по username
    // из KS_ADMIN_USERS env. Используется для админ-страницы feature flags
    // и `/profile/me/admin-status`.
    AdminUserGuard,
    AdminUserService,
    // KS-2182: InternalKeyGuard — shared-secret защита для
    // `/api/internal/*` endpoint'ов synthetic-bot-service.
    InternalKeyGuard,
    // KS-2305: rate-limit guard для screenshot-token с structured-log.
    ScreenshotTokenRateLimitGuard,
    // KS-4454 / ADR-139 T2.
    ServiceAccountGuard,
    // KS-4455 / ADR-139 T3.
    JwtAuthGuard,
    AdminOrServiceGuard,
  ],
  exports: [
    AuthService,
    JwtModule,
    AdminEmailGuard,
    AdminUserGuard,
    AdminUserService,
    InternalKeyGuard,
    ServiceAccountGuard,
    AdminOrServiceGuard,
  ],
})
export class AuthModule {}
