/**
 * KS-4674 / ADR-146 §2.3. Чтение демо-репертуаров из БД для публичных
 * `GET /opening-trainer/demo[/:id]`. Заменяет file-based
 * `DemoRepertoireSeedService` — источник истины теперь
 * `opening_repertoires WHERE is_demo=true`.
 *
 * Контракт ответа DTO сохранён — это те же `DemoRepertoireSummary` и
 * `OpeningRepertoireDetailDto`, что отдавал старый сервис. URL-`id`
 * — это `slug` (для backward-compat со старым URL
 * `/opening-trainer/demo/<slug>`; UUID БД во внешнем DTO не светим).
 */
import { Injectable } from '@nestjs/common';
import {
  type OpeningRepertoireDetailDto,
  type OpeningRepertoireSourceDto,
  type RepertoireTree,
  type TrainerColor,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Та же форма, что в старом DemoRepertoireSeedService (KS-4162). */
export interface DemoRepertoireSummary {
  id: string;
  title: string;
  description: string;
  /** = `tree.meta.nodeCount`. */
  treeSize: number;
  side: TrainerColor;
  /**
   * BCP-47 коды. В БД отдельной колонки нет (вне scope KS-4674),
   * возвращаем пустой массив — backward-compat.
   */
  languages: string[];
}

/**
 * Тот же sentinel, что в KS-4162 (`DemoRepertoireSeedService.DEMO_OWNER_ID`).
 * В БД у админских репертуаров `userId IS NULL`, но DTO `ownerId`
 * остаётся обязательным полем `OpeningRepertoireDto` — отдаём NIL UUID
 * для backward-compat с фронтом.
 */
const DEMO_OWNER_SENTINEL_ID = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class OpeningTrainerDemoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Список опубликованных демо-репертуаров. Порядок — `created_at DESC`
   * (использует индекс `opening_repertoires_is_demo_is_published_created_at_idx`).
   */
  async listSummaries(): Promise<DemoRepertoireSummary[]> {
    const rows = await this.prisma.openingRepertoire.findMany({
      where: { isDemo: true, isPublished: true },
      orderBy: { createdAt: 'desc' },
      select: {
        slug: true,
        title: true,
        description: true,
        side: true,
        nodeCount: true,
      },
    });
    return rows
      // slug у `is_demo=true` гарантирован application-level (admin-сервис
      // не даст создать без него), но защищаемся от грязных данных.
      .filter((r): r is typeof r & { slug: string } => typeof r.slug === 'string')
      .map((r) => ({
        id: r.slug,
        title: r.title,
        description: r.description ?? '',
        treeSize: r.nodeCount,
        side: toTrainerColor(r.side),
        languages: [],
      }));
  }

  /**
   * Детальный JSON по slug. Возвращает `null`, если запись не найдена
   * или не опубликована — контроллер бросит 404.
   */
  async getDetail(slug: string): Promise<OpeningRepertoireDetailDto | null> {
    const row = await this.prisma.openingRepertoire.findFirst({
      where: { isDemo: true, isPublished: true, slug },
      include: {
        sources: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) return null;

    // pgn — backward-compat денормализованный concat всех источников по
    // порядку (как в `OpeningRepertoireDetailDto.pgn`). Если sources пуст
    // (что в БД невозможно для нормального демо, source-pgn пишется
    // одновременно с tree), возвращаем пустую строку.
    const pgn = row.sources.map((s) => s.pgn).join('\n\n');

    const sources: OpeningRepertoireSourceDto[] = row.sources.map((s, idx) => ({
      id: s.id,
      repertoireId: row.id,
      name: s.name,
      pgn: s.pgn,
      sourceKind: s.sourceKind as OpeningRepertoireSourceDto['sourceKind'],
      sourceAnalysisId: s.sourceAnalysisId,
      archiveGameId: s.archiveGameId,
      // В БД-схеме `OpeningRepertoireSource` нет колонки `order` —
      // стабильный порядок задаётся `createdAt` (см. orderBy выше).
      // DTO-поле `order` (KS-3324) синтезируем по индексу: первая
      // запись = 0, далее по возрастанию.
      order: idx,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));

    return {
      // id — slug (URL-семантика), не UUID БД. Так было в KS-4162.
      id: row.slug ?? row.id,
      ownerId: DEMO_OWNER_SENTINEL_ID,
      title: row.title,
      description: row.description ?? null,
      side: toTrainerColor(row.side),
      nodeCount: row.nodeCount,
      edgeCount: row.edgeCount,
      maxDepth: row.maxDepth,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      pgn,
      tree: row.tree as unknown as RepertoireTree,
      sources,
    };
  }
}

function toTrainerColor(raw: string): TrainerColor {
  return raw === 'black' ? 'black' : 'white';
}
