/**
 * KS-4409 / ADR-137 rev2. NestJS-модуль публичной поверхности блога.
 * Админ-CRUD (T3) появится отдельным `BlogAdminModule`.
 */
import { Module } from '@nestjs/common';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';

@Module({
  controllers: [BlogController],
  providers: [BlogService],
  exports: [BlogService],
})
export class BlogModule {}
