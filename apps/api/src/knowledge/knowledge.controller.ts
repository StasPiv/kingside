import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { McpTool } from '../mcp/decorators';
import { KnowledgeReadDto } from './dto/knowledge-read.dto';
import { KnowledgeSearchDto } from './dto/knowledge-search.dto';
import { KnowledgeService } from './knowledge.service';

/**
 * KS-2967 / ADR-063 §6.1 — knowledge-tools для AI-ассистента.
 *
 * Два MCP-инструмента (`knowledge__search`, `knowledge__read`), которые
 * ассистент использует, когда система slim features-catalog (KS-2966)
 * не покрывает детальный вопрос («какие фильтры в архиве?», «какие
 * пресеты time-control в /play?»). Все запросы под `JwtAuthGuard` —
 * чтобы random scraper не мог дёргать `/knowledge/*` без user-JWT.
 */
@UseGuards(JwtAuthGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  /**
   * GET /knowledge/search — fixed-string поиск по allowlist'у репо.
   */
  @McpTool({
    name: 'knowledge__search',
    description:
      'Fixed-string search across Kingside source code (frontend pages / components / hooks / context / layouts), i18n locale strings, the shared package, ADRs, and service READMEs. Use for specific feature questions ("how does X work?", "what fields are on page Y?"). Returns matched file paths + line numbers + ±2 lines of surrounding context. Do NOT use for chess analysis — these tools read application source, not positions.',
    defaultLimit: 20,
    maxLimit: 100,
  })
  @Get('search')
  search(@Query() dto: KnowledgeSearchDto) {
    return this.knowledge.search({
      q: dto.q,
      glob: dto.glob,
      limit: dto.limit,
    });
  }

  /**
   * GET /knowledge/read — чтение строк allowlisted файла.
   */
  @McpTool({
    name: 'knowledge__read',
    description:
      'Read a single allowlisted file from the Kingside repo by relative path (e.g. apps/web/src/pages/ArchiveGamesPage.tsx). Use after knowledge__search to inspect full implementation context. Default range 200 lines, max 500 per call. Allowed paths: apps/web/src/{pages,components,hooks,context,layouts}/**, apps/web/public/locales/**, packages/shared/src/**, docs/{adr,architecture,features,user}/**, apps/*/README.md.',
    maxLimit: 500,
  })
  @Get('read')
  read(@Query() dto: KnowledgeReadDto) {
    return this.knowledge.read({
      path: dto.path,
      startLine: dto.startLine,
      endLine: dto.endLine,
    });
  }
}
