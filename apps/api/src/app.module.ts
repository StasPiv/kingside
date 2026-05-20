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
import { McpModule } from './mcp/mcp.module';
import { BoardRecognitionModule } from './board-recognition/board-recognition.module';
// KS-2967 / ADR-063 Phase 2 — KnowledgeModule временно отключён от
// bootstrap'а NestJS. Код, тесты и Dockerfile-инструкции остаются в
// репо для следующей итерации (см. apps/api/src/knowledge/). Причина
// rollback'а: реализация даёт залогиненному пользователю через
// ассистент path/line/фрагменты исходников фронта, а STATIC_FOOTER
// одновременно требует «не раскрывать technical details» — конфликт
// инструкций модели, не подходит к политике приватного репо.
// import { KnowledgeModule } from './knowledge/knowledge.module';
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
        // KS-3059: на dev — `watch:true` для hot-reload переводов.
        // На проде fs.watch на ~5 файлах не даёт пользы (артефакт
        // immutable после build), а на холодном Fargate task — лишний
        // setup + удержание FD при низкой пользе. Выключаем.
        watch: process.env.NODE_ENV !== 'production',
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
    // KS-2952 / ADR-061 этап A. MCP auto-discovery: GET /_mcp/tools.
    McpModule,
    // KS-2363 / ADR-040 §5.1. POST /api/board-recognition. На проде
    // работает в disabled-режиме (mock-ответ + warning), пока devops
    // не выставит ENV BOARD_RECOG_MODEL_VERSION (KS-2364 / KS-3071).
    BoardRecognitionModule,
    // KS-2967 / ADR-063 Phase 2 (KnowledgeModule) — временно отключён,
    // см. import выше.
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LastSeenMiddleware).forRoutes('*');
  }
}
