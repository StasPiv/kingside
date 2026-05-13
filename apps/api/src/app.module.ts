import * as path from 'path';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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
import { PrecisionModule } from './precision/precision.module';
import { PuzzleRushModule } from './puzzle-rush/puzzle-rush.module';
import { TournamentModule } from './tournament/tournament.module';
import { AnalysisModule } from './analysis/analysis.module';
import { WorkshopModule } from './workshop/workshop.module';
import { LiveTournamentModule } from './live-tournament/live-tournament.module';
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
import { LessonsModule } from './lessons/lessons.module';
// KS-1927: MistakesModule переехал в `puzzle/` namespace (ADR-032 §4).
import { MistakesModule } from './puzzle/mistakes.module';
import { UserCoursesModule } from './lessons/user-courses/user-courses.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { ProfileModule } from './profile/profile.module';
import { TacticDrillModule } from './tactic-drill/tactic-drill.module';
import { StudyModule } from './study/study.module';
import { McpModule } from './mcp/mcp.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
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
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    AuthModule,
    UserModule,
    GameModule,
    PuzzleRushModule,
    ArenaModule,
    PuzzleModule,
    PrecisionModule,
    TournamentModule,
    AnalysisModule,
    WorkshopModule,
    LiveTournamentModule,
    ClientLogsModule,
    PlayerModule,
    MessageModule,
    FriendModule,
    NotificationModule,
    AiChatModule,
    FeedbackModule,
    AdminModule,
    MetricsModule,
    LessonsModule,
    MistakesModule,
    UserCoursesModule,
    FeatureFlagsModule,
    ProfileModule,
    TacticDrillModule,
    // KS-2815 / ADR-059 (KS-2818 T3). Учебные студии — самостоятельная
    // фича (см. docs/architecture/KS-2815-studies-standalone.md).
    StudyModule,
    // KS-2952 / ADR-061 этап A. MCP auto-discovery: GET /_mcp/tools.
    McpModule,
    // KS-2967 / ADR-063 Phase 2. Knowledge-tools для AI-ассистента —
    // search/read по allowlist репозитория. Регистрируется в MCP как
    // section `knowledge`.
    KnowledgeModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LastSeenMiddleware).forRoutes('*');
  }
}
