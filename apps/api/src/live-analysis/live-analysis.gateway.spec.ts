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
      {} as never,
      {} as never,
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

  // KS-3889 окончательный фикс: сервис теперь шлёт через
  // `this.server.to(socketId).emit(event, payload)`. В Socket.IO 4.x
  // это broadcast operator на room со socketId. В тестах эмулируем:
  // `to(id)` возвращает объект с `.emit(event, payload)`, который
  // пишет в `emit` мок-сокета из socketRegistry. Если такого сокета
  // нет — emit no-op.
  function makeServer(): {
    to: (id: string) => { emit: (event: string, payload: unknown) => void };
  } {
    return {
      to: (id: string) => ({
        emit: (event: string, payload: unknown): void => {
          const s = socketRegistry.get(id);
          if (s) s.emit(event, payload);
        },
      }),
    };
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
      {} as never,
      {} as never,
    );
    (gateway as any).server = makeServer();
    // KS-3889 финал: доставка идёт через `webrtcNs.to(id).emit()` —
    // подкладываем тот же эмулятор, чтобы тесты ловили emit'ы.
    (gateway as any).webrtcNs = makeServer();
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

  // KS-3889: handler приходит до завершения async handleConnection —
  // `client.data.user` ещё undefined. Handler должен сам поднять JWT
  // из handshake.auth.token и корректно определить владельца.
  it('KS-3889: late auth resolve — JWT в handshake, client.data.user не выставлен → handler сам поднимает и считает owner', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    // JwtService мок: верифицирует и отдаёт payload.
    const verify = jest.fn().mockReturnValue({
      sub: 'u-owner',
      username: 'trainer',
    });
    (gateway as unknown as { jwtService: { verify: jest.Mock } }).jwtService = {
      verify,
    };
    // Симулируем гонку: данные сокета без `user` (handleConnection не
    // успел), но в handshake.auth.token есть JWT.
    const emit = jest.fn();
    const owner = {
      id: 'S_OWNER',
      data: {
        // user НЕ выставлен — handleConnection ещё на async-стадии
        subscribedSlugs: new Set(),
        // webrtcLectures / webrtcOwnedLectures тоже отсутствуют —
        // handler должен их инициализировать сам
      },
      handshake: { auth: { token: 'jwt.fake' } },
      emit,
    };
    socketRegistry.set('S_OWNER', { id: 'S_OWNER', emit });

    await gateway.handleWebRTCPeerJoined(
      owner as never,
      { lectureId: LECTURE },
    );
    expect(verify).toHaveBeenCalledWith('jwt.fake');
    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.ownerSocketId).toBe('S_OWNER');
    const ownerData = owner.data as unknown as {
      user: { id: string; username: string };
      webrtcOwnedLectures: Set<string>;
    };
    expect(ownerData.user).toEqual({ id: 'u-owner', username: 'trainer' });
    expect(ownerData.webrtcOwnedLectures.has(LECTURE)).toBe(true);
  });

  it('KS-3889: повторный peer-joined от того же подписчика тоже пересылается владельцу', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    const sub = makeClient('S_SUB', { id: 'u-sub', username: 's' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    await gateway.handleWebRTCPeerJoined(sub, { lectureId: LECTURE });
    // Первая итерация owner уже получил peer-joined; готовимся к
    // повторной — фронт зрителя ретраит после потери offer'а или
    // перезагрузки.
    (owner.emit as jest.Mock).mockClear();
    await gateway.handleWebRTCPeerJoined(sub, { lectureId: LECTURE });
    // Размер subscribers НЕ должен вырасти (Set уже содержит).
    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.subscribers.size).toBe(1);
    // Владелец получил повторный peer-joined для пересоздания offer.
    expect((owner.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-joined',
      expect.objectContaining({ lectureId: LECTURE, fromSocketId: 'S_SUB' }),
    );
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

  // KS-3888: на публичной лекции зритель без логина — обычный сценарий.
  // Раньше тут был forbidden, и анон не попадал в subscribers, поэтому
  // publisher после саморегистрации видел пустой набор подписчиков.
  it('KS-3888: anon регистрируется как subscriber, owner получает peer-joined', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });

    const anon = makeClient('S_ANON', null);
    (owner.emit as jest.Mock).mockClear();
    await gateway.handleWebRTCPeerJoined(anon, { lectureId: LECTURE });

    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.subscribers.has('S_ANON')).toBe(true);
    expect((owner.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-joined',
      expect.objectContaining({ lectureId: LECTURE, fromSocketId: 'S_ANON' }),
    );
    // Никаких forbidden/error.
    expect((anon.emit as jest.Mock)).not.toHaveBeenCalledWith(
      'live-analysis:error',
      expect.anything(),
    );
  });

  it('KS-3888: anon → publisher не успел (regression KS-3883): после регистрации publisher anon получает replay-offer trigger', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const anon = makeClient('S_ANON', null);
    await gateway.handleWebRTCPeerJoined(anon, { lectureId: LECTURE });
    // owner приходит позже — должен получить synthetic peer-joined для anon
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    (owner.emit as jest.Mock).mockClear();
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    expect((owner.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-joined',
      expect.objectContaining({ lectureId: LECTURE, fromSocketId: 'S_ANON' }),
    );
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

  // KS-4003 / ADR-116 §2.1, §2.3. Race owner-reconnect: после успешной
  // миграции owner'а на новый socket отложенный disconnect-handler
  // старого socket'а НЕ должен затирать publisher-state. Иначе новые
  // subscriber'ы получают `no publisher yet` → ICE timeout → тишина.
  it('KS-4003: отложенный disconnect старого owner-socket не затирает publisher-state после reconnect', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    // 1. Owner A регистрируется
    const ownerA = makeClient('S_OWNER_A', { id: 'u-owner', username: 'o' });
    await gateway.handleWebRTCPeerJoined(ownerA, { lectureId: LECTURE });
    // 2. Subscriber-1 подключается (фронт автора знает о нём)
    const sub1 = makeClient('S_SUB1', { id: 'u-sub1', username: 's1' });
    await gateway.handleWebRTCPeerJoined(sub1, { lectureId: LECTURE });
    // 3. Owner-сокет A теряет соединение, фронт пересоздаёт сокет → B
    //    шлёт peer-joined. Migration: ownerSocketId = B, replay subscribers.
    const ownerB = makeClient('S_OWNER_B', { id: 'u-owner', username: 'o' });
    (ownerB.emit as jest.Mock).mockClear();
    await gateway.handleWebRTCPeerJoined(ownerB, { lectureId: LECTURE });
    let peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.ownerSocketId).toBe('S_OWNER_B');
    // Owner B получил synthetic peer-joined по sub1 (replay)
    expect((ownerB.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-joined',
      expect.objectContaining({ fromSocketId: 'S_SUB1' }),
    );

    // 4. С ОПОЗДАНИЕМ приходит disconnect старого socket A
    //    (ping timeout 30s, либо просто отложенный teardown).
    //    Это ключевая проверка: ownerSocketId должен остаться = B.
    await (gateway as any).handleDisconnect(ownerA);

    peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers).toBeDefined();
    expect(peers.ownerSocketId).toBe('S_OWNER_B');
    expect(peers.subscribers.has('S_SUB1')).toBe(true);

    // 5. Новый subscriber-2 подключается ПОСЛЕ disconnect старого owner'а.
    //    Должен получить публикацию текущему owner'у B (а не «no publisher yet»).
    const sub2 = makeClient('S_SUB2', { id: 'u-sub2', username: 's2' });
    (ownerB.emit as jest.Mock).mockClear();
    await gateway.handleWebRTCPeerJoined(sub2, { lectureId: LECTURE });
    expect((ownerB.emit as jest.Mock)).toHaveBeenCalledWith(
      'webrtc:peer-joined',
      expect.objectContaining({
        lectureId: LECTURE,
        fromSocketId: 'S_SUB2',
      }),
    );
  });

  // KS-4003: peer-left от старого owner-socket после миграции тоже не
  // должен затирать состояние нового owner'а. Симметрия для случая,
  // когда фронт явно шлёт peer-left при cleanup'е.
  it('KS-4003: peer-left от старого owner-socket после миграции не затирает publisher-state', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const ownerA = makeClient('S_OWNER_A', { id: 'u-owner', username: 'o' });
    await gateway.handleWebRTCPeerJoined(ownerA, { lectureId: LECTURE });
    const ownerB = makeClient('S_OWNER_B', { id: 'u-owner', username: 'o' });
    await gateway.handleWebRTCPeerJoined(ownerB, { lectureId: LECTURE });

    // Старый A шлёт peer-left (фронт автора чистит старую регистрацию)
    gateway.handleWebRTCPeerLeft(ownerA as never, { lectureId: LECTURE });

    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.ownerSocketId).toBe('S_OWNER_B');
  });

  // KS-4003: повторный peer-joined от того же owner-socket — idempotent.
  // Replay-цикл и лог «publisher registered» НЕ должны срабатывать.
  it('KS-4003: повторный peer-joined от того же owner-socket не делает replay', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      id: LECTURE,
      ownerId: 'u-owner',
    });
    const owner = makeClient('S_OWNER', { id: 'u-owner', username: 'o' });
    const sub = makeClient('S_SUB', { id: 'u-sub', username: 's' });
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    await gateway.handleWebRTCPeerJoined(sub, { lectureId: LECTURE });

    // Первый peer-joined owner'а уже сделал replay (sub был ДО owner'а — нет,
    // тут owner раньше; для чистоты заново: первый раз был БЕЗ subscribers,
    // потом sub зашёл, owner получил peer-joined как реакцию на sub-join).
    // Сейчас peer-joined тем же owner-socket'ом — должен быть no-op для replay.
    (owner.emit as jest.Mock).mockClear();
    await gateway.handleWebRTCPeerJoined(owner, { lectureId: LECTURE });
    // НЕ ожидаем synthetic peer-joined для sub — это уже не первая
    // регистрация publisher'а, и replay-spam не нужен.
    expect((owner.emit as jest.Mock)).not.toHaveBeenCalledWith(
      'webrtc:peer-joined',
      expect.objectContaining({ fromSocketId: 'S_SUB' }),
    );
    const peers = (gateway as any).webrtcPeers.get(LECTURE);
    expect(peers.ownerSocketId).toBe('S_OWNER');
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

// ─────────────────────────────────────────────────────────────────────
// KS-4008 / ADR-121 Phase 1. Chat handlers внутри LiveAnalysisGateway.
// Покрываем главное:
//   - тренер пишет → message приходит в room c isTrainerMessage=true;
//   - ученик в mute → chat:error{muted}, broadcast'а нет;
//   - non-owner шлёт chat:delete → chat:error{forbidden};
//   - owner шлёт chat:delete → broadcast chat:delete;
//   - chat:send без подписки → chat:error{forbidden};
//   - chat:send в нелайв лекции → chat:error{closed}.
// ─────────────────────────────────────────────────────────────────────

describe('LiveAnalysisGateway chat:* handlers (KS-4008)', () => {
  const LECTURE_ID = '00000000-0000-0000-0000-000000004008';
  const OWNER_ID = '00000000-0000-0000-0000-000000000001';
  const STUDENT_ID = '00000000-0000-0000-0000-000000000002';
  const SLUG = 'SLUG-CHAT';

  let gateway: LiveAnalysisGateway;
  let prisma: {
    lecture: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let chatService: {
    isMuted: jest.Mock;
    checkAndConsumeRateLimit: jest.Mock;
    checkAndConsumeDuplicate: jest.Mock;
    normalizeText: jest.Mock;
    persistMessage: jest.Mock;
    softDeleteMessage: jest.Mock;
    muteUser: jest.Mock;
  };
  let roomEmit: jest.Mock;
  let fetchSocketsResult: Array<{
    id: string;
    data: { user?: { id: string } | null };
    emit: jest.Mock;
  }>;

  beforeEach(() => {
    prisma = {
      lecture: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    chatService = {
      isMuted: jest.fn().mockResolvedValue(false),
      checkAndConsumeRateLimit: jest.fn().mockResolvedValue(true),
      checkAndConsumeDuplicate: jest.fn().mockResolvedValue(true),
      normalizeText: jest.fn((t: string) => t.trim()),
      persistMessage: jest.fn().mockImplementation(async (a) => ({
        id: 'msg-1',
        lectureId: a.lectureId,
        authorId: a.authorId,
        authorUsername: a.authorUsername,
        text: a.text,
        createdAt: '2026-06-09T00:00:00Z',
        isTrainerMessage: a.authorId === a.ownerId,
        pinned: false,
        deletedAt: null,
        kind: 'user' as const,
      })),
      softDeleteMessage: jest.fn().mockResolvedValue(true),
      muteUser: jest.fn().mockResolvedValue(undefined),
    };
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      {} as LiveAnalysisService,
      {} as ConfigService,
      prisma as unknown as PrismaService,
      {} as never,
      chatService as never,
    );
    roomEmit = jest.fn();
    fetchSocketsResult = [];
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: roomEmit }),
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockImplementation(async () => fetchSocketsResult),
      }),
    };
  });

  function makeClient(
    user: { id: string; username: string } | null,
    ctx: { lectureId: string; ownerId: string; slug: string } | null = null,
  ): any {
    const c: any = {
      id: 's-' + Math.random().toString(36).slice(2, 6),
      data: { user, chatLecture: ctx ?? undefined },
      emit: jest.fn(),
    };
    return c;
  }

  it('тренер пишет: persist + broadcast chat:message с isTrainerMessage=true', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      status: 'live',
      ownerId: OWNER_ID,
    });
    const trainer = makeClient(
      { id: OWNER_ID, username: 'coach' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    await gateway.handleChatSend(trainer, {
      lectureId: LECTURE_ID,
      text: 'Hello team',
    });
    expect(chatService.checkAndConsumeRateLimit).not.toHaveBeenCalled();
    expect(chatService.checkAndConsumeDuplicate).not.toHaveBeenCalled();
    expect(chatService.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        lectureId: LECTURE_ID,
        authorId: OWNER_ID,
        ownerId: OWNER_ID,
        text: 'Hello team',
      }),
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'chat:message',
      expect.objectContaining({ isTrainerMessage: true, text: 'Hello team' }),
    );
  });

  it('ученик в mute → chat:error{muted}, broadcast не происходит', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      status: 'live',
      ownerId: OWNER_ID,
    });
    chatService.isMuted.mockResolvedValue(true);
    const student = makeClient(
      { id: STUDENT_ID, username: 'student' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    await gateway.handleChatSend(student, {
      lectureId: LECTURE_ID,
      text: 'why am I muted',
    });
    expect(student.emit).toHaveBeenCalledWith(
      'chat:error',
      expect.objectContaining({ code: 'muted' }),
    );
    expect(chatService.persistMessage).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('ученик: 4-я подряд (rate-limit вернул false) → chat:error{rate_limited}', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      status: 'live',
      ownerId: OWNER_ID,
    });
    chatService.checkAndConsumeRateLimit.mockResolvedValue(false);
    const student = makeClient(
      { id: STUDENT_ID, username: 'student' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    await gateway.handleChatSend(student, {
      lectureId: LECTURE_ID,
      text: 'one more',
    });
    expect(student.emit).toHaveBeenCalledWith(
      'chat:error',
      expect.objectContaining({ code: 'rate_limited' }),
    );
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('ученик: duplicate guard вернул false → chat:error{duplicate}', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      status: 'live',
      ownerId: OWNER_ID,
    });
    chatService.checkAndConsumeDuplicate.mockResolvedValue(false);
    const student = makeClient(
      { id: STUDENT_ID, username: 'student' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    await gateway.handleChatSend(student, {
      lectureId: LECTURE_ID,
      text: 'spam spam',
    });
    expect(student.emit).toHaveBeenCalledWith(
      'chat:error',
      expect.objectContaining({ code: 'duplicate' }),
    );
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('chat:send без подписки (нет chatLecture) → chat:error{forbidden}', async () => {
    const student = makeClient({ id: STUDENT_ID, username: 'student' }, null);
    await gateway.handleChatSend(student, {
      lectureId: LECTURE_ID,
      text: 'hi',
    });
    expect(student.emit).toHaveBeenCalledWith(
      'chat:error',
      expect.objectContaining({ code: 'forbidden' }),
    );
  });

  it('chat:send в не-live лекции → chat:error{closed}', async () => {
    prisma.lecture.findUnique.mockResolvedValue({
      status: 'recorded',
      ownerId: OWNER_ID,
    });
    const student = makeClient(
      { id: STUDENT_ID, username: 'student' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    await gateway.handleChatSend(student, {
      lectureId: LECTURE_ID,
      text: 'after end',
    });
    expect(student.emit).toHaveBeenCalledWith(
      'chat:error',
      expect.objectContaining({ code: 'closed' }),
    );
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('chat:delete от не-тренера → forbidden, persist не вызывается', async () => {
    const student = makeClient(
      { id: STUDENT_ID, username: 'student' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    await gateway.handleChatDelete(student, {
      lectureId: LECTURE_ID,
      messageId: '11111111-1111-1111-1111-111111111111',
    });
    expect(student.emit).toHaveBeenCalledWith(
      'chat:error',
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect(chatService.softDeleteMessage).not.toHaveBeenCalled();
  });

  it('chat:delete от тренера → soft-delete + broadcast chat:delete всем', async () => {
    const trainer = makeClient(
      { id: OWNER_ID, username: 'coach' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    const MSG = '11111111-1111-1111-1111-111111111111';
    await gateway.handleChatDelete(trainer, {
      lectureId: LECTURE_ID,
      messageId: MSG,
    });
    expect(chatService.softDeleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        lectureId: LECTURE_ID,
        messageId: MSG,
        deletedById: OWNER_ID,
      }),
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'chat:delete',
      expect.objectContaining({ lectureId: LECTURE_ID, messageId: MSG }),
    );
  });

  it('chat:mute от тренера → upsert + chat:muted целевому ученику в room', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: STUDENT_ID });
    const trainer = makeClient(
      { id: OWNER_ID, username: 'coach' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    const targetEmit = jest.fn();
    const otherEmit = jest.fn();
    fetchSocketsResult = [
      { id: 's-stud', data: { user: { id: STUDENT_ID } }, emit: targetEmit },
      { id: 's-other', data: { user: { id: 'U-X' } }, emit: otherEmit },
    ];
    await gateway.handleChatMute(trainer, {
      lectureId: LECTURE_ID,
      userId: STUDENT_ID,
    });
    expect(chatService.muteUser).toHaveBeenCalledWith(
      expect.objectContaining({
        lectureId: LECTURE_ID,
        userId: STUDENT_ID,
        mutedById: OWNER_ID,
      }),
    );
    expect(targetEmit).toHaveBeenCalledWith(
      'chat:muted',
      expect.objectContaining({ lectureId: LECTURE_ID, byUserId: OWNER_ID }),
    );
    expect(otherEmit).not.toHaveBeenCalled();
  });

  it('chat:mute self-mute → forbidden, upsert не выполняется', async () => {
    const trainer = makeClient(
      { id: OWNER_ID, username: 'coach' },
      { lectureId: LECTURE_ID, ownerId: OWNER_ID, slug: SLUG },
    );
    await gateway.handleChatMute(trainer, {
      lectureId: LECTURE_ID,
      userId: OWNER_ID,
    });
    expect(trainer.emit).toHaveBeenCalledWith(
      'chat:error',
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect(chatService.muteUser).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KS-3902 / ADR-117 §3. Подписка LiveAnalysisGateway на Redis-канал
// `lecture-tools-changed` и ретрансляция в WS-комнату как событие
// `live-analysis:lecture-tools`. Тесты не поднимают socket.io / Redis:
// эмулируем обработчик сообщений `subRedis.on('message', ...)`
// вручную через приватный путь, а `server.to(...).emit(...)`
// мокается.
// ─────────────────────────────────────────────────────────────────────

describe('LiveAnalysisGateway pub/sub lecture-tools-changed (KS-3902)', () => {
  let gateway: LiveAnalysisGateway;
  let emit: jest.Mock;
  let to: jest.Mock;

  beforeEach(() => {
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      {} as unknown as LiveAnalysisService,
      {} as ConfigService,
      {} as PrismaService,
      {} as never,
      {} as never,
    );
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    (gateway as any).server = {
      to,
      in: jest.fn().mockReturnValue({ socketsLeave: jest.fn() }),
    };
  });

  it('ретранслирует валидный payload в WS-комнату как live-analysis:lecture-tools', () => {
    const payload = {
      slug: 'SLUGAAAAAA',
      lectureId: 'l-1',
      disabledTools: ['engine', 'book'],
      // KS-4041: hideMetricsTab — обязательное поле payload.
      hideMetricsTab: false,
    };
    (gateway as any).handleRedisMessage(
      'lecture-tools-changed',
      JSON.stringify(payload),
    );
    expect(to).toHaveBeenCalledWith('live-analysis:SLUGAAAAAA');
    expect(emit).toHaveBeenCalledWith(
      'live-analysis:lecture-tools',
      payload,
    );
  });

  it('KS-4041: ретранслирует payload с hideMetricsTab=true', () => {
    const payload = {
      slug: 'SLUGAAAAAA',
      lectureId: 'l-1',
      disabledTools: [],
      hideMetricsTab: true,
    };
    (gateway as any).handleRedisMessage(
      'lecture-tools-changed',
      JSON.stringify(payload),
    );
    expect(emit).toHaveBeenCalledWith(
      'live-analysis:lecture-tools',
      payload,
    );
  });

  it('игнорирует сообщение без slug', () => {
    (gateway as any).handleRedisMessage(
      'lecture-tools-changed',
      JSON.stringify({
        lectureId: 'l-1',
        disabledTools: [],
        hideMetricsTab: false,
      }),
    );
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('игнорирует payload с disabledTools не-массивом', () => {
    (gateway as any).handleRedisMessage(
      'lecture-tools-changed',
      JSON.stringify({
        slug: 'SLUGAAAAAA',
        lectureId: 'l-1',
        disabledTools: 'engine,book',
        hideMetricsTab: false,
      }),
    );
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('KS-4041: игнорирует payload с hideMetricsTab не-boolean', () => {
    (gateway as any).handleRedisMessage(
      'lecture-tools-changed',
      JSON.stringify({
        slug: 'SLUGAAAAAA',
        lectureId: 'l-1',
        disabledTools: [],
        hideMetricsTab: 'true',
      }),
    );
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('KS-4041: игнорирует payload без hideMetricsTab', () => {
    (gateway as any).handleRedisMessage(
      'lecture-tools-changed',
      JSON.stringify({
        slug: 'SLUGAAAAAA',
        lectureId: 'l-1',
        disabledTools: [],
      }),
    );
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('игнорирует невалидный JSON, не валит обработчик', () => {
    expect(() =>
      (gateway as any).handleRedisMessage('lecture-tools-changed', 'not-json'),
    ).not.toThrow();
    expect(to).not.toHaveBeenCalled();
  });

  it('игнорирует неизвестный канал — не эмитит', () => {
    (gateway as any).handleRedisMessage(
      'some-other-channel',
      JSON.stringify({
        slug: 'SLUGAAAAAA',
        lectureId: 'l-1',
        disabledTools: ['engine'],
      }),
    );
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KS-3940 / ADR-118 §2.4.2. handleSubscribe access flow для
// restricted-лекций. Проверяет lecture-lookup + delegation в
// LecturesAccessService.resolveLectureAccess + emit ACCESS_DENIED +
// disconnect при denied. Slot/sync/join не настраиваем — тестируем
// только access-ветку через приватный checkLectureAccessForSlug
// + один интеграционный сценарий с handleSubscribe.
// ─────────────────────────────────────────────────────────────────────

describe('LiveAnalysisGateway.handleSubscribe access flow (KS-3940)', () => {
  let gateway: LiveAnalysisGateway;
  let prisma: { lecture: { findFirst: jest.Mock } };
  let access: { resolveLectureAccess: jest.Mock };
  let service: { tryAcquireViewerSlot: jest.Mock; getSyncSnapshot: jest.Mock; decrementViewer: jest.Mock };

  beforeEach(() => {
    prisma = { lecture: { findFirst: jest.fn() } };
    access = { resolveLectureAccess: jest.fn() };
    service = {
      tryAcquireViewerSlot: jest.fn().mockResolvedValue(1),
      getSyncSnapshot: jest.fn().mockResolvedValue({ slug: 's', startingFen: '', orientation: 'white' }),
      decrementViewer: jest.fn().mockResolvedValue(0),
    };
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      service as unknown as LiveAnalysisService,
      {} as ConfigService,
      prisma as unknown as PrismaService,
      access as never,
      {} as never,
    );
    (gateway as any).server = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
  });

  function makeClient(userId: string | null): any {
    return {
      data: {
        user: userId ? { id: userId, username: 'u' } : null,
        subscribedSlugs: new Set(),
      },
      emit: jest.fn(),
      disconnect: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
    };
  }

  // ─── private checkLectureAccessForSlug ───────────────────────────

  it('checkLectureAccessForSlug: лекции нет → null (доступ свободен)', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce(null);
    const r = await (gateway as any).checkLectureAccessForSlug('s', 'u-1');
    expect(r).toBeNull();
    expect(access.resolveLectureAccess).not.toHaveBeenCalled();
  });

  it('checkLectureAccessForSlug: allowed → null', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner',
      visibility: 'public',
    });
    access.resolveLectureAccess.mockResolvedValueOnce({
      allowed: true,
      reason: 'public',
    });
    const r = await (gateway as any).checkLectureAccessForSlug('s', null);
    expect(r).toBeNull();
  });

  it('checkLectureAccessForSlug: denied (auth_required) → возвращает reason', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner',
      visibility: 'restricted',
    });
    access.resolveLectureAccess.mockResolvedValueOnce({
      allowed: false,
      reason: 'auth_required',
    });
    const r = await (gateway as any).checkLectureAccessForSlug('s', null);
    expect(r).toBe('auth_required');
  });

  it('checkLectureAccessForSlug: denied (not_in_allowlist) → возвращает reason', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner',
      visibility: 'restricted',
    });
    access.resolveLectureAccess.mockResolvedValueOnce({
      allowed: false,
      reason: 'not_in_allowlist',
    });
    const r = await (gateway as any).checkLectureAccessForSlug('s', 'student-x');
    expect(r).toBe('not_in_allowlist');
  });

  // ─── handleSubscribe full flow ───────────────────────────────────

  it('handleSubscribe: restricted + anon → emit ACCESS_DENIED + disconnect, slot не занят, sync не отправлен', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner',
      visibility: 'restricted',
    });
    access.resolveLectureAccess.mockResolvedValueOnce({
      allowed: false,
      reason: 'auth_required',
    });
    const client = makeClient(null);
    await gateway.handleSubscribe(client, { slug: 'SLUG-ABCDE' } as never);
    expect(client.emit).toHaveBeenCalledWith(
      'live-analysis:access-denied',
      { reason: 'auth_required' },
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(service.tryAcquireViewerSlot).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('handleSubscribe: restricted без grant → access-denied (not_in_allowlist)', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner',
      visibility: 'restricted',
    });
    access.resolveLectureAccess.mockResolvedValueOnce({
      allowed: false,
      reason: 'not_in_allowlist',
    });
    const client = makeClient('student-x');
    await gateway.handleSubscribe(client, { slug: 'SLUG-ABCDE' } as never);
    expect(client.emit).toHaveBeenCalledWith(
      'live-analysis:access-denied',
      { reason: 'not_in_allowlist' },
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('handleSubscribe: public → доступ свободен, обычный flow (slot + sync + join)', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner',
      visibility: 'public',
    });
    access.resolveLectureAccess.mockResolvedValueOnce({
      allowed: true,
      reason: 'public',
    });
    const client = makeClient('viewer-1');
    await gateway.handleSubscribe(client, { slug: 'SLUG-ABCDE' } as never);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(service.tryAcquireViewerSlot).toHaveBeenCalledWith('SLUG-ABCDE');
    expect(client.join).toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(
      'live-analysis:sync',
      expect.any(Object),
    );
  });

  it('handleSubscribe: лекции нет (LiveAnalysis без привязки) → обычный flow', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce(null);
    const client = makeClient(null);
    await gateway.handleSubscribe(client, { slug: 'SLUG-FREE0' } as never);
    expect(access.resolveLectureAccess).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(service.tryAcquireViewerSlot).toHaveBeenCalled();
    expect(client.join).toHaveBeenCalled();
  });

  it('handleSubscribe: restricted + owner → доступ свободен (allowed=owner)', async () => {
    prisma.lecture.findFirst.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner-1',
      visibility: 'restricted',
    });
    access.resolveLectureAccess.mockResolvedValueOnce({
      allowed: true,
      reason: 'owner',
    });
    const client = makeClient('owner-1');
    await gateway.handleSubscribe(client, { slug: 'SLUG-OWN' } as never);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(service.tryAcquireViewerSlot).toHaveBeenCalled();
    expect(client.join).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KS-3943 / ADR-118 §2.5. handleLectureAccessRevoked: pub/sub-handler
// для канала `lecture-access-revoked`. Перебирает подключённых
// сокетов комнаты, эмитит ACCESS_REVOKED и disconnect'ит тех, у кого
// нет доступа.
// ─────────────────────────────────────────────────────────────────────

describe('LiveAnalysisGateway.handleLectureAccessRevoked (KS-3943)', () => {
  let gateway: LiveAnalysisGateway;
  let prisma: { lecture: { findUnique: jest.Mock } };
  let access: { resolveLectureAccess: jest.Mock };
  let sockets: Array<{
    id: string;
    data: { user: { id: string } | null };
    emit: jest.Mock;
    disconnect: jest.Mock;
  }>;

  function makeSocket(
    id: string,
    user: { id: string } | null,
  ): typeof sockets[number] {
    return {
      id,
      data: { user },
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  beforeEach(() => {
    prisma = { lecture: { findUnique: jest.fn() } };
    access = { resolveLectureAccess: jest.fn() };
    sockets = [];
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      {} as unknown as LiveAnalysisService,
      {} as ConfigService,
      prisma as unknown as PrismaService,
      access as never,
      {} as never,
    );
    (gateway as any).server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockImplementation(async () => sockets),
      }),
    };
  });

  function invoke(payload: unknown): void {
    (gateway as any).handleRedisMessage(
      'lecture-access-revoked',
      JSON.stringify(payload),
    );
  }

  async function waitMicro() {
    // handleRedisMessage запускает handler как `void promise.catch(...)` —
    // даём eventloop'у прокрутить микротаски.
    await new Promise((r) => setImmediate(r));
  }

  // ─── malformed payload ──────────────────────────────────────────

  it('игнорирует payload без lectureId / revokedUserIds / reason', async () => {
    invoke({ slug: 'SLG1', revokedUserIds: [], reason: 'revoked' }); // нет lectureId
    invoke({ slug: 'SLG1', lectureId: 'lec', reason: 'revoked' }); // нет revokedUserIds
    invoke({ slug: 'SLG1', lectureId: 'lec', revokedUserIds: [], reason: 'other' }); // bad reason
    await waitMicro();
    expect((gateway as any).server.in).not.toHaveBeenCalled();
  });

  // ─── reason='revoked' ───────────────────────────────────────────

  it("reason=revoked: эмитит и disconnect'ит сокеты с user.id ∈ revokedUserIds", async () => {
    const s1 = makeSocket('S1', { id: 'student-1' });
    const s2 = makeSocket('S2', { id: 'student-2' });
    const s3 = makeSocket('S3', { id: 'student-3' });
    sockets = [s1, s2, s3];

    invoke({
      lectureId: 'lec-1',
      slug: 'SLG1',
      revokedUserIds: ['student-1', 'student-3'],
      reason: 'revoked',
    });
    await waitMicro();

    expect(s1.emit).toHaveBeenCalledWith('live-analysis:access-revoked', {
      lectureId: 'lec-1',
      reason: 'revoked',
    });
    expect(s1.disconnect).toHaveBeenCalledWith(true);
    expect(s2.emit).not.toHaveBeenCalled();
    expect(s2.disconnect).not.toHaveBeenCalled();
    expect(s3.emit).toHaveBeenCalled();
    expect(s3.disconnect).toHaveBeenCalledWith(true);
  });

  it('reason=revoked: anon socket (user=null) — никогда не в revokedUserIds, не трогаем', async () => {
    const anon = makeSocket('Sa', null);
    sockets = [anon];
    invoke({
      lectureId: 'lec-1',
      slug: 'SLG1',
      revokedUserIds: ['student-1'],
      reason: 'revoked',
    });
    await waitMicro();
    expect(anon.disconnect).not.toHaveBeenCalled();
  });

  // ─── reason='visibility-changed' ────────────────────────────────

  it('reason=visibility-changed: owner НЕ отключается, anon отключается, allowlist пропускается, без grant отключается', async () => {
    const owner = makeSocket('So', { id: 'owner-1' });
    const anon = makeSocket('Sa', null);
    const inList = makeSocket('Si', { id: 'student-in' });
    const outList = makeSocket('Sx', { id: 'student-out' });
    sockets = [owner, anon, inList, outList];

    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner-1',
      visibility: 'restricted',
    });

    access.resolveLectureAccess.mockImplementation(async (_lec, uid) => {
      if (uid === 'owner-1') return { allowed: true, reason: 'owner' };
      if (uid === null) return { allowed: false, reason: 'auth_required' };
      if (uid === 'student-in') return { allowed: true, reason: 'allowlisted' };
      return { allowed: false, reason: 'not_in_allowlist' };
    });

    invoke({
      lectureId: 'lec-1',
      slug: 'SLG1',
      revokedUserIds: [],
      reason: 'visibility-changed',
    });
    await waitMicro();

    expect(owner.disconnect).not.toHaveBeenCalled();
    expect(inList.disconnect).not.toHaveBeenCalled();
    expect(anon.emit).toHaveBeenCalledWith('live-analysis:access-revoked', {
      lectureId: 'lec-1',
      reason: 'visibility-changed',
    });
    expect(anon.disconnect).toHaveBeenCalledWith(true);
    expect(outList.disconnect).toHaveBeenCalledWith(true);
  });

  it('reason=visibility-changed + лекции нет (удалена) → skip, никого не трогаем', async () => {
    const s = makeSocket('S1', { id: 'student-1' });
    sockets = [s];
    prisma.lecture.findUnique.mockResolvedValueOnce(null);
    invoke({
      lectureId: 'lec-deleted',
      slug: 'SLG1',
      revokedUserIds: [],
      reason: 'visibility-changed',
    });
    await waitMicro();
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  // ─── комната пуста ───────────────────────────────────────────────

  it('комната пуста — ранний выход без чтения лекции', async () => {
    sockets = [];
    invoke({
      lectureId: 'lec-1',
      slug: 'SLG1',
      revokedUserIds: [],
      reason: 'visibility-changed',
    });
    await waitMicro();
    expect(prisma.lecture.findUnique).not.toHaveBeenCalled();
  });
});
