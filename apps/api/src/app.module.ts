import * as path from 'path';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  AcceptLanguageResolver,
  I18nModule,
  QueryResolver,
} from 'nestjs-i18n';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { GameModule } from './game/game.module';
import { PuzzleModule } from './puzzle/puzzle.module';
import { PuzzleRushModule } from './puzzle-rush/puzzle-rush.module';
import { TournamentModule } from './tournament/tournament.module';
import { AnalysisModule } from './analysis/analysis.module';
import { WorkshopModule } from './workshop/workshop.module';
import { BroadcastModule } from './broadcast/broadcast.module';
import { DgtModule } from './dgt/dgt.module';
import { ClientLogsModule } from './client-logs/client-logs.module';
import { PlayerModule } from './player/player.module';
import { MessageModule } from './message/message.module';
import { FriendModule } from './friend/friend.module';
import { NotificationModule } from './notification/notification.module';
import { ArenaModule } from './arena/arena.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import { FeedbackModule } from './feedback/feedback.module';
import { AdminModule } from './admin/admin.module';
import { MetricsModule } from './metrics/metrics.module';
import { LastSeenMiddleware } from './auth/last-seen.middleware';
import { HealthController } from './health.controller';
@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: {
        path: path.join(__dirname, '/i18n/'),
        watch: true,
      },
      resolvers: [
        { use: QueryResolver, options: ['lang'] },
        AcceptLanguageResolver,
      ],
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UserModule,
    GameModule,
    PuzzleRushModule,
    ArenaModule,
    PuzzleModule,
    TournamentModule,
    AnalysisModule,
    WorkshopModule,
    BroadcastModule,
    DgtModule,
    ClientLogsModule,
    PlayerModule,
    MessageModule,
    FriendModule,
    NotificationModule,
    AiChatModule,
    FeedbackModule,
    AdminModule,
    MetricsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LastSeenMiddleware).forRoutes('*');
  }
}
