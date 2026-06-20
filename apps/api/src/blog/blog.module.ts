/**
 * KS-4409 / ADR-137 rev2. NestJS-модуль публичной поверхности блога.
 * Админ-CRUD (T3) появится отдельным `BlogAdminModule`.
 */
import { Module } from '@nestjs/common';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
// KS-4410: админ-контроллер блога. Защищён JwtAuthGuard +
// AdminUserGuard (whitelist KS_ADMIN_USERS).
import { BlogAdminController } from './blog-admin.controller';
import { BlogAdminService } from './blog-admin.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [BlogController, BlogAdminController],
  providers: [BlogService, BlogAdminService],
  exports: [BlogService, BlogAdminService],
})
export class BlogModule {}
