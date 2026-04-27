import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AdminEmailGuard } from '../../auth/admin-email.guard';
import {
  UserRateLimit,
  UserRateLimitGuard,
} from '../../common/user-rate-limit.guard';
import { ADMIN_RATE_LIMIT } from './admin-rate-limit';
import { LessonsAdminImportService } from './lessons-admin-import.service';
import { ImportRequestDto, ImportResponse } from './dto/import-lesson.dto';

/**
 * KS-2018 / B-3 — `POST /api/lessons/admin/import`.
 *
 * Атомарный upsert одного урока (с опциональной мета-информацией
 * курса) одной транзакцией. Тело запроса парсится по
 * `ImportRequestDto`, бизнес-валидация шагов выполняется в DTO-уровне
 * через `STEP_PAYLOAD_SUBTYPES` (re-use тех же декораторов, что и
 * существующие admin-CRUD-эндпоинты).
 *
 * Гарды совпадают с другими admin-эндпоинтами KS-1962:
 * `JwtAuthGuard` → `AdminEmailGuard` → `UserRateLimitGuard`.
 */
@UseGuards(JwtAuthGuard, AdminEmailGuard, UserRateLimitGuard)
@UserRateLimit(ADMIN_RATE_LIMIT.maxRequests, ADMIN_RATE_LIMIT.windowSec)
@Controller('lessons/admin/import')
export class LessonsAdminImportController {
  constructor(private readonly service: LessonsAdminImportService) {}

  /**
   * POST /api/lessons/admin/import — импорт одного урока.
   * 200 OK с diff'ом в теле ответа.
   */
  @Post()
  @HttpCode(200)
  importLesson(@Body() dto: ImportRequestDto): Promise<ImportResponse> {
    return this.service.importLesson(dto);
  }
}
