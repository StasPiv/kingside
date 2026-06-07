/**
 * KS-3837 / ADR-116 §6.2. Unit-тесты endpoint'а
 * `POST /lecture-audio/peer-failed` — метрика провальных WebRTC.
 * Контроллер тонкий, единственная видимая операция — структурированный
 * warn-лог. Проверяем форму payload'а и заполнение userId/anon.
 */
import { Logger } from '@nestjs/common';
import { LectureAudioController } from './lecture-audio.controller';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import type { PeerFailedDto } from './dto/peer-failed.dto';

describe('LectureAudioController.reportPeerFailed (KS-3837)', () => {
  let controller: LectureAudioController;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    controller = new LectureAudioController(
      // Сервис не задействован в peer-failed; передаём заглушку.
      {} as unknown as import('./lecture-audio.service').LectureAudioService,
    );
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeReq(
    user: { id: string; username: string } | undefined,
  ): AuthenticatedRequest {
    return { user } as AuthenticatedRequest;
  }

  const baseDto: PeerFailedDto = {
    lectureId: '11111111-2222-3333-4444-555555555555',
    reason: 'ice_failed',
    role: 'subscriber',
    iceConnectionState: 'failed',
  };

  it('пишет структурированный JSON в Logger.warn (анонимный)', () => {
    controller.reportPeerFailed(makeReq(undefined), baseDto);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const arg = warnSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed).toEqual({
      event: 'webrtc.peer_failed',
      lectureId: baseDto.lectureId,
      reason: 'ice_failed',
      role: 'subscriber',
      iceConnectionState: 'failed',
      userId: 'anon',
    });
  });

  it('пишет userId из JWT, если есть', () => {
    controller.reportPeerFailed(
      makeReq({ id: 'u-1', username: 'alice' }),
      baseDto,
    );
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.userId).toBe('u-1');
  });

  it('role=publisher логируется как есть', () => {
    controller.reportPeerFailed(makeReq(undefined), {
      ...baseDto,
      role: 'publisher',
    });
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.role).toBe('publisher');
  });

  it('возвращает undefined (HttpCode 204)', () => {
    const result = controller.reportPeerFailed(makeReq(undefined), baseDto);
    expect(result).toBeUndefined();
  });
});

// KS-3838: unit-тесты остальных handler'ов контроллера (chunk-url,
// chunk-ack, end). Сервис подменён моком — проверяем только мэппинг
// аргументов и обработку NoChunksError.
describe('LectureAudioController handlers (KS-3838)', () => {
  const LECTURE = '11111111-2222-3333-4444-555555555555';
  let controller: LectureAudioController;
  let service: {
    issueChunkUploadUrl: jest.Mock;
    ackChunk: jest.Mock;
    finalizeRecording: jest.Mock;
  };

  beforeEach(() => {
    service = {
      issueChunkUploadUrl: jest.fn(),
      ackChunk: jest.fn(),
      finalizeRecording: jest.fn(),
    };
    controller = new LectureAudioController(
      service as unknown as import('./lecture-audio.service').LectureAudioService,
    );
  });

  function reqAs(userId: string) {
    return {
      user: { id: userId, username: 'u' },
    } as unknown as import('../common/authenticated-request').AuthenticatedRequest;
  }

  it('chunk-url пробрасывает userId, seq, sizeBytes в сервис', async () => {
    service.issueChunkUploadUrl.mockResolvedValue({
      uploadUrl: 'u',
      chunkKey: `audio/${LECTURE}/chunks/3.webm`,
    });
    const r = await controller.chunkUrl(reqAs('u-1'), LECTURE, {
      seq: 3,
      sizeBytes: 1234,
    });
    expect(service.issueChunkUploadUrl).toHaveBeenCalledWith(
      LECTURE,
      'u-1',
      3,
      1234,
    );
    expect(r.chunkKey).toContain('/chunks/3.webm');
  });

  it('chunk-ack пробрасывает payload в сервис', async () => {
    service.ackChunk.mockResolvedValue({ ok: true });
    const dto = {
      seq: 5,
      etag: 'e',
      sizeBytes: 100,
      clientCreatedAt: '2026-06-07T10:00:00Z',
    };
    const r = await controller.chunkAck(reqAs('u-1'), LECTURE, dto);
    expect(service.ackChunk).toHaveBeenCalledWith(LECTURE, 'u-1', dto);
    expect(r).toEqual({ ok: true });
  });

  it('end передаёт actingUserId и возвращает { audio }', async () => {
    service.finalizeRecording.mockResolvedValue({
      lectureId: LECTURE,
      durationMs: 1000,
      offsetMs: 0,
    });
    const r = await controller.end(reqAs('u-1'), LECTURE, { offsetMs: 0 });
    expect(service.finalizeRecording).toHaveBeenCalledWith(
      LECTURE,
      { offsetMs: 0 },
      { actingUserId: 'u-1' },
    );
    expect(r.audio.lectureId).toBe(LECTURE);
  });

  it('end мапит NoChunksError → UnprocessableEntityException (422)', async () => {
    const {
      NoChunksError,
    } = await import('./lecture-audio.service');
    service.finalizeRecording.mockRejectedValue(new NoChunksError(LECTURE));
    await expect(
      controller.end(reqAs('u-1'), LECTURE, {}),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('end пробрасывает другие ошибки без преобразования', async () => {
    service.finalizeRecording.mockRejectedValue(new Error('boom'));
    await expect(
      controller.end(reqAs('u-1'), LECTURE, {}),
    ).rejects.toThrow(/boom/);
  });
});
