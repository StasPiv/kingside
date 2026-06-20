/**
 * KS-4409 / ADR-137 rev2. NestJS-модуль публичной поверхности блога.
 * Админ-CRUD (T3) появится отдельным `BlogAdminModule`.
 */
import { Module } from '@nestjs/common';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
// KS-4410: админ-контроллер блога. KS-4457 / ADR-139 T5: защищён
// AdminOrServiceGuard (human-admin через KS_ADMIN_USERS ИЛИ
// service-account `ks_sa_*` со scope `blog:write` на mutating-эндпоинты).
import { BlogAdminController } from './blog-admin.controller';
import { BlogAdminService } from './blog-admin.service';
// KS-4444 / ADR-138 §5: загрузка обложек статей в S3.
import { BlogMediaService } from './blog-media.service';
// KS-4469 / ADR-140 T3: подсчёт просмотров с Redis-дедупом и антибот-фильтром.
import { BlogViewService } from './blog-view.service';
// KS-4470 / ADR-140 T4: лайки статей под JwtAuthGuard.
import { BlogLikeService } from './blog-like.service';
// KS-4471 / ADR-140 T5: модуль комментариев — GET/POST/PATCH/DELETE.
import { BlogCommentController } from './blog-comment.controller';
import { BlogCommentService } from './blog-comment.service';
import { BlogCommentCreateRateLimitGuard } from './blog-comment-rate-limit.guard';
// KS-4473 / ADR-140 T7: суточный cron пересчёта счётчиков вовлечённости.
import { BlogCounterReconcileService } from './blog-counter-reconcile.service';
import { BlogReconcileScheduler } from './blog-reconcile.scheduler';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [BlogController, BlogAdminController, BlogCommentController],
  providers: [
    BlogService,
    BlogAdminService,
    BlogMediaService,
    BlogViewService,
    BlogLikeService,
    BlogCommentService,
    BlogCommentCreateRateLimitGuard,
    BlogCounterReconcileService,
    BlogReconcileScheduler,
  ],
  exports: [
    BlogService,
    BlogAdminService,
    BlogMediaService,
    BlogViewService,
    BlogLikeService,
    BlogCommentService,
    BlogCounterReconcileService,
  ],
})
export class BlogModule {}
