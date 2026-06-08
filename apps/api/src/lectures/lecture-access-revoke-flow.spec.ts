/**
 * KS-3944 / ADR-118 §2.5. Сквозной тест revoke-сценария:
 *   REST `DELETE /lectures/:id/access/:userId` (или
 *   `PATCH visibility: public → restricted`)
 *   → `LecturesAccessService.publishRevokeEvent` в Redis
 *   → `LiveAnalysisGateway.handleRedisMessage('lecture-access-revoked')`
 *   → emit `live-analysis:access-revoked` + `socket.disconnect(true)`
 *   только нужным сокетам.
 *
 * Тесты не поднимают socket.io / ioredis / Nest application: вручную
 * конструируем `LecturesAccessService` и `LiveAnalysisGateway`,
 * моки prisma/redis передаются через конструктор. Передача сообщения
 * от сервиса в шлюз эмулируется хелпером `relayLastPublish`, который
 * берёт аргументы последнего `redis.publish(...)` и зовёт
 * `gateway.handleRedisMessage(...)` напрямую. Тот же приём, что в
 * KS-3904 `lecture-tools-flow.spec.ts`.
 */

import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { LecturesAccessService } from './lectures-access.service';
import { LiveAnalysisGateway } from '../live-analysis/live-analysis.gateway';
import { LiveAnalysisService } from '../live-analysis/live-analysis.service';
import { RedisService } from '../redis/redis.service';
import type { PrismaService } from '../prisma/prisma.service';
import { LiveAnalysisEvents } from '@kingside/shared';

describe('KS-3944 / ADR-118 §2.5: lecture-access-revoked end-to-end', () => {
  let prisma: {
    lecture: { findUnique: jest.Mock };
    lectureAccessGrant: { deleteMany: jest.Mock };
  };
  let redis: { publish: jest.Mock };
  let access: LecturesAccessService;
  let gateway: LiveAnalysisGateway;
  let sockets: Array<{
    id: string;
    data: { user: { id: string } | null; webrtcLectures?: Set<string> };
    emit: jest.Mock;
    disconnect: jest.Mock;
  }>;

  beforeEach(() => {
    prisma = {
      lecture: { findUnique: jest.fn() },
      lectureAccessGrant: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    redis = { publish: jest.fn().mockResolvedValue(1) };
    access = new LecturesAccessService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
    );
    sockets = [];
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      {} as unknown as LiveAnalysisService,
      {} as ConfigService,
      prisma as unknown as PrismaService,
      access,
    );
    (gateway as unknown as {
      server: { in: jest.Mock };
    }).server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockImplementation(async () => sockets),
      }),
    };
  });

  function makeSocket(
    id: string,
    userId: string | null,
  ): typeof sockets[number] {
    return {
      id,
      data: { user: userId ? { id: userId } : null, webrtcLectures: new Set() },
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  function relayLastPublish(): void {
    expect(redis.publish).toHaveBeenCalled();
    const [channel, message] = redis.publish.mock.calls[
      redis.publish.mock.calls.length - 1
    ] as [string, string];
    (gateway as unknown as {
      handleRedisMessage: (c: string, m: string) => void;
    }).handleRedisMessage(channel, message);
  }

  async function waitMicro() {
    // handleRedisMessage запускает асинхронный handler через
    // `void promise.catch(...)` — даём eventloop'у прокрутить.
    await new Promise((r) => setImmediate(r));
  }

  // ─── revoke single user ──────────────────────────────────────────

  it('revokeGrant live → publish → отключает только указанного user, allowed не трогает', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner-1',
      status: 'live',
      visibility: 'restricted',
      liveAnalysisId: 'la-1',
      liveAnalysis: { slug: 'LIVESLG01' },
    });
    prisma.lectureAccessGrant.deleteMany.mockResolvedValueOnce({ count: 1 });

    const revoked = makeSocket('Sr', 'student-revoked');
    const allowed = makeSocket('Sa', 'student-allowed');
    sockets = [revoked, allowed];

    await access.revokeGrant('lec-1', 'owner-1', 'student-revoked');
    relayLastPublish();
    await waitMicro();

    expect(revoked.emit).toHaveBeenCalledWith(
      LiveAnalysisEvents.ACCESS_REVOKED,
      { lectureId: 'lec-1', reason: 'revoked' },
    );
    expect(revoked.disconnect).toHaveBeenCalledWith(true);
    expect(allowed.emit).not.toHaveBeenCalled();
    expect(allowed.disconnect).not.toHaveBeenCalled();
  });

  // ─── visibility-changed ──────────────────────────────────────────

  it('visibility-changed: gateway пересчитывает каждого через резолвер, отключает только denied', async () => {
    // 1. Полный flow начинается с publishRevokeEvent (visibility-changed),
    //    минуя revokeGrant — это путь из LecturesService.update.
    await access.publishRevokeEvent({
      lectureId: 'lec-2',
      slug: 'LIVESLG02',
      revokedUserIds: [],
      reason: 'visibility-changed',
    });

    // 2. Gateway во время handle подгрузит лекцию (уже restricted) +
    //    проверит каждого подключённого.
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-2',
      ownerId: 'owner-1',
      visibility: 'restricted',
    });
    // findFirst в restricted-резолвере для каждого user'а:
    //   - student-in   → grant найден → allowed;
    //   - student-out  → grant не найден → denied.
    const findFirstMock = jest.fn();
    findFirstMock
      .mockResolvedValueOnce({ id: 'g-in' }) // student-in найден
      .mockResolvedValueOnce(null); // student-out не найден
    (prisma as unknown as {
      lectureAccessGrant: { findFirst: jest.Mock };
    }).lectureAccessGrant.findFirst = findFirstMock;

    const owner = makeSocket('So', 'owner-1');
    const anon = makeSocket('Sa', null);
    const inList = makeSocket('Si', 'student-in');
    const outList = makeSocket('Sx', 'student-out');
    sockets = [owner, anon, inList, outList];

    relayLastPublish();
    await waitMicro();

    expect(owner.disconnect).not.toHaveBeenCalled();
    expect(inList.disconnect).not.toHaveBeenCalled();
    expect(anon.emit).toHaveBeenCalledWith(
      LiveAnalysisEvents.ACCESS_REVOKED,
      { lectureId: 'lec-2', reason: 'visibility-changed' },
    );
    expect(anon.disconnect).toHaveBeenCalledWith(true);
    expect(outList.emit).toHaveBeenCalledWith(
      LiveAnalysisEvents.ACCESS_REVOKED,
      { lectureId: 'lec-2', reason: 'visibility-changed' },
    );
    expect(outList.disconnect).toHaveBeenCalledWith(true);
  });

  // ─── WebRTC peer-cleanup: handleDisconnect ──────────────────────

  it('WebRTC peer-cleanup при disconnect: handleDisconnect снимает peer из mesh', async () => {
    // Сценарий: revoked-сокет был в WebRTC peer-list лекции.
    // disconnect → handleDisconnect → removePeer. removePeer чистит
    // запись из `webrtcPeers` (внутренний Map) и эмитит `peer-left`
    // оставшимся peer'ам. Этот тест проверяет первое (вторая часть
    // покрыта KS-3836 в основном live-analysis.gateway.spec.ts).
    //
    // Setup peer-list через приватный API:
    const lectureId = 'lec-revoke-mesh';
    (gateway as unknown as {
      webrtcPeers: Map<
        string,
        { ownerSocketId: string | null; subscribers: Set<string> }
      >;
    }).webrtcPeers.set(lectureId, {
      ownerSocketId: null,
      subscribers: new Set(['Sr', 'Sother']),
    });

    const revokedClient = {
      id: 'Sr',
      data: { user: { id: 'student-revoked' }, webrtcLectures: new Set([lectureId]) },
      handshake: { address: '127.0.0.1' },
    } as never;

    // Минимальный мок зависимостей: service.releaseIpSlot/decrementViewer
    // не вызовутся (нет ipSlotAcquired / subscribedSlugs), webrtcLectures
    // запускает только webrtc-cleanup.
    (gateway as unknown as {
      service: { releaseIpSlot: jest.Mock; decrementViewer: jest.Mock };
    }).service = {
      releaseIpSlot: jest.fn(),
      decrementViewer: jest.fn(),
    };
    // webrtcNs нужен для broadcast peer-left.
    (gateway as unknown as {
      webrtcNs: { to: (id: string) => { emit: jest.Mock } };
    }).webrtcNs = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };

    await gateway.handleDisconnect(revokedClient);

    const peers = (gateway as unknown as {
      webrtcPeers: Map<
        string,
        { ownerSocketId: string | null; subscribers: Set<string> }
      >;
    }).webrtcPeers.get(lectureId);
    // peer 'Sr' снят, 'Sother' остался.
    expect(peers?.subscribers.has('Sr')).toBe(false);
    expect(peers?.subscribers.has('Sother')).toBe(true);
  });
});
