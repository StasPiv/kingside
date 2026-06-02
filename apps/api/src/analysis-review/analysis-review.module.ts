/**
 * KS-3615 / ADR-102 §8 B-этап. NestJS-модуль для LLM-комментариев
 * к ходам («Разобрать партию»).
 *
 * Зависимости:
 *  - `AuthModule` — JwtAuthGuard на контроллере.
 *  - `ConfigService` / `RedisService` — приходят через @Global модули
 *    (`ConfigModule.forRoot` + `RedisModule` уже @Global), не указываем
 *    в imports.
 *
 * Не реэкспортируем `ReviewCommentService` — он используется только
 * собственным контроллером, других потребителей нет (фронт идёт
 * исключительно через HTTP).
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReviewCommentController } from './review-comment.controller';
import { ReviewCommentService } from './review-comment.service';

@Module({
  imports: [AuthModule],
  controllers: [ReviewCommentController],
  providers: [ReviewCommentService],
})
export class AnalysisReviewModule {}
