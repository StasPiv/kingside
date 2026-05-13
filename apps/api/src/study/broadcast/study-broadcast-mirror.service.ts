/**
 * KS-2884 / ADR-060 §3.7 B11. Broadcast-зеркало в студии.
 *
 * Логика:
 *  - `createMirror(roundId)`: получаем Round+Games от broadcast-service,
 *    создаём `Study` (`visibility='public'`, owner=системный
 *    `broadcast-mirror-user`, `fromKind='broadcast:<roundId>'`,
 *    `fromRefId=roundId`) и по одной `StudyChapter` на партию.
 *  - `syncMirror(roundId)`: находит студию по `fromRefId=roundId` и
 *    идемпотентно обновляет PGN каждой главы из свежих
 *    `BroadcastGame.pgn`. Главы матчатся по `fromRefId` chapter'а —
 *    `broadcastGameId`, без удаления/создания. Если в раунде появилась
 *    новая партия — она создаётся как новая глава.
 *
 * Системный пользователь `broadcast-mirror-user`:
 *  - `onModuleInit` выполняет upsert по `username='broadcast-mirror'`;
 *  - `email='broadcast-mirror@kingside.internal'`, `isHidden=true`
 *    (не светим в публичных выдачах), без `passwordHash` (логин невозможен).
 *
 * Используются прямые prisma-операции — не StudyService.create, потому
 * что нужно явно задать `visibility='public'`, `fromKind`, `fromRefId`
 * и `chaptersCount`, а также чтобы создать главы в одной транзакции.
 *
 * Тесты — `study-broadcast-mirror.service.spec.ts`: создание зеркала,
 * повторный sync без дубликатов, добавление новой главы при появлении
 * новой партии.
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StudySlugService } from '../study-slug.service';
import { STUDY_LIMITS, STUDY_ORDER_STEP } from '../study-limits';
import { BroadcastServiceClient } from './broadcast-service.client';

const MIRROR_USERNAME = 'broadcast-mirror';
const MIRROR_EMAIL = 'broadcast-mirror@kingside.internal';

export interface CreateMirrorResult {
  studyId: string;
  slug: string;
  chapterIds: string[];
}

export interface SyncMirrorResult {
  studyId: string;
  slug: string;
  updatedChapters: number;
  createdChapters: number;
}

@Injectable()
export class StudyBroadcastMirrorService implements OnModuleInit {
  private readonly logger = new Logger(StudyBroadcastMirrorService.name);
  private mirrorUserId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly slug: StudySlugService,
    private readonly broadcast: BroadcastServiceClient,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureMirrorUser();
  }

  /**
   * Upsert системного пользователя broadcast-mirror-user.
   * Идемпотентен — повторный старт api не создаёт дубликат.
   */
  async ensureMirrorUser(): Promise<string> {
    if (this.mirrorUserId) return this.mirrorUserId;
    const user = await this.prisma.user.upsert({
      where: { username: MIRROR_USERNAME },
      update: {},
      create: {
        username: MIRROR_USERNAME,
        email: MIRROR_EMAIL,
        isHidden: true,
        passwordHash: null,
      },
    });
    this.mirrorUserId = user.id;
    this.logger.log(`broadcast-mirror-user id=${user.id}`);
    return user.id;
  }

  /**
   * Создать новое зеркало раунда. Если зеркало для этого `roundId`
   * уже существует — 409 (не пересоздаём; для апдейта используйте
   * `syncMirror`).
   */
  async createMirror(roundId: string): Promise<CreateMirrorResult> {
    const existing = await this.prisma.study.findFirst({
      where: { fromKind: `broadcast:${roundId}`, fromRefId: roundId },
    });
    if (existing) {
      throw new ConflictException(
        `Mirror study for round ${roundId} already exists (${existing.slug})`,
      );
    }

    const data = await this.broadcast.getRoundWithGames(roundId);
    if (!data.round) {
      throw new NotFoundException(`Broadcast round ${roundId} not found`);
    }
    const games = data.games ?? [];
    if (games.length > STUDY_LIMITS.chaptersPerStudy) {
      throw new ConflictException(
        `Round has ${games.length} games, exceeds chaptersPerStudy=${STUDY_LIMITS.chaptersPerStudy}`,
      );
    }

    const userId = await this.ensureMirrorUser();
    const slug = await this.slug.generateUnique(userId, data.round.name);

    const created = await this.prisma.$transaction(async (tx) => {
      const study = await tx.study.create({
        data: {
          ownerId: userId,
          slug,
          name: data.round.name,
          description: null,
          isPublic: true,
          visibility: 'public',
          topics: [],
          fromKind: `broadcast:${roundId}`,
          fromRefId: roundId,
          chaptersCount: games.length,
        },
      });
      await tx.studyMember.create({
        data: { studyId: study.id, userId, role: 'owner' },
      });
      const chapterIds: string[] = [];
      let orderIdx = STUDY_ORDER_STEP;
      for (const g of games) {
        const c = await tx.studyChapter.create({
          data: {
            studyId: study.id,
            name: this.makeChapterName(g),
            orderIdx,
            pgn: g.pgn ?? '',
            startFen: null,
            orientation: 'white',
            mode: 'analysis',
            // KS-2884: фиксируем связь chapter ↔ broadcast game для
            // последующего идемпотентного sync'а.
            fromKind: `broadcast-game:${g.id}`,
            fromRefId: g.id,
          },
        });
        chapterIds.push(c.id);
        orderIdx += STUDY_ORDER_STEP;
      }
      return { study, chapterIds };
    });

    return {
      studyId: created.study.id,
      slug: created.study.slug,
      chapterIds: created.chapterIds,
    };
  }

  /**
   * Идемпотентный sync: обновляет PGN существующих глав, добавляет
   * новые при появлении новых партий в раунде. Удаление партий
   * НЕ инициирует удаление главы (мирроринг не разрушающий —
   * историю партий сохраняем даже если broadcast-service переставил
   * фид).
   */
  async syncMirror(roundId: string): Promise<SyncMirrorResult> {
    const study = await this.prisma.study.findFirst({
      where: { fromKind: `broadcast:${roundId}`, fromRefId: roundId },
    });
    if (!study) {
      throw new NotFoundException(
        `Mirror study for round ${roundId} not found`,
      );
    }

    const data = await this.broadcast.getRoundWithGames(roundId);
    const games = data.games ?? [];

    // Существующие главы зеркала индексируем по fromRefId (broadcastGameId).
    const existingChapters = await this.prisma.studyChapter.findMany({
      where: { studyId: study.id },
    });
    const byGameId = new Map(
      existingChapters
        .filter((c) => c.fromRefId)
        .map((c) => [c.fromRefId as string, c]),
    );

    let updatedChapters = 0;
    let createdChapters = 0;

    await this.prisma.$transaction(async (tx) => {
      let nextOrderIdx =
        existingChapters.reduce(
          (max, c) => (c.orderIdx > max ? c.orderIdx : max),
          0,
        ) + STUDY_ORDER_STEP;

      for (const g of games) {
        const existing = byGameId.get(g.id);
        if (existing) {
          if (existing.pgn !== (g.pgn ?? '')) {
            await tx.studyChapter.update({
              where: { id: existing.id },
              data: { pgn: g.pgn ?? '' },
            });
            updatedChapters++;
          }
        } else {
          await tx.studyChapter.create({
            data: {
              studyId: study.id,
              name: this.makeChapterName(g),
              orderIdx: nextOrderIdx,
              pgn: g.pgn ?? '',
              startFen: null,
              orientation: 'white',
              mode: 'analysis',
              fromKind: `broadcast-game:${g.id}`,
              fromRefId: g.id,
            },
          });
          createdChapters++;
          nextOrderIdx += STUDY_ORDER_STEP;
        }
      }

      if (createdChapters > 0) {
        await tx.study.update({
          where: { id: study.id },
          data: { chaptersCount: { increment: createdChapters } },
        });
      }
    });

    return {
      studyId: study.id,
      slug: study.slug,
      updatedChapters,
      createdChapters,
    };
  }

  private makeChapterName(game: {
    whitePlayer: string | null;
    blackPlayer: string | null;
    result: string | null;
  }): string {
    const w = (game.whitePlayer ?? '').trim() || '?';
    const b = (game.blackPlayer ?? '').trim() || '?';
    const r = game.result && game.result !== '*' ? game.result : 'vs';
    return `${w} ${r} ${b}`;
  }
}
