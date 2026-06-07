/**
 * KS-3833 / ADR-116 §2.4.3. Unit-тесты cron-восстановителя
 * `LectureAudioFinalizerScheduler`. Сам cron не запускаем — вызываем
 * `runOnce()` напрямую. Prisma и зависимые сервисы — моки.
 */
import { LectureAudioFinalizerScheduler } from './lecture-audio-finalizer.scheduler';
import type { PrismaService } from '../prisma/prisma.service';
import type { LectureAudioS3Service } from './lecture-audio-s3.service';
import type { LectureAudioService } from './lecture-audio.service';

function makeScheduler() {
  const prisma = {
    lecture: { findMany: jest.fn() },
  };
  const s3 = {
    listChunks: jest.fn(),
  };
  const audio = {
    finalizeRecording: jest.fn(),
  };
  const scheduler = new LectureAudioFinalizerScheduler(
    prisma as unknown as PrismaService,
    s3 as unknown as LectureAudioS3Service,
    audio as unknown as LectureAudioService,
  );
  return { scheduler, prisma, s3, audio };
}

describe('LectureAudioFinalizerScheduler (KS-3833)', () => {
  it('WHERE status=recorded + audio is null + take=50', async () => {
    const { scheduler, prisma } = makeScheduler();
    prisma.lecture.findMany.mockResolvedValueOnce([]);
    await scheduler.runOnce();
    const arg = prisma.lecture.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      status: 'recorded',
      audio: { is: null },
    });
    expect(arg.take).toBe(50);
  });

  it('для каждой лекции с чанками вызывает finalizeRecording', async () => {
    const { scheduler, prisma, s3, audio } = makeScheduler();
    prisma.lecture.findMany.mockResolvedValueOnce([
      { id: 'L1', startedAt: new Date() },
      { id: 'L2', startedAt: new Date() },
    ]);
    s3.listChunks
      .mockResolvedValueOnce([
        { seq: 0, key: 'audio/L1/chunks/0.webm', etag: 'e', sizeBytes: 1 },
      ])
      .mockResolvedValueOnce([
        { seq: 0, key: 'audio/L2/chunks/0.webm', etag: 'e', sizeBytes: 1 },
      ]);
    audio.finalizeRecording
      .mockResolvedValueOnce({ lectureId: 'L1', durationMs: 1000, offsetMs: 0 })
      .mockResolvedValueOnce({ lectureId: 'L2', durationMs: 2000, offsetMs: 0 });
    const r = await scheduler.runOnce();
    expect(r.scanned).toBe(2);
    expect(r.finalized).toBe(2);
    expect(audio.finalizeRecording).toHaveBeenNthCalledWith(1, 'L1', {});
    expect(audio.finalizeRecording).toHaveBeenNthCalledWith(2, 'L2', {});
  });

  it('лекция без чанков → skippedNoChunks, finalizeRecording не вызывается', async () => {
    const { scheduler, prisma, s3, audio } = makeScheduler();
    prisma.lecture.findMany.mockResolvedValueOnce([
      { id: 'L1', startedAt: new Date() },
    ]);
    s3.listChunks.mockResolvedValueOnce([]);
    const r = await scheduler.runOnce();
    expect(r.skippedNoChunks).toBe(1);
    expect(r.finalized).toBe(0);
    expect(audio.finalizeRecording).not.toHaveBeenCalled();
  });

  it('ошибка финализации одной лекции не блокирует следующие', async () => {
    const { scheduler, prisma, s3, audio } = makeScheduler();
    prisma.lecture.findMany.mockResolvedValueOnce([
      { id: 'L1', startedAt: new Date() },
      { id: 'L2', startedAt: new Date() },
    ]);
    s3.listChunks
      .mockResolvedValueOnce([
        { seq: 0, key: 'audio/L1/chunks/0.webm', etag: 'e', sizeBytes: 1 },
      ])
      .mockResolvedValueOnce([
        { seq: 0, key: 'audio/L2/chunks/0.webm', etag: 'e', sizeBytes: 1 },
      ]);
    audio.finalizeRecording
      .mockRejectedValueOnce(new Error('ffmpeg crashed'))
      .mockResolvedValueOnce({ lectureId: 'L2', durationMs: 1000, offsetMs: 0 });
    const r = await scheduler.runOnce();
    expect(r.failed).toBe(1);
    expect(r.finalized).toBe(1);
  });

  it('handleTick защищён от перекрытия запусков', async () => {
    const { scheduler, prisma } = makeScheduler();
    let resolve!: (rows: unknown[]) => void;
    prisma.lecture.findMany.mockImplementationOnce(
      () => new Promise((r) => (resolve = r as (rows: unknown[]) => void)),
    );
    const p1 = scheduler.handleTick();
    const p2 = scheduler.handleTick();
    // второй вызов должен сразу вернуться (running=true)
    await p2;
    expect(prisma.lecture.findMany).toHaveBeenCalledTimes(1);
    resolve([]);
    await p1;
  });
});
