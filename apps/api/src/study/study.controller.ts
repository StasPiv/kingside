import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { StudyService, type StudyDto, type StudyWithChapters } from './study.service';
import {
  StudyChaptersService,
  type StudyChapterDto,
} from './study-chapters.service';
import {
  CreateChapterDto,
  CreateStudyDto,
  ImportPgnDto,
  ListStudiesQueryDto,
  ReorderChapterDto,
  UpdateChapterDto,
  UpdateStudyDto,
} from './dto/study.dto';
import {
  StudyAccessGuard,
  StudyResource,
} from './study-access.guard';
import { StudyOwnerGuard } from './study-owner.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

/**
 * KS-2815 / ADR-059 / KS-2819 T4. REST API для Studies.
 *
 * Префикс `studies` (с глобальным `/api` это даёт `/api/studies/*`,
 * согласно §B.4).
 *
 * Auth-модель:
 *  - GET `/studies/:slug` и GET `/studies/:slug/chapters/:chapterId`
 *    используют `OptionalJwtAuthGuard` + `StudyAccessGuard` — anonymous
 *    видит публичную, owner видит свою приватную тоже. Эти же
 *    эндпоинты обслуживают URL `/studies/c/:chapterId` (T6).
 *  - Все остальные эндпоинты — `JwtAuthGuard` (требуется auth);
 *    мутации дополнительно защищены `StudyOwnerGuard`.
 *
 * Контракт ошибок: единый `404 Not Found` для «не моё / не существует» —
 * не даём enumeration, как в `UserCourseOwnerGuard` (ADR-026 §2.5).
 */
@Controller('studies')
export class StudyController {
  constructor(
    private readonly study: StudyService,
    private readonly chapters: StudyChaptersService,
  ) {}

  // ─── Studies CRUD ────────────────────────────────────────────────

  /**
   * `?mine=1` (default) — мои студии (auth required);
   * `?mine=0` — публичные (anonymous допускается, owner-фильтр снят).
   *
   * Используем OptionalJwt, чтобы публичный каталог можно было читать
   * без auth; для `mine=1` без auth — сервис кинет 400.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  async list(
    @Request() req: AuthenticatedRequest,
    @Query() query: ListStudiesQueryDto,
  ): Promise<{ data: StudyDto[] }> {
    const mine = query.mine === undefined ? 1 : query.mine;
    return this.study.list(req.user?.id ?? null, {
      mine: mine !== 0,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateStudyDto,
  ): Promise<StudyDto> {
    return this.study.create(req.user.id, dto);
  }

  /**
   * Анonymous допускается для публичной студии. StudyAccessGuard сам
   * проверит видимость; OptionalJwtAuthGuard опционально заполнит
   * `req.user` (нужно StudyService.resolveBySlug, чтобы owner видел
   * приватную тоже).
   */
  @UseGuards(OptionalJwtAuthGuard, StudyAccessGuard)
  @StudyResource('study-slug')
  @Get(':slug')
  async getBySlug(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<StudyWithChapters> {
    return this.study.getBySlug(req.user?.id ?? null, slug);
  }

  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Patch(':slug')
  async update(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() dto: UpdateStudyDto,
  ): Promise<StudyDto> {
    return this.study.update(req.user.id, slug, dto);
  }

  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Delete(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<void> {
    await this.study.delete(req.user.id, slug);
  }

  // ─── Chapters CRUD ───────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Post(':slug/chapters')
  async createChapter(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() dto: CreateChapterDto,
  ): Promise<StudyChapterDto> {
    const study = await this.study.requireOwn(req.user.id, slug);
    return this.chapters.create(study, dto);
  }

  @UseGuards(OptionalJwtAuthGuard, StudyAccessGuard)
  @StudyResource('study-slug')
  @Get(':slug/chapters/:chapterId')
  async getChapter(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('chapterId') chapterId: string,
  ): Promise<StudyChapterDto> {
    const study = await this.study.resolveBySlug(
      req.user?.id ?? null,
      slug,
    );
    if (!study) {
      // Уже бы поймал StudyAccessGuard, но защитный invariant.
      return this.chapters.getById(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: '' } as any,
        chapterId,
      );
    }
    return this.chapters.getById(study, chapterId);
  }

  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Patch(':slug/chapters/:chapterId')
  async updateChapter(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('chapterId') chapterId: string,
    @Body() dto: UpdateChapterDto,
  ): Promise<StudyChapterDto> {
    const study = await this.study.requireOwn(req.user.id, slug);
    return this.chapters.update(study, chapterId, dto);
  }

  /**
   * Drag-n-drop: `{ after: chapterId | null }`. Сервис сам вычислит
   * новый orderIdx и при необходимости сделает rebalance.
   */
  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Patch(':slug/chapters/:chapterId/order')
  async reorderChapter(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('chapterId') chapterId: string,
    @Body() dto: ReorderChapterDto,
  ): Promise<StudyChapterDto> {
    const study = await this.study.requireOwn(req.user.id, slug);
    return this.chapters.reorder(study, chapterId, dto.after ?? null);
  }

  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Delete(':slug/chapters/:chapterId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteChapter(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('chapterId') chapterId: string,
  ): Promise<void> {
    const study = await this.study.requireOwn(req.user.id, slug);
    await this.chapters.delete(study, chapterId);
  }

  // ─── Import / Export ─────────────────────────────────────────────
  // (KS-2820 T5). Контроллер тот же, эндпоинты добавлены в этой
  // итерации — они тесно связаны со CRUD chapters.

  /** Multi-PGN импорт (KS-2820 T5). */
  @UseGuards(JwtAuthGuard, StudyOwnerGuard)
  @StudyResource('study-slug')
  @Post(':slug/import-pgn')
  async importPgn(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() dto: ImportPgnDto,
  ): Promise<{ created: StudyChapterDto[] }> {
    const study = await this.study.requireOwn(req.user.id, slug);
    return this.chapters.importPgn(study, dto.pgn);
  }

  /** Экспорт всей студии (KS-2820 T5). */
  @UseGuards(OptionalJwtAuthGuard, StudyAccessGuard)
  @StudyResource('study-slug')
  @Get(':slug/export.pgn')
  async exportStudy(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<{ pgn: string }> {
    const study = await this.study.resolveBySlug(
      req.user?.id ?? null,
      slug,
    );
    if (!study) return { pgn: '' };
    const pgn = await this.chapters.exportStudyPgn(study);
    return { pgn };
  }

  /** Экспорт одной главы (KS-2820 T5). */
  @UseGuards(OptionalJwtAuthGuard, StudyAccessGuard)
  @StudyResource('study-slug')
  @Get(':slug/chapters/:chapterId/export.pgn')
  async exportChapter(
    @Request() req: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('chapterId') chapterId: string,
  ): Promise<{ pgn: string }> {
    const study = await this.study.resolveBySlug(
      req.user?.id ?? null,
      slug,
    );
    if (!study) return { pgn: '' };
    const pgn = await this.chapters.exportChapterPgn(study, chapterId);
    return { pgn };
  }
}
