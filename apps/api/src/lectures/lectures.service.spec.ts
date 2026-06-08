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
import { LectureAudioS3Service } from '../lecture-audio/lecture-audio-s3.service';
import {
  LectureAudioService,
  NoChunksError,
} from '../lecture-audio/lecture-audio.service';
import { RedisService } from '../redis/redis.service';
import { LecturesAccessService } from './lectures-access.service';

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
      delete: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
    user: {
      findUnique: jest.Mock;
    };
    liveAnalysis: {
      findUnique: jest.Mock;
    };
    lectureAccessGrant: {
      createMany: jest.Mock;
    };
  };
  let liveAnalysis: {
    createBareLiveSession: jest.Mock;
    create: jest.Mock;
    closeBySlug: jest.Mock;
  };
  let config: { get: jest.Mock };
  let audioS3: {
    signedCloudFrontUrl: jest.Mock;
    deleteChunks: jest.Mock;
    deleteFinalTrack: jest.Mock;
    isDisabled: jest.Mock;
  };
  let audioService: { finalizeRecording: jest.Mock };
  let redis: { publish: jest.Mock };
  let lecturesAccessMock: { publishRevokeEvent: jest.Mock };

  beforeEach(async () => {
    prisma = {
      lecture: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      // KS-3937: $transaction([findMany, count]) — для listMyLectures.
      // По дефолту разворачивает массив промисов в Promise.all-style.
      $transaction: jest.fn().mockImplementation((arr: Promise<unknown>[]) =>
        Promise.all(arr),
      ),
      user: {
        findUnique: jest.fn(),
      },
      liveAnalysis: {
        // fetchLiveAnalysisBinding (для идемпотентного start) запрашивает
        // slug по id. По умолчанию возвращаем стандартную запись.
        // KS-3887: для идемпотентной ветки `start()` дополнительно
        // запрашивается `status` — по умолчанию `active`, чтобы
        // существующие тесты не открывали новую сессию.
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 'la-existing',
            slug: 'EXIST00000',
            status: 'active',
          }),
      },
      // KS-3934 / ADR-118 §2.4.1. Bulk INSERT начального allowlist'а.
      // По умолчанию `createMany` ничего не делает (BD-no-op).
      lectureAccessGrant: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
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
      closeBySlug: jest
        .fn()
        .mockResolvedValue({ id: 'la-existing', alreadyClosed: false }),
    };
    config = {
      get: jest.fn((key: string) =>
        key === 'PUBLIC_BASE_URL' ? 'https://kingside.site' : undefined,
      ),
    };
    audioS3 = {
      signedCloudFrontUrl: jest
        .fn()
        .mockResolvedValue(
          'https://media.kingside.site/audio/L/track.ogg?Key-Pair-Id=K&Signature=S&Expires=1',
        ),
      deleteChunks: jest.fn().mockResolvedValue(0),
      deleteFinalTrack: jest.fn().mockResolvedValue(undefined),
      // KS-3866: сервис в обычном режиме — disabled=false.
      isDisabled: jest.fn().mockReturnValue(false),
    };
    audioService = {
      finalizeRecording: jest.fn().mockResolvedValue({
        lectureId: 'l-1',
        durationMs: 0,
        offsetMs: 0,
      }),
    };
    redis = {
      publish: jest.fn().mockResolvedValue(1),
    };
    // KS-3942: LecturesAccessService инжектится для publishRevokeEvent
    // в `update` при visibility: public/unlisted → restricted в live.
    // По дефолту мок ничего не делает (publish — no-op).
    lecturesAccessMock = {
      publishRevokeEvent: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LecturesService,
        { provide: PrismaService, useValue: prisma },
        { provide: LiveAnalysisService, useValue: liveAnalysis },
        { provide: ConfigService, useValue: config },
        { provide: LectureAudioS3Service, useValue: audioS3 },
        { provide: LectureAudioService, useValue: audioService },
        { provide: RedisService, useValue: redis },
        { provide: LecturesAccessService, useValue: lecturesAccessMock },
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

    it('KS-3900: scheduled + disabledTools передаётся в Prisma create', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-tools-1',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      await service.create('u-1', {
        title: 'Урок с фильтром инструментов',
        scheduledAt: '2026-06-07T18:00:00.000Z',
        disabledTools: ['engine', 'book'],
      });
      const data = prisma.lecture.create.mock.calls[0][0].data;
      expect(data.disabledTools).toEqual(['engine', 'book']);
    });

    it('KS-3900: scheduled без disabledTools → Prisma create без поля (DB default подхватится)', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-tools-2',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      await service.create('u-1', {
        title: 'Без фильтра',
        scheduledAt: '2026-06-07T18:00:00.000Z',
      });
      const data = prisma.lecture.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('disabledTools');
    });

    it('KS-3900: immediate-live + disabledTools передаётся в Prisma create', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-tools-3',
        ownerId: 'u-1',
        status: 'live',
        liveAnalysisId: 'la-1',
      });
      await service.create('u-1', {
        title: 'Live с фильтром',
        disabledTools: ['analyze_game', 'generate_puzzle'],
      });
      const data = prisma.lecture.create.mock.calls[0][0].data;
      expect(data.disabledTools).toEqual(['analyze_game', 'generate_puzzle']);
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

    // ─── KS-3934 / ADR-118 §2.4.1: initialAccessUserIds + bulk INSERT ─

    it('KS-3934: scheduled + restricted + initialAccessUserIds → bulk INSERT', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-rest-1',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      const userA = '00000000-0000-4000-8000-00000000000a';
      const userB = '00000000-0000-4000-8000-00000000000b';
      await service.create('u-1', {
        title: 'Для двоих',
        scheduledAt: '2026-07-01T10:00:00Z',
        visibility: 'restricted',
        initialAccessUserIds: [userA, userB],
      });
      expect(prisma.lecture.create.mock.calls[0][0].data.visibility).toBe(
        'restricted',
      );
      expect(prisma.lectureAccessGrant.createMany).toHaveBeenCalledTimes(1);
      const args = prisma.lectureAccessGrant.createMany.mock.calls[0][0];
      expect(args.skipDuplicates).toBe(true);
      expect(args.data).toEqual([
        { lectureId: 'l-rest-1', subjectType: 'user', subjectId: userA, grantedById: 'u-1' },
        { lectureId: 'l-rest-1', subjectType: 'user', subjectId: userB, grantedById: 'u-1' },
      ]);
    });

    it('KS-3934: immediate-live + restricted + initialAccessUserIds → bulk INSERT (после создания live)', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-rest-2',
        ownerId: 'u-1',
        status: 'live',
        liveAnalysisId: 'la-1',
      });
      const userA = '00000000-0000-4000-8000-00000000000a';
      await service.create('u-1', {
        title: 'Live closed',
        visibility: 'restricted',
        initialAccessUserIds: [userA],
      });
      expect(prisma.lectureAccessGrant.createMany).toHaveBeenCalledTimes(1);
      const args = prisma.lectureAccessGrant.createMany.mock.calls[0][0];
      expect(args.data).toEqual([
        { lectureId: 'l-rest-2', subjectType: 'user', subjectId: userA, grantedById: 'u-1' },
      ]);
    });

    it('KS-3934: restricted + пустой initialAccessUserIds → createMany не вызывается', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-rest-3',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      await service.create('u-1', {
        title: 'Только для меня',
        scheduledAt: '2026-07-01T10:00:00Z',
        visibility: 'restricted',
        initialAccessUserIds: [],
      });
      expect(prisma.lectureAccessGrant.createMany).not.toHaveBeenCalled();
    });

    it('KS-3934: restricted без поля initialAccessUserIds → createMany не вызывается', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-rest-4',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      await service.create('u-1', {
        title: 'Только для меня',
        scheduledAt: '2026-07-01T10:00:00Z',
        visibility: 'restricted',
      });
      expect(prisma.lectureAccessGrant.createMany).not.toHaveBeenCalled();
    });

    it('KS-3934: public + initialAccessUserIds → массив игнорируется (warn в логе)', async () => {
      prisma.lecture.create.mockResolvedValueOnce({
        id: 'l-pub-1',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      const userA = '00000000-0000-4000-8000-00000000000a';
      await service.create('u-1', {
        title: 'Открытая лекция',
        scheduledAt: '2026-07-01T10:00:00Z',
        visibility: 'public',
        initialAccessUserIds: [userA],
      });
      // visibility=public → grants не создаются, даже если массив непустой.
      expect(prisma.lectureAccessGrant.createMany).not.toHaveBeenCalled();
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

    // KS-3887: возобновление лекции, чья LiveAnalysis закрыта cleanup'ом.
    it('KS-3887: уже live, LiveAnalysis closed → создаём новую и пересвязываем lecture', async () => {
      const existing = {
        id: 'l-1',
        ownerId: 'u-1',
        status: 'live',
        title: 't',
        liveAnalysisId: 'la-old',
      };
      prisma.lecture.findUnique.mockResolvedValueOnce(existing);
      // findUnique liveAnalysis: первый вызов — проверка статуса
      // (closed), затем fetchLiveAnalysisBinding не вызывается, потому
      // что путь идёт по созданию новой сессии.
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({
        id: 'la-old',
        slug: 'OLD0000000',
        status: 'closed',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...existing,
        liveAnalysisId: 'la-1',
      });
      const r = await service.start('l-1', 'u-1');
      expect(liveAnalysis.createBareLiveSession).toHaveBeenCalled();
      expect(prisma.lecture.update).toHaveBeenCalledWith({
        where: { id: 'l-1' },
        data: { liveAnalysisId: 'la-1' },
      });
      expect(r.lecture.liveAnalysisId).toBe('la-1');
      expect(r.liveAnalysis?.id).toBe('la-1');
    });

    it('KS-3887: уже live, liveAnalysisId=null → создаём новую сессию', async () => {
      const existing = {
        id: 'l-1',
        ownerId: 'u-1',
        status: 'live',
        title: 't',
        liveAnalysisId: null,
      };
      prisma.lecture.findUnique.mockResolvedValueOnce(existing);
      prisma.lecture.update.mockResolvedValueOnce({
        ...existing,
        liveAnalysisId: 'la-1',
      });
      const r = await service.start('l-1', 'u-1');
      expect(liveAnalysis.createBareLiveSession).toHaveBeenCalled();
      expect(r.lecture.liveAnalysisId).toBe('la-1');
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

    // KS-3834 / ADR-116 §2.5: serverNow в ответе для компенсации
    // clock-skew клиента. Проверяем во всех трёх ветках start'а
    // (fresh scheduled→live, идемпотентный уже-live, concurrent P2002).
    it('KS-3834: возвращает serverNow близкий к Date.now() (fresh scheduled→live)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        title: 't',
        status: 'scheduled',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        id: 'l-1',
        status: 'live',
        liveAnalysisId: 'la-1',
      });
      const before = Date.now();
      const r = await service.start('l-1', 'u-1');
      const after = Date.now();
      expect(typeof r.serverNow).toBe('string');
      const ts = Date.parse(r.serverNow);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
      expect(Math.abs(ts - Date.now())).toBeLessThan(5000);
    });

    it('KS-3834: serverNow присутствует и в идемпотентной ветке (уже live)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'live',
        liveAnalysisId: 'la-existing',
      });
      const r = await service.start('l-1', 'u-1');
      expect(typeof r.serverNow).toBe('string');
      expect(Number.isNaN(Date.parse(r.serverNow))).toBe(false);
    });

    it('KS-3834: serverNow присутствует и в ветке concurrent P2002', async () => {
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
      expect(typeof r.serverNow).toBe('string');
      expect(Number.isNaN(Date.parse(r.serverNow))).toBe(false);
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

  // ─── KS-3801: scheduleByCoach ─────────────────────────────────────

  describe('scheduleByCoach', () => {
    it('404 если username не найден', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.scheduleByCoach('ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('фильтр: ownerId, visibility=public, status in [scheduled, live]', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      await service.scheduleByCoach('alice');
      const args = prisma.lecture.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        ownerId: 'u-1',
        visibility: 'public',
        status: { in: ['scheduled', 'live'] },
      });
      // ASC по scheduledAt — ближайшие сверху.
      expect(args.orderBy).toEqual([
        { scheduledAt: 'asc' },
        { createdAt: 'asc' },
      ]);
    });

    it('from применяется как gte по scheduledAt', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      await service.scheduleByCoach('alice', '2026-06-06T00:00:00.000Z');
      const args = prisma.lecture.findMany.mock.calls[0][0];
      expect(args.where.scheduledAt.gte).toBeInstanceOf(Date);
      expect(args.where.scheduledAt.lte).toBeUndefined();
    });

    it('to применяется как lte по scheduledAt', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      await service.scheduleByCoach('alice', undefined, '2026-07-01T00:00:00.000Z');
      const args = prisma.lecture.findMany.mock.calls[0][0];
      expect(args.where.scheduledAt.gte).toBeUndefined();
      expect(args.where.scheduledAt.lte).toBeInstanceOf(Date);
    });

    it('from и to задают замкнутое окно', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      await service.scheduleByCoach(
        'alice',
        '2026-06-06T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
      );
      const args = prisma.lecture.findMany.mock.calls[0][0];
      expect(args.where.scheduledAt.gte).toBeInstanceOf(Date);
      expect(args.where.scheduledAt.lte).toBeInstanceOf(Date);
    });

    it('без from/to ключ scheduledAt в where отсутствует', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      await service.scheduleByCoach('alice');
      const args = prisma.lecture.findMany.mock.calls[0][0];
      expect(args.where.scheduledAt).toBeUndefined();
    });

    it('возвращает liveAnalysis { id, slug, url } для live и null для scheduled', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1' });
      prisma.lecture.findMany.mockResolvedValueOnce([
        {
          id: 'l-sched',
          status: 'scheduled',
          scheduledAt: new Date('2026-06-10T18:00:00Z'),
          liveAnalysisId: null,
          liveAnalysis: null,
        },
        {
          id: 'l-live',
          status: 'live',
          scheduledAt: null,
          liveAnalysisId: 'la-1',
          liveAnalysis: { id: 'la-1', slug: 'SLUG000003' },
        },
      ]);
      const r = await service.scheduleByCoach('alice');
      expect(r[0].liveAnalysis).toBeNull();
      expect(r[1].liveAnalysis).toEqual({
        id: 'la-1',
        slug: 'SLUG000003',
        url: 'https://kingside.site/live/SLUG000003',
      });
    });
  });

  // ─── KS-3937 / ADR-118 §2.4.1: listMyLectures ─────────────────────

  describe('listMyLectures (KS-3937)', () => {
    const userId = '11111111-1111-4111-a111-111111111111';

    it('OR(ownerId, accessGrants.some) + сортировка updatedAt DESC', async () => {
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      prisma.lecture.count.mockResolvedValueOnce(0);
      await service.listMyLectures(userId);
      const findArgs = prisma.lecture.findMany.mock.calls[0][0];
      expect(findArgs.where).toEqual({
        OR: [
          { ownerId: userId },
          {
            accessGrants: {
              some: { subjectType: 'user', subjectId: userId },
            },
          },
        ],
      });
      expect(findArgs.orderBy).toEqual([{ updatedAt: 'desc' }]);
    });

    it('фильтр по status добавляется в where', async () => {
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      prisma.lecture.count.mockResolvedValueOnce(0);
      await service.listMyLectures(userId, { status: 'live' });
      const findArgs = prisma.lecture.findMany.mock.calls[0][0];
      expect(findArgs.where.status).toBe('live');
    });

    it('пагинация: limit/offset clamp до [1..100] и >=0', async () => {
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      prisma.lecture.count.mockResolvedValueOnce(0);
      await service.listMyLectures(userId, { limit: 999, offset: -5 });
      const findArgs = prisma.lecture.findMany.mock.calls[0][0];
      expect(findArgs.take).toBe(100);
      expect(findArgs.skip).toBe(0);
    });

    it('пагинация: дефолты limit=50, offset=0', async () => {
      prisma.lecture.findMany.mockResolvedValueOnce([]);
      prisma.lecture.count.mockResolvedValueOnce(0);
      await service.listMyLectures(userId);
      const findArgs = prisma.lecture.findMany.mock.calls[0][0];
      expect(findArgs.take).toBe(50);
      expect(findArgs.skip).toBe(0);
    });

    it('hasMore=true когда offset + items < total', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        id: `lec-${i}`,
        ownerId: userId,
        liveAnalysisId: null,
        liveAnalysis: null,
      }));
      prisma.lecture.findMany.mockResolvedValueOnce(rows);
      prisma.lecture.count.mockResolvedValueOnce(42);
      const r = await service.listMyLectures(userId, { limit: 10, offset: 0 });
      expect(r.total).toBe(42);
      expect(r.items).toHaveLength(10);
      expect(r.hasMore).toBe(true);
    });

    it('hasMore=false когда offset + items >= total', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        id: `lec-${i}`,
        ownerId: userId,
        liveAnalysisId: null,
        liveAnalysis: null,
      }));
      prisma.lecture.findMany.mockResolvedValueOnce(rows);
      prisma.lecture.count.mockResolvedValueOnce(3);
      const r = await service.listMyLectures(userId);
      expect(r.hasMore).toBe(false);
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

    it('KS-3903: disabledTools проходит в LectureDetail из Prisma findUnique', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-tools',
        visibility: 'public',
        status: 'live',
        liveAnalysisId: null,
        liveAnalysis: null,
        disabledTools: ['engine', 'book'],
      });
      const r = await service.getById('l-tools');
      expect((r as { disabledTools: string[] }).disabledTools).toEqual([
        'engine',
        'book',
      ]);
    });

    it('KS-3903: пустой disabledTools тоже проходит как []', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-tools-empty',
        visibility: 'public',
        status: 'scheduled',
        liveAnalysisId: null,
        liveAnalysis: null,
        disabledTools: [],
      });
      const r = await service.getById('l-tools-empty');
      expect((r as { disabledTools: string[] }).disabledTools).toEqual([]);
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

    // KS-3835 / ADR-116 §5.1: audio в ответе getById.
    it('KS-3835: recorded-лекция с LectureAudio отдаёт audio { url, durationMs, offsetMs, codec, container }', async () => {
      audioS3.signedCloudFrontUrl.mockResolvedValueOnce(
        'https://media.kingside.site/audio/l-rec/track.ogg?Key-Pair-Id=K22OGMBTKZ8IZR&Signature=SIG&Expires=12345',
      );
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-rec',
        visibility: 'public',
        status: 'recorded',
        liveAnalysisId: null,
        liveAnalysis: null,
        audio: {
          durationMs: 3_600_000,
          offsetMs: 1200,
          codec: 'opus',
          container: 'ogg',
        },
      });
      const r = (await service.getById('l-rec')) as unknown as {
        audio: {
          url: string;
          durationMs: number;
          offsetMs: number;
          codec: string;
          container: string;
        } | null;
      };
      expect(r.audio).not.toBeNull();
      expect(r.audio!.url).toContain('/audio/l-rec/track.ogg');
      expect(r.audio!.url).toContain('Key-Pair-Id=');
      expect(r.audio!.url).toContain('Signature=');
      expect(r.audio!.durationMs).toBe(3_600_000);
      expect(r.audio!.offsetMs).toBe(1200);
      expect(r.audio!.codec).toBe('opus');
      expect(r.audio!.container).toBe('ogg');
      expect(audioS3.signedCloudFrontUrl).toHaveBeenCalledWith('l-rec');
    });

    it('KS-3835: лекция без audio → audio: null, signedCloudFrontUrl не вызывается', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-3',
        visibility: 'public',
        liveAnalysisId: null,
        liveAnalysis: null,
        audio: null,
      });
      const r = (await service.getById('l-3')) as unknown as {
        audio: unknown;
      };
      expect(r.audio).toBeNull();
      expect(audioS3.signedCloudFrontUrl).not.toHaveBeenCalled();
    });

    it('KS-3835: unlisted лекция с audio тоже получает signed URL (тот же путь, что у public)', async () => {
      audioS3.signedCloudFrontUrl.mockResolvedValueOnce(
        'https://media.kingside.site/audio/l-u/track.ogg?Key-Pair-Id=K&Signature=X&Expires=1',
      );
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-u',
        visibility: 'unlisted',
        status: 'recorded',
        liveAnalysisId: null,
        liveAnalysis: null,
        audio: {
          durationMs: 100,
          offsetMs: 0,
          codec: 'opus',
          container: 'ogg',
        },
      });
      const r = (await service.getById('l-u')) as unknown as {
        audio: { url: string } | null;
      };
      expect(r.audio).not.toBeNull();
      expect(r.audio!.url).toContain('Signature=');
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

    it('KS-3900: PATCH без полей → no-op, prisma.update не вызывается', async () => {
      prisma.lecture.findUnique
        .mockResolvedValueOnce(scheduled) // первый findUnique для гейта
        .mockResolvedValueOnce({
          ...scheduled,
          liveAnalysisId: null,
          liveAnalysis: null,
        }); // второй — re-read для возврата
      const res = await service.update('l-1', 'u-1', {});
      expect(prisma.lecture.update).not.toHaveBeenCalled();
      expect(res.id).toBe('l-1');
    });

    // ─── KS-3900 / ADR-117: disabledTools во всех статусах ────────────

    it('KS-3900: disabledTools правится в scheduled — успех', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        disabledTools: ['engine'],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { disabledTools: ['engine'] });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ disabledTools: ['engine'] });
    });

    it('KS-3900: disabledTools правится в live — успех (расширенный гейт ADR-117)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        disabledTools: ['engine', 'book'],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', {
        disabledTools: ['engine', 'book'],
      });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ disabledTools: ['engine', 'book'] });
    });

    it('KS-3900: disabledTools правится в recorded — успех (replay-режим)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
        disabledTools: [],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { disabledTools: [] });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ disabledTools: [] });
    });

    it('KS-3900: disabledTools правится в cancelled — успех', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'cancelled',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'cancelled',
        disabledTools: ['engine'],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { disabledTools: ['engine'] });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ disabledTools: ['engine'] });
    });

    it('KS-3900: совмещённый PATCH {title, disabledTools} в live → 400, ничего не записано', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
      });
      await expect(
        service.update('l-1', 'u-1', {
          title: 'не пройдёт',
          disabledTools: ['engine'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.lecture.update).not.toHaveBeenCalled();
    });

    it('KS-3900: совмещённый PATCH {title, disabledTools} в scheduled — оба поля применяются', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        title: 'Новое',
        disabledTools: ['ai_comment'],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', {
        title: 'Новое',
        disabledTools: ['ai_comment'],
      });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data.title).toBe('Новое');
      expect(args.data.disabledTools).toEqual(['ai_comment']);
    });

    // ─── KS-3901 / ADR-117 §3: Redis publish lecture-tools-changed ────

    it('KS-3901: publish в Redis при live + liveAnalysisId — payload {slug, lectureId, disabledTools}', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        liveAnalysisId: 'la-1',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        liveAnalysisId: 'la-1',
        disabledTools: ['engine', 'book'],
        liveAnalysis: { id: 'la-1', slug: 'LIVESLUG01' },
      });
      await service.update('l-1', 'u-1', {
        disabledTools: ['engine', 'book'],
      });
      expect(redis.publish).toHaveBeenCalledTimes(1);
      const [channel, payload] = redis.publish.mock.calls[0];
      expect(channel).toBe('lecture-tools-changed');
      expect(JSON.parse(payload)).toEqual({
        slug: 'LIVESLUG01',
        lectureId: 'l-1',
        disabledTools: ['engine', 'book'],
      });
    });

    it('KS-3901: не публикует в Redis при scheduled (нет подписчиков в эфире)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        disabledTools: ['engine'],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { disabledTools: ['engine'] });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('KS-3901: не публикует в Redis при recorded', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
        disabledTools: ['ai_comment'],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { disabledTools: ['ai_comment'] });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('KS-3901: не публикует в Redis для live без liveAnalysisId', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        liveAnalysisId: null,
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        liveAnalysisId: null,
        disabledTools: ['engine'],
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { disabledTools: ['engine'] });
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('KS-3901: не публикует если PATCH без disabledTools (живая лекция, но поле не менялось)', async () => {
      // Два мока findUnique: первый для гейта, второй для re-read'а
      // в no-op-ветке (см. KS-3900 update).
      prisma.lecture.findUnique
        .mockResolvedValueOnce({
          ...scheduled,
          status: 'live',
          liveAnalysisId: 'la-1',
        })
        .mockResolvedValueOnce({
          ...scheduled,
          status: 'live',
          liveAnalysisId: 'la-1',
          liveAnalysis: { id: 'la-1', slug: 'LIVESLUG03' },
        });
      // Только disabledTools-PATCH разрешён в live, но мы тестируем
      // что без поля publish не идёт (пустой PATCH в live — no-op).
      const res = await service.update('l-1', 'u-1', {});
      expect(redis.publish).not.toHaveBeenCalled();
      expect(prisma.lecture.update).not.toHaveBeenCalled();
      expect(res.id).toBe('l-1');
    });

    it('KS-3901: ошибка Redis publish не валит REST-ответ', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        liveAnalysisId: 'la-1',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        liveAnalysisId: 'la-1',
        disabledTools: ['engine'],
        liveAnalysis: { id: 'la-1', slug: 'LIVESLUG02' },
      });
      redis.publish.mockRejectedValueOnce(new Error('redis down'));
      const res = await service.update('l-1', 'u-1', {
        disabledTools: ['engine'],
      });
      expect(res.id).toBe('l-1');
      expect(redis.publish).toHaveBeenCalledTimes(1);
    });

    // ─── KS-3933 / ADR-118: visibility во всех статусах ─────────────

    it('KS-3933: visibility=restricted правится в scheduled — успех', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(scheduled);
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        visibility: 'restricted',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { visibility: 'restricted' });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ visibility: 'restricted' });
    });

    it('KS-3933: visibility правится в live — успех (расширенный гейт ADR-118)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'restricted',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { visibility: 'restricted' });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ visibility: 'restricted' });
    });

    it('KS-3933: visibility правится в recorded — успех', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'recorded',
        visibility: 'public',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { visibility: 'public' });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ visibility: 'public' });
    });

    it('KS-3933: visibility правится в cancelled — успех', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'cancelled',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'cancelled',
        visibility: 'unlisted',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { visibility: 'unlisted' });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ visibility: 'unlisted' });
    });

    it('KS-3933: совмещённый {title, visibility} в live → 400, ничего не записано', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
      });
      await expect(
        service.update('l-1', 'u-1', {
          title: 'не пройдёт',
          visibility: 'restricted',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.lecture.update).not.toHaveBeenCalled();
    });

    it('KS-3933: совмещённый {visibility, disabledTools} в live — оба поля применяются', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'restricted',
        disabledTools: ['engine'],
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', {
        visibility: 'restricted',
        disabledTools: ['engine'],
      });
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data.visibility).toBe('restricted');
      expect(args.data.disabledTools).toEqual(['engine']);
    });

    it('KS-3933: restricted → public — allowlist сохраняется (lectureAccessGrant не трогается)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        visibility: 'restricted',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        visibility: 'public',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { visibility: 'public' });
      // По ADR §2.4.1 allowlist при переключении НЕ очищается.
      // Защита: мок `prisma` не содержит модели `lectureAccessGrant`
      // вовсе. Если бы сервис попытался удалить grants — был бы
      // TypeError (Cannot read properties of undefined). Тест проходит,
      // значит обращения не было.
      const args = prisma.lecture.update.mock.calls[0][0];
      expect(args.data).toEqual({ visibility: 'public' });
    });

    // ─── KS-3942 / ADR-118 §2.5: revoke event при visibility-changed ─

    it('KS-3942: visibility public → restricted в live + binding → publishRevokeEvent (visibility-changed, [])', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'public',
        liveAnalysisId: 'la-1',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'restricted',
        liveAnalysisId: 'la-1',
        liveAnalysis: { id: 'la-1', slug: 'LIVESLG042' },
      });
      await service.update('l-1', 'u-1', { visibility: 'restricted' });
      expect(lecturesAccessMock.publishRevokeEvent).toHaveBeenCalledTimes(1);
      const payload = lecturesAccessMock.publishRevokeEvent.mock.calls[0][0];
      expect(payload).toEqual({
        lectureId: 'l-1',
        slug: 'LIVESLG042',
        revokedUserIds: [],
        reason: 'visibility-changed',
      });
    });

    it('KS-3942: visibility unlisted → restricted в live + binding → publishRevokeEvent', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'unlisted',
        liveAnalysisId: 'la-1',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'restricted',
        liveAnalysisId: 'la-1',
        liveAnalysis: { id: 'la-1', slug: 'LIVESLG043' },
      });
      await service.update('l-1', 'u-1', { visibility: 'restricted' });
      expect(lecturesAccessMock.publishRevokeEvent).toHaveBeenCalledTimes(1);
    });

    it('KS-3942: visibility restricted → public — publish НЕ вызывается (доступ только расширяется)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'restricted',
        liveAnalysisId: 'la-1',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'public',
        liveAnalysisId: 'la-1',
        liveAnalysis: { id: 'la-1', slug: 'LIVESLG044' },
      });
      await service.update('l-1', 'u-1', { visibility: 'public' });
      expect(lecturesAccessMock.publishRevokeEvent).not.toHaveBeenCalled();
    });

    it('KS-3942: visibility public → restricted в scheduled — publish НЕ вызывается (нет live комнаты)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        visibility: 'public',
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        visibility: 'restricted',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { visibility: 'restricted' });
      expect(lecturesAccessMock.publishRevokeEvent).not.toHaveBeenCalled();
    });

    it('KS-3942: visibility public → restricted в live БЕЗ liveAnalysisId — publish НЕ вызывается', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'public',
        liveAnalysisId: null,
      });
      prisma.lecture.update.mockResolvedValueOnce({
        ...scheduled,
        status: 'live',
        visibility: 'restricted',
        liveAnalysisId: null,
        liveAnalysis: null,
      });
      await service.update('l-1', 'u-1', { visibility: 'restricted' });
      expect(lecturesAccessMock.publishRevokeEvent).not.toHaveBeenCalled();
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

  // ─── KS-3864: delete + forceEnd ──────────────────────────────────

  describe('KS-3864 delete', () => {
    it('owner + status=scheduled → prisma.delete вызван, S3 best-effort cleanup', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      prisma.lecture.update.mockResolvedValueOnce({ id: 'l-1' });
      prisma.lecture.delete.mockResolvedValueOnce({ id: 'l-1' });
      await service.delete('l-1', 'u-1');
      expect(audioS3.deleteChunks).toHaveBeenCalledWith('l-1');
      expect(audioS3.deleteFinalTrack).toHaveBeenCalledWith('l-1');
      expect(prisma.lecture.delete).toHaveBeenCalledWith({
        where: { id: 'l-1' },
      });
    });

    it('owner + status=recorded → prisma.delete вызван', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'recorded',
      });
      prisma.lecture.update.mockResolvedValueOnce({ id: 'l-1' });
      prisma.lecture.delete.mockResolvedValueOnce({ id: 'l-1' });
      await service.delete('l-1', 'u-1');
      expect(prisma.lecture.delete).toHaveBeenCalled();
    });

    it('status=live → 409 ConflictException', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'live',
      });
      await expect(service.delete('l-1', 'u-1')).rejects.toMatchObject({
        status: 409,
      });
      expect(prisma.lecture.delete).not.toHaveBeenCalled();
    });

    it('не-owner → 403', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'OTHER',
        status: 'scheduled',
      });
      await expect(service.delete('l-1', 'u-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.lecture.delete).not.toHaveBeenCalled();
    });

    it('лекция не найдена → 404', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(service.delete('missing', 'u-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('S3 ошибки не блокируют удаление из БД', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: 'l-1',
        ownerId: 'u-1',
        status: 'scheduled',
      });
      audioS3.deleteChunks.mockRejectedValueOnce(new Error('s3 down'));
      audioS3.deleteFinalTrack.mockRejectedValueOnce(new Error('s3 down'));
      prisma.lecture.update.mockResolvedValueOnce({ id: 'l-1' });
      prisma.lecture.delete.mockResolvedValueOnce({ id: 'l-1' });
      await service.delete('l-1', 'u-1');
      expect(prisma.lecture.delete).toHaveBeenCalled();
    });
  });

  describe('KS-3864 forceEnd', () => {
    function liveLecture(extra: Record<string, unknown> = {}) {
      return {
        id: 'l-1',
        ownerId: 'u-1',
        status: 'live' as const,
        startedAt: new Date(Date.now() - 60_000),
        liveAnalysisId: 'la-1',
        ...extra,
      };
    }

    it('live → recorded + endedAt + durationMs; closeBySlug вызван; finalize ok', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(liveLecture());
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({ slug: 'SLUG' });
      prisma.lecture.update.mockResolvedValueOnce({
        id: 'l-1',
        status: 'recorded',
        endedAt: new Date(),
        durationMs: 60_000,
        liveAnalysis: { id: 'la-1', slug: 'SLUG' },
      });
      const r = await service.forceEnd('l-1', 'u-1');
      expect(liveAnalysis.closeBySlug).toHaveBeenCalledWith(
        'SLUG',
        'u-1',
        'by_owner',
      );
      expect(audioService.finalizeRecording).toHaveBeenCalledWith(
        'l-1',
        {},
        { actingUserId: 'u-1' },
      );
      expect(r.status).toBe('recorded');
      // durationMs пересчитан (положительный).
      const updateArg = prisma.lecture.update.mock.calls[0][0];
      expect(updateArg.data.status).toBe('recorded');
      expect(updateArg.data.endedAt).toBeInstanceOf(Date);
      expect(updateArg.data.durationMs).toBeGreaterThan(0);
    });

    it('live → recorded даже если closeBySlug упал (логируем, не пробрасываем)', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(liveLecture());
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({ slug: 'SLUG' });
      liveAnalysis.closeBySlug.mockRejectedValueOnce(new Error('redis down'));
      prisma.lecture.update.mockResolvedValueOnce({
        id: 'l-1',
        status: 'recorded',
        liveAnalysis: null,
      });
      const r = await service.forceEnd('l-1', 'u-1');
      expect(r.status).toBe('recorded');
    });

    it('NoChunksError из finalize не блокирует ответ', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(liveLecture());
      prisma.liveAnalysis.findUnique.mockResolvedValueOnce({ slug: 'SLUG' });
      prisma.lecture.update.mockResolvedValueOnce({
        id: 'l-1',
        status: 'recorded',
        liveAnalysis: { id: 'la-1', slug: 'SLUG' },
      });
      audioService.finalizeRecording.mockRejectedValueOnce(
        new NoChunksError('l-1'),
      );
      const r = await service.forceEnd('l-1', 'u-1');
      expect(r.status).toBe('recorded');
    });

    it('лекция без liveAnalysisId — closeBySlug не вызывается', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(
        liveLecture({ liveAnalysisId: null }),
      );
      prisma.lecture.update.mockResolvedValueOnce({
        id: 'l-1',
        status: 'recorded',
        liveAnalysis: null,
      });
      await service.forceEnd('l-1', 'u-1');
      expect(liveAnalysis.closeBySlug).not.toHaveBeenCalled();
    });

    it('не-owner → 403', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(
        liveLecture({ ownerId: 'OTHER' }),
      );
      await expect(service.forceEnd('l-1', 'u-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('не-live (scheduled / recorded / cancelled) → 409', async () => {
      for (const status of ['scheduled', 'recorded', 'cancelled'] as const) {
        prisma.lecture.findUnique.mockResolvedValueOnce(
          liveLecture({ status }),
        );
        await expect(service.forceEnd('l-1', 'u-1')).rejects.toMatchObject({
          status: 409,
        });
      }
    });

    it('404 если лекции нет', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.forceEnd('missing', 'u-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
