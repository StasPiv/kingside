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
