/**
 * KS-3830 / ADR-116 §5.1. Unit-тесты `LectureAudioService`.
 *
 * S3, ffmpeg и Prisma — моки. Финализация проверяется по контракту
 * (последовательность вызовов и аргументы), без реального запуска
 * ffmpeg/Prisma.
 */
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { LectureAudioService } from './lecture-audio.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { LectureAudioS3Service } from './lecture-audio-s3.service';
import type { FfmpegConcatService } from './ffmpeg-concat.service';

const LECTURE = '11111111-2222-3333-4444-555555555555';
const OWNER = 'u-owner';

function makePrisma() {
  return {
    lecture: { findUnique: jest.fn() },
    lectureAudio: { findUnique: jest.fn(), upsert: jest.fn() },
    lectureAudioChunk: { upsert: jest.fn(), findMany: jest.fn() },
  };
}

function makeS3() {
  return {
    presignChunkUpload: jest.fn(),
    listChunks: jest.fn(),
    deleteChunks: jest.fn(),
    putFinalTrack: jest.fn(),
    downloadObject: jest.fn(),
    signedCloudFrontUrl: jest.fn(),
  };
}

function makeFfmpeg() {
  // runWithOutput вызывает callback с фейковым outPath/durationMs.
  // Сервис сам делает PUT и UPSERT внутри callback — тест проверит
  // что эти эффекты случились.
  return {
    runWithOutput: jest.fn(
      async <T>(
        _paths: string[],
        cb: (o: { localPath: string; durationMs: number }) => Promise<T>,
      ) => cb({ localPath: '/tmp/out.ogg', durationMs: 3_600_000 }),
    ),
  };
}

describe('LectureAudioService (KS-3830)', () => {
  let svc: LectureAudioService;
  let prisma: ReturnType<typeof makePrisma>;
  let s3: ReturnType<typeof makeS3>;
  let ffmpeg: ReturnType<typeof makeFfmpeg>;

  beforeEach(() => {
    prisma = makePrisma();
    s3 = makeS3();
    ffmpeg = makeFfmpeg();
    svc = new LectureAudioService(
      prisma as unknown as PrismaService,
      s3 as unknown as LectureAudioS3Service,
      ffmpeg as unknown as FfmpegConcatService,
    );
  });

  describe('issueChunkUploadUrl', () => {
    it('возвращает presigned URL + chunkKey audio/<id>/chunks/<seq>.webm', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: new Date(),
      });
      s3.presignChunkUpload.mockResolvedValueOnce(
        'https://kingside-lectures.s3.eu-central-1.amazonaws.com/audio/L/chunks/0.webm?X-Amz-Signature=AB',
      );
      const res = await svc.issueChunkUploadUrl(LECTURE, OWNER, 0, 120_000);
      expect(res.chunkKey).toBe(`audio/${LECTURE}/chunks/0.webm`);
      expect(res.uploadUrl).toContain('X-Amz-Signature=');
      // TTL по умолчанию 300 секунд.
      expect(s3.presignChunkUpload).toHaveBeenCalledWith(
        LECTURE,
        0,
        120_000,
        300,
      );
    });

    it('404 если лекции нет', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce(null);
      await expect(
        svc.issueChunkUploadUrl(LECTURE, OWNER, 0, 1),
      ).rejects.toThrow(NotFoundException);
    });

    it('403 если не владелец', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: 'OTHER',
        startedAt: null,
      });
      await expect(
        svc.issueChunkUploadUrl(LECTURE, OWNER, 0, 1),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('ackChunk', () => {
    it('UPSERT по (lectureId, seq), storageKey генерится из seq', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: null,
      });
      prisma.lectureAudioChunk.upsert.mockResolvedValueOnce({ id: 'x' });
      const r = await svc.ackChunk(LECTURE, OWNER, {
        seq: 7,
        etag: 'abc123',
        sizeBytes: 50_000,
        clientCreatedAt: '2026-06-07T10:00:00.000Z',
      });
      expect(r.ok).toBe(true);
      const call = prisma.lectureAudioChunk.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        lectureId_seq: { lectureId: LECTURE, seq: 7 },
      });
      expect(call.create).toEqual(
        expect.objectContaining({
          lectureId: LECTURE,
          seq: 7,
          storageKey: `audio/${LECTURE}/chunks/7.webm`,
          etag: 'abc123',
          sizeBytes: 50_000,
        }),
      );
      expect(call.update.etag).toBe('abc123');
    });

    it('403 если не владелец', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: 'OTHER',
        startedAt: null,
      });
      await expect(
        svc.ackChunk(LECTURE, OWNER, {
          seq: 0,
          etag: 'x',
          sizeBytes: 1,
          clientCreatedAt: '2026-06-07T10:00:00Z',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('finalizeRecording', () => {
    it('идемпотентен: при существующей LectureAudio возвращает её без вызова ffmpeg', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: new Date('2026-06-07T10:00:00Z'),
      });
      prisma.lectureAudio.findUnique.mockResolvedValueOnce({
        lectureId: LECTURE,
        durationMs: 1000,
        offsetMs: 200,
      });
      const r = await svc.finalizeRecording(
        LECTURE,
        {},
        { actingUserId: OWNER },
      );
      expect(r).toEqual({
        lectureId: LECTURE,
        durationMs: 1000,
        offsetMs: 200,
      });
      expect(ffmpeg.runWithOutput).not.toHaveBeenCalled();
      expect(s3.putFinalTrack).not.toHaveBeenCalled();
    });

    it('KS-3838: нет чанков в S3 → throw NoChunksError', async () => {
      const { NoChunksError } = await import('./lecture-audio.service');
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: new Date(),
      });
      prisma.lectureAudio.findUnique.mockResolvedValueOnce(null);
      s3.listChunks.mockResolvedValueOnce([]);
      await expect(
        svc.finalizeRecording(LECTURE, {}, { actingUserId: OWNER }),
      ).rejects.toBeInstanceOf(NoChunksError);
      expect(ffmpeg.runWithOutput).not.toHaveBeenCalled();
    });

    it('полный путь: download → ffmpeg → putFinalTrack → upsert → delete', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: new Date('2026-06-07T10:00:00Z'),
      });
      prisma.lectureAudio.findUnique.mockResolvedValueOnce(null);
      s3.listChunks.mockResolvedValueOnce([
        { seq: 0, key: `audio/${LECTURE}/chunks/0.webm`, etag: 'e0', sizeBytes: 100 },
        { seq: 1, key: `audio/${LECTURE}/chunks/1.webm`, etag: 'e1', sizeBytes: 200 },
      ]);
      prisma.lectureAudioChunk.findMany.mockResolvedValueOnce([
        {
          clientCreatedAt: new Date('2026-06-07T10:00:01.500Z'),
          createdAt: new Date('2026-06-07T10:00:02Z'),
          seq: 0,
        },
        {
          clientCreatedAt: new Date('2026-06-07T10:00:05.000Z'),
          createdAt: new Date('2026-06-07T10:00:06Z'),
          seq: 1,
        },
      ]);
      prisma.lectureAudio.upsert.mockResolvedValueOnce({
        lectureId: LECTURE,
        durationMs: 3_600_000,
        offsetMs: 1500,
      });
      s3.deleteChunks.mockResolvedValueOnce(2);

      const r = await svc.finalizeRecording(
        LECTURE,
        { chunkCount: 2 },
        { actingUserId: OWNER },
      );

      expect(s3.downloadObject).toHaveBeenCalledTimes(2);
      expect(ffmpeg.runWithOutput).toHaveBeenCalledTimes(1);
      expect(s3.putFinalTrack).toHaveBeenCalledWith(LECTURE, '/tmp/out.ogg');
      // offsetMs = recorderStartedAtClient(=1500ms после startedAt) - startedAt = 1500.
      const upsertArg = prisma.lectureAudio.upsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({ lectureId: LECTURE });
      expect(upsertArg.create).toEqual(
        expect.objectContaining({
          lectureId: LECTURE,
          storageKey: `audio/${LECTURE}/track.ogg`,
          codec: 'opus',
          container: 'ogg',
          durationMs: 3_600_000,
          offsetMs: 1500,
        }),
      );
      expect(s3.deleteChunks).toHaveBeenCalledWith(LECTURE);
      expect(r).toEqual({
        lectureId: LECTURE,
        durationMs: 3_600_000,
        offsetMs: 1500,
      });
    });

    it('offsetMs берётся из payload, если передан клиентом', async () => {
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: new Date('2026-06-07T10:00:00Z'),
      });
      prisma.lectureAudio.findUnique.mockResolvedValueOnce(null);
      s3.listChunks.mockResolvedValueOnce([
        { seq: 0, key: `audio/${LECTURE}/chunks/0.webm`, etag: 'e', sizeBytes: 1 },
      ]);
      prisma.lectureAudioChunk.findMany.mockResolvedValueOnce([]);
      prisma.lectureAudio.upsert.mockResolvedValueOnce({
        lectureId: LECTURE,
        durationMs: 3_600_000,
        offsetMs: 4242,
      });
      s3.deleteChunks.mockResolvedValueOnce(1);
      await svc.finalizeRecording(
        LECTURE,
        { offsetMs: 4242, recorderStartedAtClient: '2026-06-07T10:00:04.242Z' },
        { actingUserId: OWNER },
      );
      const upsertArg = prisma.lectureAudio.upsert.mock.calls[0][0];
      expect(upsertArg.create.offsetMs).toBe(4242);
    });

    it('без actingUserId (вызов из cron) — owner-check пропускается', async () => {
      const { NoChunksError } = await import('./lecture-audio.service');
      prisma.lecture.findUnique.mockResolvedValueOnce({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: new Date(),
      });
      prisma.lectureAudio.findUnique.mockResolvedValueOnce(null);
      s3.listChunks.mockResolvedValueOnce([]);
      // Без чанков всё равно throw — а Forbidden НЕ кидается:
      // owner-check пропущен (actingUserId undefined).
      await expect(svc.finalizeRecording(LECTURE, {})).rejects.toBeInstanceOf(
        NoChunksError,
      );
    });

    // KS-3838: дополнительные доменные кейсы.
    it('chunk-url повторный вызов с тем же seq идемпотентен (только новый presign, БД не трогается)', async () => {
      prisma.lecture.findUnique.mockResolvedValue({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: null,
      });
      s3.presignChunkUpload
        .mockResolvedValueOnce(
          'https://kingside-lectures.s3.eu-central-1.amazonaws.com/audio/L/chunks/0.webm?X-Amz-Signature=A1',
        )
        .mockResolvedValueOnce(
          'https://kingside-lectures.s3.eu-central-1.amazonaws.com/audio/L/chunks/0.webm?X-Amz-Signature=A2',
        );
      const r1 = await svc.issueChunkUploadUrl(LECTURE, OWNER, 0, 1000);
      const r2 = await svc.issueChunkUploadUrl(LECTURE, OWNER, 0, 1000);
      expect(r1.chunkKey).toBe(r2.chunkKey);
      // Подпись свежая (другая) — TTL обновляется на каждом запросе.
      expect(r1.uploadUrl).not.toBe(r2.uploadUrl);
      expect(s3.presignChunkUpload).toHaveBeenCalledTimes(2);
      // Идемпотентен по БД — никаких побочных вставок.
      expect(prisma.lectureAudioChunk.upsert).not.toHaveBeenCalled();
    });

    it('ackChunk: повторный вызов с тем же seq UPSERT-ит ту же строку (одна и та же composite-key)', async () => {
      prisma.lecture.findUnique.mockResolvedValue({
        id: LECTURE,
        ownerId: OWNER,
        startedAt: null,
      });
      prisma.lectureAudioChunk.upsert.mockResolvedValue({ id: 'x' });
      await svc.ackChunk(LECTURE, OWNER, {
        seq: 3,
        etag: 'e1',
        sizeBytes: 100,
        clientCreatedAt: '2026-06-07T10:00:00Z',
      });
      await svc.ackChunk(LECTURE, OWNER, {
        seq: 3,
        etag: 'e2-after-retry',
        sizeBytes: 120,
        clientCreatedAt: '2026-06-07T10:00:05Z',
      });
      expect(prisma.lectureAudioChunk.upsert).toHaveBeenCalledTimes(2);
      const k1 = prisma.lectureAudioChunk.upsert.mock.calls[0][0].where;
      const k2 = prisma.lectureAudioChunk.upsert.mock.calls[1][0].where;
      // Композитный ключ один и тот же — UNIQUE-нарушения не будет,
      // в БД останется одна строка.
      expect(k1).toEqual(k2);
      // Второй вызов обновляет etag/sizeBytes.
      const updateArg2 = prisma.lectureAudioChunk.upsert.mock.calls[1][0]
        .update;
      expect(updateArg2.etag).toBe('e2-after-retry');
      expect(updateArg2.sizeBytes).toBe(120);
    });
  });
});
