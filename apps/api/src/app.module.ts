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
// KS-4205 / ADR-128 §10 #11 §7.3.7: глобальная шина postановки
// prerender-задач в SQS (mutation hooks: lectures/arena/user/…).
import { PrerenderModule } from './prerender/prerender.module';
// KS-4209 / ADR-128 §7.10 §10 #15: cron-генерация sitemap'ов в S3
// + /robots.txt.
import { SitemapModule } from './sitemap/sitemap.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { GameModule } from './game/game.module';
// KS-4026 / ADR-122: REST-эндпоинты позиционной аналитики анализа
// (переезд с gameId на analysisId, см. KS-4026).
import { PositionalTraceModule } from './analyses/positional-trace/positional-trace.module';
import { PuzzleModule } from './puzzle/puzzle.module';
// KS-4342 / ADR-135 §2.4: раздел «Точность» — отдельный модуль
// /tactic-puzzles/*. Полностью изолирован от legacy PuzzleModule.
import { TacticPuzzleModule } from './tactic-puzzle/tactic-puzzle.module';
// KS-4409 / ADR-137 rev2: блог kingside.site/blog (публичные маршруты).
import { BlogModule } from './blog/blog.module';
import { PrecisionModule } from './precision/precision.module';
import { GuessModule } from './guess/guess.module';
import { BlindBoardModule } from './blind-board/blind-board.module';
import { PuzzleRushModule } from './puzzle-rush/puzzle-rush.module';
import { TournamentModule } from './tournament/tournament.module';
import { AnalysisModule } from './analysis/analysis.module';
import { AnalysisReviewModule } from './analysis-review/analysis-review.module';
import { PositionCommentModule } from './position-comment/position-comment.module';
import { WorkshopModule } from './workshop/workshop.module';
import { LiveTournamentModule } from './live-tournament/live-tournament.module';
import { LiveAnalysisModule } from './live-analysis/live-analysis.module';
import { LecturesModule } from './lectures/lectures.module';
import { LectureAudioModule } from './lecture-audio/lecture-audio.module';
import { ClientLogsModule } from './client-logs/client-logs.module';
import { PlayerModule } from './player/player.module';
// KS-4264 / ADR-129 §5.4. Публичный лендинг-эндпоинт /landing/stats.
import { LandingModule } from './landing/landing.module';
import { MessageModule } from './message/message.module';
import { FriendModule } from './friend/friend.module';
import { NotificationModule } from './notification/notification.module';
import { ArenaModule } from './arena/arena.module';
// KS-4247 / ADR-131 A1. Archive HTTP-эндпоинты под /archive/* со
// своим Prisma-клиентом на @kingside/archive-db.
import { ArchiveModule } from './archive/archive.module';
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
import { OpeningTrainerModule } from './opening-trainer/opening-trainer.module';
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
// KS-4695 / ADR-147 §6.2: подписанный cookie `guest_id` на всех роутах
// (rolling-renew, см. шапку файла middleware).
import { GuestIdMiddleware } from './common/guest-id.middleware';
// KS-4695 / ADR-147 §2.2 §8 T1c: events ingest + writer + matview refresher.
import { EventsModule } from './events/events.module';
// KS-4697 / ADR-147 §6 T4: GDPR-эндпоинты user + guest.
import { MeModule } from './me/me.module';
import { GuestModule } from './guest/guest.module';
// KS-4699 / ADR-147 §3 §4 §5 T6: HintsEngine (DSL, лимиты, listener).
import { HintsModule } from './hints/hints.module';
// KS-4759 / ADR-150 T1: тестовый модуль для e2e hints. Контроллер
// маршрутизируется только под `HINTS_TEST_MODE=1`; без env-var
// endpoints возвращают 404 (модуль импортируется, но controllers пуст).
import { HintsTestModule } from './test-mode/hints-test.module';
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
    PrerenderModule,
    SitemapModule,
    AuthModule,
    UserModule,
    GameModule,
    PositionalTraceModule,
    PuzzleRushModule,
    ArenaModule,
    ArchiveModule,
    PuzzleModule,
    TacticPuzzleModule,
    BlogModule,
    PrecisionModule,
    GuessModule,
    BlindBoardModule,
    TournamentModule,
    AnalysisModule,
    // KS-3615 / ADR-102 §8 B. LLM-комментарии к ходам через тот же
    // webhook что AI Assistant. Принципиально отдельный модуль —
    // другой prompt-конструктор, своё rate-limit-namespace в Redis.
    AnalysisReviewModule,
    PositionCommentModule,
    WorkshopModule,
    LiveTournamentModule,
    // KS-3732 / ADR-110: live-трансляция анализа партии
    // (REST /live-analyses + WS namespace /live-analysis).
    LiveAnalysisModule,
    // KS-3784 / ADR-113 §4 эпик 1: лекции тренера
    // (REST /lectures, /coaches/:username/lectures).
    LecturesModule,
    // KS-3831 / ADR-116 §5.1: S3-обёртка для аудио лекций (presigned
    // PUT чанков, ListObjects/DeleteObjects, signed CloudFront URL).
    LectureAudioModule,
    ClientLogsModule,
    PlayerModule,
    LandingModule,
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
    // KS-3272 / ADR-077: Opening Trainer (тренировка дебютов из PGN).
    OpeningTrainerModule,
    // KS-2952 / ADR-061 этап A. MCP auto-discovery: GET /_mcp/tools.
    McpModule,
    // KS-2363 / ADR-040 §5.1. POST /api/board-recognition. На проде
    // работает в disabled-режиме (mock-ответ + warning), пока devops
    // не выставит ENV BOARD_RECOG_MODEL_VERSION (KS-2364 / KS-3071).
    BoardRecognitionModule,
    // KS-2967 / ADR-063 Phase 2 (KnowledgeModule) — временно отключён,
    // см. import выше.
    // KS-4695 / ADR-147 §8 T1c.
    EventsModule,
    // KS-4697 / ADR-147 §8 T4.
    MeModule,
    GuestModule,
    // KS-4699 / ADR-147 §8 T6.
    HintsModule,
    // KS-4759 / ADR-150 T1: e2e test-endpoints под HINTS_TEST_MODE=1.
    HintsTestModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Порядок: LastSeen первый (он трогает только Bearer-юзеров),
    // GuestIdMiddleware — второй: при отсутствии Bearer проверяет
    // consent-cookie и выписывает/продлевает guest_id.
    consumer.apply(LastSeenMiddleware, GuestIdMiddleware).forRoutes('*');
  }
}
