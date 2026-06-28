import * as path from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AcceptLanguageResolver, I18nModule, QueryResolver } from 'nestjs-i18n';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { GameModule } from './game/game.module';
import { ArenaModule } from './arena/arena.module';
import { MatchmakingModule } from './matchmaking/matchmaking.module';
import { ChatModule } from './chat/chat.module';
import { UserModule } from './user/user.module';
import { HealthController } from './health.controller';
// KS-4750 / ADR-149 G4: HTTP-клиент для эмита actor-событий в apps/api.
import { EventsClientModule } from './events-client/events-client.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: { path: path.join(__dirname, '/i18n/'), watch: false },
      resolvers: [{ use: QueryResolver, options: ['lang'] }, AcceptLanguageResolver],
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UserModule,
    EventsClientModule,
    GameModule,
    ArenaModule,
    MatchmakingModule,
    ChatModule,
  ],
})
export class AppModule {}
