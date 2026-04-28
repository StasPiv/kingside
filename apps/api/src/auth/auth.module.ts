import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { GoogleStrategy } from './google.strategy';
import { FacebookStrategy } from './facebook.strategy';
import { AdminEmailGuard } from './admin-email.guard';
import { AdminUserGuard, AdminUserService } from './admin-user.guard';
import { PrismaModule } from '../prisma/prisma.module';

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
  controllers: [AuthController],
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
  ],
  exports: [
    AuthService,
    JwtModule,
    AdminEmailGuard,
    AdminUserGuard,
    AdminUserService,
  ],
})
export class AuthModule {}
