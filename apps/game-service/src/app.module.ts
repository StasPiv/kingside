import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { GameModule } from './game/game.module';
import { ArenaModule } from './arena/arena.module';
import { MatchmakingModule } from './matchmaking/matchmaking.module';
import { ChatModule } from './chat/chat.module';
import { UserModule } from './user/user.module';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UserModule,
    GameModule,
    ArenaModule,
    MatchmakingModule,
    ChatModule,
  ],
})
export class AppModule {}
