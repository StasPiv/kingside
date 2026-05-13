import { Controller, Get, Query } from '@nestjs/common';
import { StudyService, type StudyDto } from './study.service';
import { StudyCatalogQueryDto } from './dto/study.dto';

/**
 * KS-2880 / ADR-060 §3.4. Каталог публичных студий.
 *
 * Анонимный read-only эндпоинт (без `JwtAuthGuard`). Вынесен в
 * отдельный controller с префиксом `studies/catalog` чтобы:
 *  - не конфликтовать с параметрическим `:slug` `StudyController`;
 *  - не наследовать `OptionalJwtAuthGuard` оттуда (каталог никогда
 *    не зависит от auth, чтобы CDN-кеш был эффективен);
 *  - не путаться с `studies/public` (`StudyPublicController`),
 *    который остаётся как legacy-листинг без сортировок/фильтров.
 *
 * Контракт: `GET /api/studies/catalog?sort=hot|new|updated|popular
 * &q=&topic=&page=&pageSize=` → `{items, total, hasMore}`.
 */
@Controller('studies/catalog')
export class StudyCatalogController {
  constructor(private readonly study: StudyService) {}

  @Get()
  async catalog(
    @Query() query: StudyCatalogQueryDto,
  ): Promise<{ items: StudyDto[]; total: number; hasMore: boolean }> {
    return this.study.catalog(query);
  }
}
