/**
 * KS-3615 / ADR-102 §8 B-этап (MVP-1) + KS-3625 / ADR-103 rev 3
 * (MVP-2 B1'). NestJS-модуль для LLM-комментариев к ходам
 * («Разобрать партию»).
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
 *
 * MVP-2 (rev 3): серверного Stockfish нет. `positional_shifts` приходят
 * готовыми с фронта (WASM SF 16), бэк stateless относительно eval'а.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReviewCommentController } from './review-comment.controller';
import { ReviewCommentService } from './review-comment.service';
import { MoveCommentController } from './move-comment.controller';
import { MoveCommentService } from './move-comment.service';

// KS-3711. Новый эндпоинт `POST /analyses/review/move-comment` живёт в
// этом же модуле рядом со старым пакетным `POST /analyses/review/comments`.
// Оба остаются рабочими до миграции фронта (KS-3712); после миграции
// старый эндпоинт + `ReviewCommentService` / `ReviewCommentController`
// удалим в отдельном тикете.
@Module({
  imports: [AuthModule],
  controllers: [ReviewCommentController, MoveCommentController],
  providers: [ReviewCommentService, MoveCommentService],
})
export class AnalysisReviewModule {}
