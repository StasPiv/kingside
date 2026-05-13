import { Controller, Get, Query } from '@nestjs/common';
import { StudyService, type StudyDto } from './study.service';
import { StudyCatalogQueryDto } from './dto/study.dto';
import { McpTool } from '../mcp/decorators';

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

  @McpTool({
    name: 'studies__catalog',
    description:
      'Каталог публичных студий с фильтрами и сортировкой (hot/new/' +
      'updated/popular), поиск по `q`, фильтр по `topic`. Возвращает ' +
      '{items, total, hasMore}.',
    defaultLimit: 20,
    maxLimit: 50,
  })
  @Get()
  async catalog(
    @Query() query: StudyCatalogQueryDto,
  ): Promise<{ items: StudyDto[]; total: number; hasMore: boolean }> {
    return this.study.catalog(query);
  }
}
