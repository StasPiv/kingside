import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StudyService, type StudyDto } from './study.service';
import {
  StudyChaptersService,
  type StudyChapterDto,
} from './study-chapters.service';
import { ListStudiesQueryDto } from './dto/study.dto';
import { McpTool } from '../mcp/decorators';

/**
 * KS-2815 / ADR-059 / KS-2821 T6. Публичный read-only доступ к
 * Studies без auth — паттерн `AnalysisPublicController` (ADR-051
 * §3 share-2).
 *
 * Вынесен в отдельный controller (без `JwtAuthGuard`), чтобы
 * anonymous-запросы не пересекались с приватными CRUD-маршрутами
 * `StudyController` (там часть GET'ов с `OptionalJwtAuthGuard` —
 * это для смешанной видимости owner/public; здесь — чистый
 * anonymous catalog).
 *
 * Путь `studies/public` выбран так, чтобы не конфликтовать с
 * параметрическим `:slug` `StudyController`-а: NestJS сначала
 * матчит статические сегменты, плюс `slug` всё равно не может быть
 * строкой `public` по форме `<shortId>-<title>`.
 *
 * Все отказы — `404 Not Found` (единый код, без enumeration).
 */
@Controller('studies/public')
export class StudyPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly study: StudyService,
    private readonly chapters: StudyChaptersService,
  ) {}

  /** Каталог публичных студий (anonymous). */
  @McpTool({
    name: 'studies__list_public',
    description:
      'Анонимный листинг публичных студий без фильтров (legacy-режим до ' +
      'KS-2880). Для расширенной фильтрации/сортировки — studies__catalog.',
    defaultLimit: 20,
    maxLimit: 50,
  })
  @Get()
  async listPublic(
    @Query() query: ListStudiesQueryDto,
  ): Promise<{ data: StudyDto[] }> {
    return this.study.list(null, {
      mine: false,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /**
   * Публичный доступ к главе по UUID. Если `study.isPublic=true` —
   * возвращаем главу + минимальные метаданные студии. Иначе 404.
   *
   * `parentStudy` отдаём чтобы фронт KS-2829 (StudyChapterPublicPage)
   * мог показать «Из студии: <name>» без второго запроса.
   */
  @Get('c/:chapterId')
  async getPublicChapter(
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
  ): Promise<{ chapter: StudyChapterDto; study: PublicStudyMeta }> {
    const row = await this.prisma.studyChapter.findUnique({
      where: { id: chapterId },
      include: {
        study: {
          select: {
            id: true,
            ownerId: true,
            slug: true,
            name: true,
            isPublic: true,
          },
        },
      },
    });
    if (!row || !row.study || !row.study.isPublic) {
      throw new NotFoundException('Chapter not found');
    }
    const chapter = await this.chapters.getById(
      // study передаём только id и ownerId; getById сравнивает только studyId.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: row.study.id } as any,
      chapterId,
    );
    return {
      chapter,
      study: {
        id: row.study.id,
        slug: row.study.slug,
        name: row.study.name,
        ownerId: row.study.ownerId,
      },
    };
  }
}

/** Минимальные метаданные родительской студии для public-эндпоинта. */
export interface PublicStudyMeta {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
}
