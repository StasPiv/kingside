import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  StudyModel as Study,
  StudyChapterModel as StudyChapter,
} from '@kingside/db';
import { Prisma } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { splitPgn } from '../workshop/pgn.parser';
import { STUDY_LIMITS, STUDY_ORDER_STEP } from './study-limits';
import type {
  CreateChapterDto,
  UpdateChapterDto,
} from './dto/study.dto';
import {
  validateGamebookPayload,
  type GamebookPayloadDto,
} from './dto/gamebook.dto';

/**
 * KS-2815 / ADR-059 / KS-2818 T3. CRUD-сервис для `StudyChapter`.
 *
 * Сервис получает `study` (уже разрешённую и проверенную по правам
 * выше) как контекст для всех операций. Это гарантирует, что глава
 * читается/пишется в правильную студию и что лимит `chaptersPerStudy`
 * считается без лишних DB-запросов.
 *
 * Импорт multi-PGN и экспорт `.pgn` живут здесь же — оба тесно
 * связаны с моделью `StudyChapter`.
 */
@Injectable()
export class StudyChaptersService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Read ────────────────────────────────────────────────────────

  /** Глава целиком (включая `pgn`). Используется в редакторе и export'е. */
  async getById(
    study: Study,
    chapterId: string,
  ): Promise<StudyChapterDto> {
    const chapter = await this.prisma.studyChapter.findUnique({
      where: { id: chapterId },
    });
    if (!chapter || chapter.studyId !== study.id) {
      throw new NotFoundException('Chapter not found');
    }
    return toChapterDto(chapter);
  }

  // ─── Mutations ───────────────────────────────────────────────────

  /** Создать главу. Проверяется лимит и размер PGN. */
  async create(study: Study, dto: CreateChapterDto): Promise<StudyChapterDto> {
    await this.assertCanAddChapter(study);
    this.assertPgnSize(dto.pgn);
    // KS-2902: режимные поля concealPly/gamebook раньше молча отбрасывались
    // на уровне сервиса — фронт переключал mode='conceal'/'gamebook', но
    // в БД не попадал ни ply, ни payload. Conceal не скрывал узлы,
    // gamebook reader не получал инструкций. Поля Prisma + миграция
    // KS-2857 уже на месте — сервис теперь их пробрасывает.
    const gamebookCleaned = this.normalizeGamebookForCreate(dto.gamebook);
    const nextOrderIdx = await this.computeNextOrderIdx(study.id);
    const created = await this.prisma.$transaction(async (tx) => {
      const c = await tx.studyChapter.create({
        data: {
          studyId: study.id,
          name: dto.name,
          orderIdx: nextOrderIdx,
          pgn: dto.pgn ?? '',
          startFen: dto.startFen ?? null,
          orientation: dto.orientation ?? 'white',
          mode: dto.mode ?? 'analysis',
          // KS-2902: concealPly явно из dto, null если не указан.
          concealPly: dto.concealPly ?? null,
          // KS-2902: gamebook — валидированный payload, иначе null.
          gamebook: gamebookCleaned,
        },
      });
      await tx.study.update({
        where: { id: study.id },
        data: { chaptersCount: { increment: 1 } },
      });
      return c;
    });
    return toChapterDto(created);
  }

  async update(
    study: Study,
    chapterId: string,
    dto: UpdateChapterDto,
  ): Promise<StudyChapterDto> {
    const existing = await this.requireChapter(study, chapterId);
    if (dto.pgn !== undefined) this.assertPgnSize(dto.pgn);
    // KS-2902: см. комментарий в create. Партиальный update —
    // включаем поле только если оно явно передано (`!== undefined`).
    // null допустим как явный сброс (mode сменили обратно на 'analysis').
    const gamebookField =
      dto.gamebook === undefined
        ? {}
        : { gamebook: this.normalizeGamebookForUpdate(dto.gamebook) };
    const updated = await this.prisma.studyChapter.update({
      where: { id: existing.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.pgn !== undefined ? { pgn: dto.pgn } : {}),
        ...(dto.startFen !== undefined ? { startFen: dto.startFen } : {}),
        ...(dto.orientation !== undefined
          ? { orientation: dto.orientation }
          : {}),
        ...(dto.mode !== undefined ? { mode: dto.mode } : {}),
        // KS-2902: concealPly — null допустим как явный сброс.
        ...(dto.concealPly !== undefined
          ? { concealPly: dto.concealPly }
          : {}),
        ...gamebookField,
      },
    });
    return toChapterDto(updated);
  }

  /**
   * KS-2902. Нормализация gamebook payload для `create`:
   *  - `null`/`undefined` → `Prisma.DbNull` (записываем NULL в JSONB);
   *  - объект → `validateGamebookPayload`, далее cast на InputJsonValue.
   *
   * BadRequestException при нарушении структуры.
   */
  private normalizeGamebookForCreate(
    raw: Record<string, unknown> | null | undefined,
  ): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
    if (raw === undefined || raw === null) return Prisma.DbNull;
    try {
      const cleaned = validateGamebookPayload(raw);
      return cleaned as unknown as Prisma.InputJsonValue;
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'invalid gamebook',
      );
    }
  }

  /**
   * Аналог для `update` — на null сбрасываем в DbNull, на объект
   * валидируем и пишем.
   */
  private normalizeGamebookForUpdate(
    raw: Record<string, unknown> | null,
  ): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
    return this.normalizeGamebookForCreate(raw);
  }

  async delete(study: Study, chapterId: string): Promise<void> {
    const existing = await this.requireChapter(study, chapterId);
    await this.prisma.$transaction(async (tx) => {
      await tx.studyChapter.delete({ where: { id: existing.id } });
      await tx.study.update({
        where: { id: study.id },
        data: { chaptersCount: { decrement: 1 } },
      });
    });
  }

  /**
   * Переупорядочить главу: после `afterChapterId` либо в начало
   * (`afterChapterId = null`). Считаем средний orderIdx между
   * соседями; при исчерпании дробности (соседи отличаются < 2) —
   * rebalance всей студии целыми шагами `STUDY_ORDER_STEP`.
   */
  async reorder(
    study: Study,
    chapterId: string,
    afterChapterId: string | null,
  ): Promise<StudyChapterDto> {
    const target = await this.requireChapter(study, chapterId);
    if (afterChapterId === chapterId) {
      throw new BadRequestException('Cannot place chapter after itself');
    }
    const siblings = await this.prisma.studyChapter.findMany({
      where: { studyId: study.id },
      orderBy: { orderIdx: 'asc' },
      select: { id: true, orderIdx: true },
    });

    let prevOrder: number | null = null;
    let nextOrder: number | null = null;
    if (afterChapterId === null) {
      // В начало.
      const first = siblings.find((s) => s.id !== target.id) ?? null;
      nextOrder = first ? first.orderIdx : null;
    } else {
      const idx = siblings.findIndex((s) => s.id === afterChapterId);
      if (idx === -1) {
        throw new NotFoundException('After-chapter not found');
      }
      prevOrder = siblings[idx].orderIdx;
      const nextSibling =
        siblings.slice(idx + 1).find((s) => s.id !== target.id) ?? null;
      nextOrder = nextSibling ? nextSibling.orderIdx : null;
    }

    let newOrder: number;
    if (prevOrder === null && nextOrder === null) {
      newOrder = STUDY_ORDER_STEP;
    } else if (prevOrder === null && nextOrder !== null) {
      newOrder = nextOrder - STUDY_ORDER_STEP;
    } else if (prevOrder !== null && nextOrder === null) {
      newOrder = prevOrder + STUDY_ORDER_STEP;
    } else {
      // Оба соседа есть — среднее.
      const mid = Math.floor((prevOrder! + nextOrder!) / 2);
      if (mid <= prevOrder! || mid >= nextOrder!) {
        // Не помещаемся — делаем rebalance всех целыми шагами и
        // ставим target после нужного соседа.
        return this.rebalanceAndPlace(
          study,
          siblings,
          target.id,
          afterChapterId,
        );
      }
      newOrder = mid;
    }

    const updated = await this.prisma.studyChapter.update({
      where: { id: target.id },
      data: { orderIdx: newOrder },
    });
    return toChapterDto(updated);
  }

  // ─── Import / Export ─────────────────────────────────────────────

  /**
   * Multi-PGN импорт: `splitPgn` режет вход на отдельные партии,
   * каждая становится новой главой. Имя главы — заголовок `[Event]`
   * либо `Chapter N`. Лимит `chaptersPerStudy` соблюдается
   * (BadRequest если переполнение).
   *
   * Импорт чанкается по 8 глав в транзакцию — снижает шанс упереться
   * в Prisma transaction timeout на больших PGN. См. KS-2815 §B.7.
   */
  async importPgn(
    study: Study,
    pgnContent: string,
  ): Promise<{ created: StudyChapterDto[] }> {
    const games = splitPgn(pgnContent).filter((g) => g.length > 0);
    if (games.length === 0) {
      throw new BadRequestException('No games found in PGN');
    }
    const currentCount = await this.prisma.studyChapter.count({
      where: { studyId: study.id },
    });
    if (currentCount + games.length > STUDY_LIMITS.chaptersPerStudy) {
      throw new BadRequestException(
        `Import would exceed chapters limit (max ${STUDY_LIMITS.chaptersPerStudy} per study)`,
      );
    }
    for (const game of games) {
      this.assertPgnSize(game);
    }

    let baseOrderIdx = await this.computeNextOrderIdx(study.id);
    const created: StudyChapterDto[] = [];
    const CHUNK = 8;
    for (let i = 0; i < games.length; i += CHUNK) {
      const chunk = games.slice(i, i + CHUNK);
      const chunkCreated = await this.prisma.$transaction(async (tx) => {
        const out: StudyChapter[] = [];
        for (let j = 0; j < chunk.length; j++) {
          const c = await tx.studyChapter.create({
            data: {
              studyId: study.id,
              name: extractGameTitle(chunk[j]) ?? `Chapter ${currentCount + i + j + 1}`,
              orderIdx: baseOrderIdx + (i + j) * STUDY_ORDER_STEP,
              pgn: chunk[j],
              startFen: extractStartFen(chunk[j]),
              orientation: 'white',
              mode: 'analysis',
            },
          });
          out.push(c);
        }
        await tx.study.update({
          where: { id: study.id },
          data: { chaptersCount: { increment: chunk.length } },
        });
        return out;
      });
      for (const c of chunkCreated) created.push(toChapterDto(c));
    }
    return { created };
  }

  /**
   * Экспорт всех глав студии в один PGN-файл (разделяем `\n\n`).
   * Главы — в порядке `orderIdx`. Каждая глава пишется как есть
   * (PGN-headers + ходы); если у главы есть `startFen` и заголовка
   * `[FEN]` ещё нет — добавляется.
   */
  async exportStudyPgn(study: Study): Promise<string> {
    const chapters = await this.prisma.studyChapter.findMany({
      where: { studyId: study.id },
      orderBy: { orderIdx: 'asc' },
    });
    return chapters.map((c) => prepareChapterPgn(c)).join('\n\n');
  }

  async exportChapterPgn(
    study: Study,
    chapterId: string,
  ): Promise<string> {
    const chapter = await this.requireChapter(study, chapterId);
    return prepareChapterPgn(chapter);
  }

  // ─── Internal ────────────────────────────────────────────────────

  async requireChapter(
    study: Study,
    chapterId: string,
  ): Promise<StudyChapter> {
    const c = await this.prisma.studyChapter.findUnique({
      where: { id: chapterId },
    });
    if (!c || c.studyId !== study.id) {
      throw new NotFoundException('Chapter not found');
    }
    return c;
  }

  private async assertCanAddChapter(study: Study): Promise<void> {
    const count = await this.prisma.studyChapter.count({
      where: { studyId: study.id },
    });
    if (count >= STUDY_LIMITS.chaptersPerStudy) {
      throw new BadRequestException(
        `Chapters limit reached (max ${STUDY_LIMITS.chaptersPerStudy} per study)`,
      );
    }
  }

  private assertPgnSize(pgn: string | undefined): void {
    if (!pgn) return;
    const bytes = Buffer.byteLength(pgn, 'utf-8');
    if (bytes > STUDY_LIMITS.chapterPgnMaxBytes) {
      throw new BadRequestException(
        `Chapter pgn too large (${bytes} > ${STUDY_LIMITS.chapterPgnMaxBytes} bytes)`,
      );
    }
  }

  private async computeNextOrderIdx(studyId: string): Promise<number> {
    const max = await this.prisma.studyChapter.findFirst({
      where: { studyId },
      orderBy: { orderIdx: 'desc' },
      select: { orderIdx: true },
    });
    return (max?.orderIdx ?? 0) + STUDY_ORDER_STEP;
  }

  /**
   * Rebalance всех глав целыми шагами `STUDY_ORDER_STEP`, target
   * вставляется ровно после `afterChapterId` (или в начало если
   * `afterChapterId === null`). Атомарно через транзакцию.
   *
   * Шаги переставляются в новом порядке `seq`, потом каждая запись
   * обновляется. ВНИМАНИЕ: уникальный индекс `(studyId, orderIdx)`
   * требует двухфазного обновления — сначала зануляем «временные»
   * значения за пределы рабочего диапазона, потом проставляем
   * финальные. Делаем offset `-1_000_000_000` для временной фазы.
   */
  private async rebalanceAndPlace(
    study: Study,
    siblings: { id: string; orderIdx: number }[],
    targetId: string,
    afterChapterId: string | null,
  ): Promise<StudyChapterDto> {
    const reordered = siblings
      .filter((s) => s.id !== targetId)
      .map((s) => s.id);
    const insertAt =
      afterChapterId === null
        ? 0
        : reordered.indexOf(afterChapterId) + 1;
    reordered.splice(insertAt, 0, targetId);

    return this.prisma.$transaction(async (tx) => {
      // Фаза 1: temp offset (избегаем конфликта unique-индекса).
      for (let i = 0; i < reordered.length; i++) {
        await tx.studyChapter.update({
          where: { id: reordered[i] },
          data: { orderIdx: -1_000_000_000 - i },
        });
      }
      // Фаза 2: финальные orderIdx.
      let updatedTarget: StudyChapter | null = null;
      for (let i = 0; i < reordered.length; i++) {
        const c = await tx.studyChapter.update({
          where: { id: reordered[i] },
          data: { orderIdx: (i + 1) * STUDY_ORDER_STEP },
        });
        if (c.id === targetId) updatedTarget = c;
      }
      if (!updatedTarget) {
        throw new Error('rebalance lost target chapter');
      }
      return toChapterDto(updatedTarget);
    });
  }
}

// ─── DTO ─────────────────────────────────────────────────────────────

export interface StudyChapterDto {
  id: string;
  studyId: string;
  name: string;
  orderIdx: number;
  pgn: string;
  startFen: string | null;
  orientation: string;
  mode: string;
  /** KS-2902: ply после которого main-line скрыт (mode='conceal'). */
  concealPly: number | null;
  /**
   * KS-2902: payload автора для mode='gamebook'. Сериализуется как-есть
   * (JSON-объект `{intro?, byUci?}`). null если глава не в этом режиме.
   */
  gamebook: unknown;
  createdAt: string;
  updatedAt: string;
}

export function toChapterDto(c: StudyChapter): StudyChapterDto {
  return {
    id: c.id,
    studyId: c.studyId,
    name: c.name,
    orderIdx: c.orderIdx,
    pgn: c.pgn,
    startFen: c.startFen,
    orientation: c.orientation,
    mode: c.mode,
    // KS-2902: эти поля раньше не возвращались в DTO — фронт получал
    // `undefined` и не знал ни ply, ни gamebook payload.
    concealPly: c.concealPly ?? null,
    gamebook: c.gamebook ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// ─── PGN helpers ─────────────────────────────────────────────────────

function extractHeader(pgn: string, tag: string): string | null {
  const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
  return m && m[1] ? m[1] : null;
}

function extractGameTitle(pgn: string): string | null {
  // Приоритет: [Event], потом White vs Black, потом null.
  const event = extractHeader(pgn, 'Event');
  if (event) return event.slice(0, STUDY_LIMITS.chapterNameMaxLength);
  const white = extractHeader(pgn, 'White');
  const black = extractHeader(pgn, 'Black');
  if (white && black) {
    return `${white} — ${black}`.slice(0, STUDY_LIMITS.chapterNameMaxLength);
  }
  return null;
}

function extractStartFen(pgn: string): string | null {
  const fen = extractHeader(pgn, 'FEN');
  if (!fen) return null;
  return fen.slice(0, STUDY_LIMITS.startFenMaxLength);
}

/**
 * Готовит PGN главы к экспорту: если у главы задан `startFen`, а в
 * PGN-блобе нет [FEN]-заголовка — добавляет [FEN]+[SetUp "1"].
 * Иначе возвращает pgn как есть.
 */
function prepareChapterPgn(c: StudyChapter): string {
  const trimmed = c.pgn.trimStart();
  if (!c.startFen) return trimmed;
  if (extractHeader(trimmed, 'FEN')) return trimmed;
  return `[FEN "${c.startFen}"]\n[SetUp "1"]\n\n${trimmed}`;
}
