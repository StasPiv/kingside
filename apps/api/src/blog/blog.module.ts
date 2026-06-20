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
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [BlogController, BlogAdminController],
  providers: [BlogService, BlogAdminService, BlogMediaService],
  exports: [BlogService, BlogAdminService, BlogMediaService],
})
export class BlogModule {}
