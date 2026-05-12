/**
 * KS-2862 B6. Сценарный end-to-end-like тест жизненного цикла студии
 * с участием contributor'а:
 *   1. owner создаёт студию (auto-owner-record в study_members);
 *   2. owner приглашает contributor (через invite-link → accept);
 *   3. contributor проходит StudyContributorGuard и редактирует
 *      главу;
 *   4. owner удаляет contributor → MembersService.removeMember;
 *   5. бывший contributor не проходит guard → 404.
 *
 * Уровень — сервисный (без HTTP). Prisma мокается единым in-memory
 * хранилищем, чтобы переходы между шагами были realistic.
 */
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import { StudyService } from './study.service';
import { StudyMembersService } from './study-members.service';
import { StudyInvitesService } from './study-invites.service';
import { StudyContributorGuard } from './study-contributor.guard';
import { StudyChaptersService } from './study-chapters.service';
import { StudySlugService } from './study-slug.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  STUDY_RESOURCE_KEY,
  StudyResourceKind,
} from './study-access.guard';

// ─── In-memory mock Prisma (минимум для сценария) ─────────────────

interface Row {
  studies: Map<string, any>;
  members: Map<string, any>; // key = `${studyId}:${userId}`
  invites: Map<string, any>;
  chapters: Map<string, any>;
}

function makeInMemoryPrisma(state: Row) {
  const studyMemberHelpers = {
    findUnique: async ({
      where: { studyId_userId },
    }: any) =>
      state.members.get(`${studyId_userId.studyId}:${studyId_userId.userId}`) ??
      null,
    findMany: async ({ where: { studyId } }: any) =>
      Array.from(state.members.values()).filter(
        (m) => m.studyId === studyId,
      ),
    create: async ({ data }: any) => {
      const row = { ...data, addedAt: new Date() };
      state.members.set(`${data.studyId}:${data.userId}`, row);
      return row;
    },
    delete: async ({ where: { studyId_userId } }: any) => {
      state.members.delete(
        `${studyId_userId.studyId}:${studyId_userId.userId}`,
      );
      return null;
    },
  };
  const studyHelpers = {
    findFirst: async ({ where, select }: any) => {
      const studies = Array.from(state.studies.values());
      const match = studies.find((s) => {
        if (where.id !== undefined && s.id !== where.id) return false;
        if (where.slug !== undefined && s.slug !== where.slug) return false;
        if (where.ownerId !== undefined && s.ownerId !== where.ownerId)
          return false;
        return true;
      });
      if (!match) return null;
      if (!select) return match;
      const picked: any = {};
      for (const k of Object.keys(select)) picked[k] = (match as any)[k];
      return picked;
    },
    findUnique: async ({ where }: any) =>
      state.studies.get(where.id) ?? null,
    count: async ({ where: { ownerId } }: any) =>
      Array.from(state.studies.values()).filter((s) => s.ownerId === ownerId)
        .length,
    create: async ({ data }: any) => {
      const row = {
        id: `study-${state.studies.size + 1}`,
        chaptersCount: 0,
        visibility: data.visibility ?? 'private',
        topics: data.topics ?? [],
        likes: 0,
        fromKind: 'scratch',
        fromRefId: null,
        description: data.description ?? null,
        isPublic: data.isPublic ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      state.studies.set(row.id, row);
      return row;
    },
    update: async ({ where: { id }, data }: any) => {
      const existing = state.studies.get(id);
      const updated = { ...existing, ...data, updatedAt: new Date() };
      state.studies.set(id, updated);
      return updated;
    },
  };
  const chapterHelpers = {
    findUnique: async ({ where: { id } }: any) =>
      state.chapters.get(id) ?? null,
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
    update: async ({ where: { id }, data }: any) => {
      const existing = state.chapters.get(id);
      const updated = { ...existing, ...data, updatedAt: new Date() };
      state.chapters.set(id, updated);
      return updated;
    },
    create: async ({ data }: any) => {
      const row = {
        id: `chapter-${state.chapters.size + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      state.chapters.set(row.id, row);
      return row;
    },
  };
  const inviteHelpers = {
    create: async ({ data }: any) => {
      const row = { ...data, createdAt: new Date() };
      state.invites.set(data.token, row);
      return row;
    },
    findUnique: async ({ where: { token }, include }: any) => {
      const row = state.invites.get(token);
      if (!row) return null;
      if (include?.study) {
        return { ...row, study: state.studies.get(row.studyId) };
      }
      return row;
    },
    update: async ({ where: { token }, data }: any) => {
      const row = state.invites.get(token);
      const updated = { ...row, ...data };
      state.invites.set(token, updated);
      return updated;
    },
  };

  const prisma: any = {
    study: studyHelpers,
    studyMember: studyMemberHelpers,
    studyChapter: chapterHelpers,
    studyInvite: inviteHelpers,
    $transaction: async (cb: any) => cb(prisma),
  };
  return prisma;
}

describe('Study lifecycle E2E (KS-2862 B6)', () => {
  it('owner → invite contributor → PATCH chapter → remove → 404', async () => {
    const state: Row = {
      studies: new Map(),
      members: new Map(),
      invites: new Map(),
      chapters: new Map(),
    };
    const prisma = makeInMemoryPrisma(state);
    const slugSvc: any = {
      generateUnique: jest.fn(async () => 'slug-1'),
    };
    const members = new StudyMembersService(prisma);
    const study = new StudyService(prisma, slugSvc, members);
    const invites = new StudyInvitesService(prisma, members);
    const chapters = new StudyChaptersService(prisma);
    const ownerId = 'u-owner';
    const contributorId = 'u-bob';

    // Шаг 1: owner создаёт студию — owner-record в members появляется.
    const created = await study.create(ownerId, { name: 'My Study' });
    expect(state.studies.has(created.id)).toBe(true);
    const ownerRole = await members.getRole(created.id, ownerId);
    expect(ownerRole).toBe('owner');

    // Создаём главу (для PATCH контрибьютора).
    const studyRow = state.studies.get(created.id);
    const chapter = await chapters.create(studyRow, {
      name: 'C1',
      pgn: '1. e4 *',
    });
    expect(chapter.id).toBeDefined();

    // Шаг 2: owner генерирует invite, contributor accept'ит.
    const { token } = await invites.createInvite(studyRow, ownerId);
    const accepted = await invites.accept(token, contributorId);
    expect(accepted.role).toBe('contributor');
    const contributorRole = await members.getRole(created.id, contributorId);
    expect(contributorRole).toBe('contributor');

    // Шаг 3: contributor проходит StudyContributorGuard.
    const guard = new StudyContributorGuard(
      prisma,
      {
        getAllAndOverride: jest.fn(
          (key: string): StudyResourceKind | undefined =>
            key === STUDY_RESOURCE_KEY ? 'study-slug' : undefined,
        ),
      } as unknown as Reflector,
      members,
    );
    const ctx = {
      getHandler: () => 'h',
      getClass: () => 'c',
      switchToHttp: () => ({
        getRequest: () => ({
          user: { id: contributorId },
          params: { slug: studyRow.slug },
        }),
      }),
    } as any;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    // KS-2911: contributor может прочитать студию через
    // `StudyService.resolveBySlug` — раньше это давало null (404 на GET).
    const resolved = await study.resolveBySlug(contributorId, studyRow.slug);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(studyRow.id);

    // KS-2911: и через `requireMember` для chapter-mutating endpoints.
    const memberStudy = await study.requireMember(
      contributorId,
      studyRow.slug,
    );
    expect(memberStudy.id).toBe(studyRow.id);

    // Contributor реально может обновить главу через сервис.
    const updated = await chapters.update(studyRow, chapter.id, {
      pgn: '1. d4 *',
    });
    expect(updated.pgn).toBe('1. d4 *');

    // Шаг 4: owner удаляет contributor'а.
    await members.removeMember(created.id, contributorId);
    expect(await members.getRole(created.id, contributorId)).toBeNull();

    // Шаг 5: бывший contributor больше не проходит guard.
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
