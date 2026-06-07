/**
 * KS-3775 регрессия: handleStatePatch обязан передавать ВСЕ поля
 * StatePatchPayloadDto в сервис, иначе новые опциональные поля
 * (currentGlobalIndex) теряются на уровне gateway.
 *
 * Здесь чисто unit-тест маппинга обработчика — без поднятия socket.io
 * и Redis. Конструируем gateway вручную и вызываем handler напрямую.
 */
import { LiveAnalysisGateway } from './live-analysis.gateway';
import { LiveAnalysisService } from './live-analysis.service';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import { StatePatchPayloadDto } from './dto/ws-payload.dto';
import type { PrismaService } from '../prisma/prisma.service';

describe('LiveAnalysisGateway.handleStatePatch (KS-3775)', () => {
  let gateway: LiveAnalysisGateway;
  let service: { applyStatePatch: jest.Mock };

  beforeEach(() => {
    service = { applyStatePatch: jest.fn().mockResolvedValue(undefined) };
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      service as unknown as LiveAnalysisService,
      {} as ConfigService,
      {} as PrismaService,
    );
  });

  function makeClient(user: { id: string; username: string } | null): Socket {
    return {
      data: { user },
      emit: jest.fn(),
    } as unknown as Socket;
  }

  it('передаёт currentGlobalIndex в service.applyStatePatch', async () => {
    const client = makeClient({ id: 'u-1', username: 'alice' });
    const payload: StatePatchPayloadDto = Object.assign(
      new StatePatchPayloadDto(),
      {
        slug: 'faxRe7ajRY',
        tree: '{"history":[]}',
        orientation: 'white' as const,
        currentGlobalIndex: 42,
      },
    );

    await gateway.handleStatePatch(client, payload);

    expect(service.applyStatePatch).toHaveBeenCalledTimes(1);
    const [slug, ownerId, params] = service.applyStatePatch.mock.calls[0];
    expect(slug).toBe('faxRe7ajRY');
    expect(ownerId).toBe('u-1');
    expect(params).toEqual(
      expect.objectContaining({
        tree: '{"history":[]}',
        orientation: 'white',
        currentGlobalIndex: 42,
      }),
    );
  });

  it('без currentGlobalIndex в payload — поле передаётся undefined (fallback на старое поведение)', async () => {
    const client = makeClient({ id: 'u-1', username: 'alice' });
    const payload: StatePatchPayloadDto = Object.assign(
      new StatePatchPayloadDto(),
      { slug: 'faxRe7ajRY', tree: '{"history":[]}' },
    );

    await gateway.handleStatePatch(client, payload);

    const params = service.applyStatePatch.mock.calls[0][2];
    expect(params.currentGlobalIndex).toBeUndefined();
  });

  it('без авторизации в client.data.user не вызывает service', async () => {
    const client = makeClient(null);
    const payload: StatePatchPayloadDto = Object.assign(
      new StatePatchPayloadDto(),
      { slug: 'x', tree: '{}', currentGlobalIndex: 5 },
    );

    await gateway.handleStatePatch(client, payload);
    expect(service.applyStatePatch).not.toHaveBeenCalled();
    expect((client.emit as jest.Mock)).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KS-3836 / ADR-116 §2.2. WebRTC-сигналинг: capacity, ownership,
// forward, disconnect. Все тесты — чистый unit без подъёма socket.io;
// гейтвей конструируется вручную, server / sockets мокается.
// ─────────────────────────────────────────────────────────────────────

describe('LiveAnalysisGateway WebRTC signaling (KS-3836)', () => {
  const LECTURE = '00000000-0000-0000-0000-000000000111';
  let gateway: LiveAnalysisGateway;
  let prisma: { lecture: { findUnique: jest.Mock } };
  const socketRegistry = new Map<string, { id: string; emit: jest.Mock }>();

  function makeServer(): {
    sockets: { sockets: Map<string, { id: string; emit: jest.Mock }> };
  } {
    return { sockets: { sockets: socketRegistry } };
  }

  function makeClient(
    id: string,
    user: { id: string; username: string } | null,
  ): any {
    const emit = jest.fn();
    const c = {
      id,
      data: {
        user,
        subscribedSlugs: new Set(),
        webrtcLectures: new Set<string>(),
        webrtcOwnedLectures: new Set<string>(),
      },
      emit,
    };
    socketRegistry.set(id, { id, emit });
    return c;
  }

  beforeEach(() => {
    socketRegistry.clear();
    prisma = {
      lecture: { findUnique: jest.fn() },
    };
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      {} as LiveAnalysisService,
      {} as ConfigService,
      prisma as unknown as PrismaService,
    );
    (gateway as any).server = makeServer();
  });

  it('peer-joined от владельца: ставит ownerSocketId и не считает в capacity', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.ownerSocketId).toBe('S_OWNER');
    expect(peers.subscribers.size).toBe(0);
    expect(owner.data.webrtcOwnedLectures.has(LECTURE)).toBe(true);
  });

  it('peer-joined от подписчика: регистрирует, уведомляет владельца', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });

    const sub = makeClient('S_SUB', { id: 'u-sub', username: 's' });
    (owner.emit as jest.Mock).mockClear();
    await gateway.handleWebRTCPeerJoined(sub, { lectureId: LECTURE });

    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.subscribers.has('S_SUB')).toBe(true);
    // owner получил уведомление peer-joined
    expect((owner.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-joined',
      expect.objectContaining({ lectureId: LECTURE, fromSocketId: 'S_SUB' }),
    );
  });

  it('16-й подписчик получает capacity-exceeded и не добавляется', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });

    // 15 подписчиков влезают
    for (let i = 0; i < 15; i++) {
      const c = makeClient(`S_${i}`, { id: `u-${i}`, username: `u${i}` });
      await gateway.handleWebRTCPeerJoined(c, { lectureId: LECTURE });
    }
    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.subscribers.size).toBe(15);

    // 16-й — capacity-exceeded
    const overflow = makeClient('S_16', { id: 'u-16', username: 'u16' });
    await gateway.handleWebRTCPeerJoined(overflow, { lectureId: LECTURE });
    expect((overflow.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:capacity-exceeded',
      { lectureId: LECTURE, currentSubscribers: 15, max: 15 },
    );
    expect(peers.subscribers.has('S_16')).toBe(false);
  });

  it('peer-joined без user (анонимный) → forbidden, не регистрируется', async () => {
    const anon = makeClient('S_ANON', null);
    await gateway.handleWebRTCPeerJoined(anon, { lectureId: LECTURE });
    expect((anon.emit as jest.Mock)).toHaveBeenCalledWith(
      'live-analysis:error',
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect((gateway as any).webrtcPeers.has(LECTURE)).toBe(false);
  });

  it('peer-joined для несуществующей лекции → slug-not-found', async () => {
    prisma.lecture.findUnique.mockResolvedValue(null);
    const c = makeClient('S_X', { id: 'u-x', username: 'x' });
    await gateway.handleWebRTCPeerJoined(c, { lectureId: LECTURE });
    expect((c.emit as jest.Mock)).toHaveBeenCalledWith(
      'live-analysis:error',
      expect.objectContaining({ code: 'slug-not-found' }),
    );
  });

  it('offer от не-владельца отбрасывается', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    const sub = makeClient('S_SUB', { id: 'u-sub', username: 's' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    await gateway.handleWebRTCPeerJoined(sub, { lectureId: LECTURE });

    // Левый клиент X пытается слать offer
    const x = makeClient('S_X', { id: 'u-x', username: 'x' });
    gateway.handleWebRTCOffer(x, {
      lectureId: LECTURE,
      toSocketId: 'S_SUB',
      sdp: 'fake',
    });
    expect((sub.emit as jest.Mock)).not.toHaveBeenCalledWith(
      'webrtc:offer',
      expect.anything(),
    );
  });

  it('offer от владельца → подписчик получает offer с fromSocketId', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    const sub = makeClient('S_SUB', { id: 'u-sub', username: 's' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    await gateway.handleWebRTCPeerJoined(sub, { lectureId: LECTURE });

    (sub.emit as jest.Mock).mockClear();
    gateway.handleWebRTCOffer(owner, {
      lectureId: LECTURE,
      toSocketId: 'S_SUB',
      sdp: 'v=0...',
    });
    expect((sub.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:offer',
      expect.objectContaining({
        lectureId: LECTURE,
        toSocketId: 'S_SUB',
        fromSocketId: 'S_OWNER',
        sdp: 'v=0...',
      }),
    );
  });

  it('answer: subscriber → publisher, не дойдёт если pair не зарегистрирован', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    const sub = makeClient('S_SUB', { id: 'u-sub', username: 's' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    await gateway.handleWebRTCPeerJoined(sub, { lectureId: LECTURE });

    (owner.emit as jest.Mock).mockClear();
    gateway.handleWebRTCAnswer(sub, {
      lectureId: LECTURE,
      toSocketId: 'S_OWNER',
      sdp: 'v=0...',
    });
    expect((owner.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:answer',
      expect.objectContaining({ fromSocketId: 'S_SUB' }),
    );

    // Незарегистрированный sender — answer отбрасывается
    const stranger = makeClient('S_STRANGER', { id: 'u-z', username: 'z' });
    (owner.emit as jest.Mock).mockClear();
    gateway.handleWebRTCAnswer(stranger, {
      lectureId: LECTURE,
      toSocketId: 'S_OWNER',
      sdp: 'v=0',
    });
    expect((owner.emit as jest.Mock)).not.toHaveBeenCalled();
  });

  it('disconnect: удаляет socket из peer-list и шлёт peer-left оставшимся', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    const sub1 = makeClient('S_S1', { id: 'u-s1', username: 's1' });
    const sub2 = makeClient('S_S2', { id: 'u-s2', username: 's2' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    await gateway.handleWebRTCPeerJoined(sub1, { lectureId: LECTURE });
    await gateway.handleWebRTCPeerJoined(sub2, { lectureId: LECTURE });

    (owner.emit as jest.Mock).mockClear();
    (sub2.emit as jest.Mock).mockClear();
    // Имитация disconnect sub1
    (gateway as any).handleDisconnect(sub1);
    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.subscribers.has('S_S1')).toBe(false);
    expect((owner.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-left',
      expect.objectContaining({ fromSocketId: 'S_S1' }),
    );
    expect((sub2.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-left',
      expect.objectContaining({ fromSocketId: 'S_S1' }),
    );
  });
});
