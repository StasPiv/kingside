import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LecturesService } from './lectures.service';
import { PrismaService } from '../prisma/prisma.service';
import { LiveAnalysisService } from '../live-analysis/live-analysis.service';

/**
 * KS-3784 / ADR-113 §4 эпик 1. Unit-тесты `LecturesService`.
 *
 * Покрытие:
 *   - create: scheduled (со scheduledAt) и immediate-live (без него).
 *   - start: 404, 403, идемпотентность для уже-live, отказ для
 *     recorded/cancelled, P2002 при concurrent start.
 *   - listByCoach: 404 для неизвестного username, фильтр по статусу
 *     и visibility=public.
 *   - getById: 404 / возврат public и unlisted.
 */
describe('LecturesService', () => {
  let service: LecturesService;
  let prisma: {
    lecture: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    user: {
      findUnique: jest.Mock;
    };
    liveAnalysis: {
      findUnique: jest.Mock;
    };
  };
  let liveAnalysis: {
    createBareLiveSession: jest.Mock;
    create: jest.Mock;
  };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      lecture: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      liveAnalysis: {
        // fetchLiveAnalysisBinding (для идемпотентного start) запрашивает
        // slug по id. По умолчанию возвращаем стандартную запись.
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'la-existing', slug: 'EXIST00000' }),
      },
    };
    liveAnalysis = {
      createBareLiveSession: jest.fn().mockResolvedValue({
        id: 'la-1',
        slug: 'SLUG000000',
      }),
      // LiveAnalysisService.create возвращает LiveAnalysisResponse, нам
      // нужны id/slug/url для openLectureLiveSession.
      create: jest.fn().mockResolvedValue({
        id: 'la-analysis-bound',
        slug: 'BOUND00000',
        url: 'https://kingside.site/live/BOUND00000',
      }),
    };
    config = {
      get: jest.fn((key: string) =>
        key === 'PUBLIC_BASE_URL' ? 'https://kingside.site' : undefined,
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LecturesService,
        { provide: PrismaService, useValue: prisma },
        { provide: LiveAnalysisService, useValue: liveAnalysis },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(LecturesService);
  });

  // ─── create ───────────────────────────────────────────────────────

  describe('create', () => {
    it('scheduled с scheduledAt: запись со status=scheduled, без LiveAnalysis', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      await service.create('u-1', {
        title: 'Урок 1',
        scheduledAt: '2026-06-07T18:00:00.000Z',
      });
      expect(liveAnalysis.createBareLiveSession).not.toHaveBeenCalled();
      const data = prisma.lecture.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        ownerId: 'u-1',
        title: 'Урок 1',
        status: 'scheduled',
        visibility: 'public',
      });
      expect(data.scheduledAt).toBeInstanceOf(Date);
      expect(data.startedAt).toBeUndefined();
      expect(data.liveAnalysisId).toBeUndefined();
    });

    it('immediate-live без scheduledAt: создаётся LiveAnalysis и статус сразу live', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-2',
        ownerId: 'u-1',
        status: 'live',
        liveAnalysisId: 'la-1',
      });
      await service.create('u-1', { title: 'Стрим' });
      expect(liveAnalysis.createBareLiveSession).toHaveBeenCalledWith('u-1', {
        title: 'Стрим',
      });
      const data = prisma.lecture.create.mock.calls[0][0].data;
      expect(data.status).toBe('live');
      expect(data.liveAnalysisId).toBe('la-1');
      expect(data.startedAt).toBeInstanceOf(Date);
    });

    it('visibility=unlisted применяется', async () => {
      prisma.lecture.create.mockResolvedValueOnce({ id: 'l-3' });
      await service.create('u-1', {
        title: 'Закрытый стрим',
        visibility: 'unlisted',
      });
      const data = prisma.lecture.create.mock.calls[0][0].data;
      expect(data.visibility).toBe('unlisted');
    });

    it('KS-3789: immediate-live с analysisId использует LiveAnalysisService.create', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-4',
        ownerId: 'u-1',
        status: 'live',
        liveAnalysisId: 'la-analysis-bound',
      });
      const r = await service.create('u-1', {
        title: 'Лекция по партии',
        analysisId: 'a-1',
      });
      expect(liveAnalysis.create).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({ analysisId: 'a-1', title: 'Лекция по партии' }),
        expect.any(String),
      );
      expect(liveAnalysis.createBareLiveSession).not.toHaveBeenCalled();
      expect(r.lecture.liveAnalysisId).toBe('la-analysis-bound');
      expect(r.liveAnalysis?.slug).toBe('BOUND00000');
      expect(r.liveAnalysis?.url).toBe('https://kingside.site/live/BOUND00000');
    });
  });

  // ─── start ────────────────────────────────────────────────────────

  describe('start', () => {
    it('404 если лекции нет', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(service.start('missing', 'u-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('403 если не владелец', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'OTHER',
        status: 'scheduled',
      });
      await expect(service.start('l-1', 'u-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('идемпотентно: уже live → возвращает текущую без побочных эффектов', async () => {
      const existing = {
        id: 'l-1',
        ownerId: 'u-1',
        status: 'live',
        liveAnalysisId: 'la-existing',
      };
      prisma.lecture.findUnique.mockResolvedValueOnce(existing);
      const r = await service.start('l-1', 'u-1');
      expect(r.lecture).toBe(existing);
      expect(r.liveAnalysis?.slug).toBe('EXIST00000');
      expect(liveAnalysis.createBareLiveSession).not.toHaveBeenCalled();
      expect(liveAnalysis.create).not.toHaveBeenCalled();
      expect(prisma.lecture.update).not.toHaveBeenCalled();
    });

    it('400 если recorded', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'recorded',
      });
      await expect(service.start('l-1', 'u-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('400 если cancelled', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'cancelled',
      });
      await expect(service.start('l-1', 'u-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('scheduled → live: создаёт LiveAnalysis и обновляет запись', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        title: 'Урок 1',
        status: 'scheduled',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        id: 'l-1',
        status: 'live',
        liveAnalysisId: 'la-1',
      });
      const r = await service.start('l-1', 'u-1');
      expect(liveAnalysis.createBareLiveSession).toHaveBeenCalledWith('u-1', {
        title: 'Урок 1',
      });
      expect(prisma.lecture.update).toHaveBeenCalledWith({
        where: { id: 'l-1' },
        data: expect.objectContaining({
          status: 'live',
          liveAnalysisId: 'la-1',
        }),
      });
      expect(r.lecture.status).toBe('live');
      expect(r.liveAnalysis?.id).toBe('la-1');
    });

    it('KS-3789: scheduled → live с analysisId использует LiveAnalysisService.create', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        title: 'Лекция с анализом',
        status: 'scheduled',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        id: 'l-1',
        status: 'live',
        liveAnalysisId: 'la-analysis-bound',
      });
      const r = await service.start('l-1', 'u-1', { analysisId: 'a-1' });
      expect(liveAnalysis.create).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({ analysisId: 'a-1', title: 'Лекция с анализом' }),
        expect.any(String),
      );
      expect(liveAnalysis.createBareLiveSession).not.toHaveBeenCalled();
      expect(r.liveAnalysis?.id).toBe('la-analysis-bound');
    });

    it('concurrent P2002 на partial UNIQUE → возвращает существующую live', async () => {
      prisma.lecture.findUnique
        .mockResolvedValueOnce({
          id: 'l-1',
          ownerId: 'u-1',
          status: 'scheduled',
          title: 't',
        })
        .mockResolvedValueOnce({
          id: 'l-1',
          ownerId: 'u-1',
          status: 'live',
          liveAnalysisId: 'la-winner',
        });
      const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });
      prisma.lecture.update.mockRejectedValueOnce(p2002);
      const r = await service.start('l-1', 'u-1');
      expect(r.lecture.status).toBe('live');
      expect(r.lecture.liveAnalysisId).toBe('la-winner');
    });
  });

  // ─── listByCoach ──────────────────────────────────────────────────

  describe('listByCoach', () => {
    it('404 если username не найден', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.listByCoach('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('фильтрует по ownerId и visibility=public; status опциональный', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      await service.listByCoach('alice', 'live');
      expect(prisma.lecture.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ownerId: 'u-1',
            visibility: 'public',
            status: 'live',
          }),
        }),
      );
    });

    it('без status — фильтр только по ownerId и visibility', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      await service.listByCoach('alice');
      const args = prisma.lecture.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        ownerId: 'u-1',
        visibility: 'public',
      });
    });

    it('KS-3787: для live-лекций отдаёт liveAnalysis { id, slug, url }', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([
        {
          id: 'l-live',
          status: 'live',
          liveAnalysisId: 'la-1',
          liveAnalysis: { id: 'la-1', slug: 'SLUG000001' },
        },
        {
          id: 'l-scheduled',
          status: 'scheduled',
          liveAnalysisId: null,
          liveAnalysis: null,
        },
      ]);
      const result = await service.listByCoach('alice');
      expect(result[0].liveAnalysis).toEqual({
        id: 'la-1',
        slug: 'SLUG000001',
        url: 'https://kingside.site/live/SLUG000001',
      });
      expect(result[1].liveAnalysis).toBeNull();
      // include передан в findMany.
      const args = prisma.lecture.findMany.mock.calls[0][0];
      expect(args.include).toEqual({
        liveAnalysis: { select: { id: true, slug: true } },
      });
    });
  });

  // ─── getById ──────────────────────────────────────────────────────

  describe('getById', () => {
    it('404 если не существует', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(service.getById('missing')).rejects.toThrow(NotFoundException);
    });

    it('возвращает public и liveAnalysis=null если нет привязки', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        visibility: 'public',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      const r = await service.getById('l-1');
      expect(r.visibility).toBe('public');
      expect(r.liveAnalysis).toBeNull();
    });

    it('возвращает unlisted (доступ по прямой ссылке)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        visibility: 'unlisted',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      const r = await service.getById('l-1');
      expect(r.visibility).toBe('unlisted');
    });

    it('KS-3787: live-лекция отдаёт liveAnalysis с id, slug, url', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-2',
        visibility: 'public',
        status: 'live',
        liveAnalysisId: 'la-1',
        liveAnalysis: { id: 'la-1', slug: 'SLUG000002' },
      });
      const r = await service.getById('l-2');
      expect(r.liveAnalysis).toEqual({
        id: 'la-1',
        slug: 'SLUG000002',
        url: 'https://kingside.site/live/SLUG000002',
      });
    });
  });

  // ─── KS-3800: update (PATCH) ──────────────────────────────────────

  describe('update', () => {
    const scheduled = {
      id: 'l-1',
      ownerId: 'u-1',
      status: 'scheduled' as const,
    };

    it('404 если лекции нет', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.update('missing', 'u-1', { title: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('403 если не владелец', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        ownerId: 'OTHER',
      });
      await expect(
        service.update('l-1', 'u-1', { title: 'x' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('400 если статус не scheduled (например, live)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
      });
      await expect(
        service.update('l-1', 'u-1', { scheduledAt: '2026-07-01T10:00:00Z' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.lecture.update).not.toHaveBeenCalled();
    });

    it('400 если статус recorded', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
      });
      await expect(
        service.update('l-1', 'u-1', { title: 'new' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('обновляет title/description/scheduledAt/visibility для scheduled', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        title: 'Новое название',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', {
        title: 'Новое название',
        description: 'описание',
        scheduledAt: '2026-07-01T10:00:00Z',
        visibility: 'unlisted',
      });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'l-1' });
      expect(args.data.title).toBe('Новое название');
      expect(args.data.description).toBe('описание');
      expect(args.data.scheduledAt).toBeInstanceOf(Date);
      expect(args.data.visibility).toBe('unlisted');
    });

    it('пустая строка description → null', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { description: '' });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data.description).toBeNull();
    });

    it('PATCH без полей → пустой UPDATE data', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', {});
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({});
    });
  });

  // ─── KS-3800: cancel ──────────────────────────────────────────────

  describe('cancel', () => {
    const scheduled = {
      id: 'l-1',
      ownerId: 'u-1',
      status: 'scheduled' as const,
    };

    it('404 если лекции нет', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(service.cancel('missing', 'u-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('403 если не владелец', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        ownerId: 'OTHER',
      });
      await expect(service.cancel('l-1', 'u-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('400 если уже cancelled', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'cancelled',
      });
      await expect(service.cancel('l-1', 'u-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.lecture.update).not.toHaveBeenCalled();
    });

    it('400 если live (нельзя отменить идущую)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
      });
      await expect(service.cancel('l-1', 'u-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('400 если recorded', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
      });
      await expect(service.cancel('l-1', 'u-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('scheduled → cancelled', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'cancelled',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      const r = await service.cancel('l-1', 'u-1');
      expect(prisma.lecture.update).toHaveBeenCalledWith({
        where: { id: 'l-1' },
        data: { status: 'cancelled' },
        include: { liveAnalysis: { select: { id: true, slug: true } } },
      });
      // service.cancel возвращает запись через withLiveAnalysisBinding —
      // поля Lecture развёрнуты на верхнем уровне, liveAnalysis рядом.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((r as any).status).toBe('cancelled');
      expect(r.liveAnalysis).toBeNull();
    });
  });

  // ─── KS-3793: getRecordingByLectureId ─────────────────────────────

  describe('getRecordingByLectureId', () => {
    it('404 если лекции нет', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(service.getRecordingByLectureId('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404 если статус != recorded', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        status: 'live',
        recording: null,
      });
      await expect(service.getRecordingByLectureId('l-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404 если recording отсутствует (например, cancelled)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        status: 'cancelled',
        recording: null,
      });
      await expect(service.getRecordingByLectureId('l-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('200 с полной записью если recorded и recording привязан', async () => {
      const recording = {
        id: 'rec-1',
        lectureId: 'l-1',
        events: [{ t: 0, type: 'move', payload: { uci: 'e2e4', ply: 1 } }],
        durationMs: 1200,
        eventCount: 1,
        byteSize: 42,
        startingFen: 'rnbqkbnr/...',
        orientation: 'white',
        truncated: false,
        createdAt: new Date('2026-06-06T00:00:00Z'),
      };
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        status: 'recorded',
        recording,
      });
      const r = await service.getRecordingByLectureId('l-1');
      expect(r).toBe(recording);
      // findUnique вызывается с include: { recording: true }.
      const args = prisma.lecture.findUnique.mock.calls[0][0];
      expect(args.include).toEqual({ recording: true });
    });
  });
});
