/**
 * KS-3904 / ADR-117 A07. Сквозной тест потока настроек инструментов
 * лекции: REST PATCH /lectures/:id { disabledTools } → Redis publish
 * (`lecture-tools-changed`) → LiveAnalysisGateway.handleRedisMessage
 * → server.to(room).emit('live-analysis:lecture-tools', payload).
 *
 * Покрытие:
 *   1. PATCH disabledTools в `scheduled` — БД обновлена, Redis publish
 *      не вызван (подписчиков в эфире нет), gateway ничего не
 *      эмитит.
 *   2. PATCH disabledTools в `live` + binding — БД обновлена, publish
 *      вызван с payload `{slug, lectureId, disabledTools}`; передача
 *      сообщения в gateway приводит к эмиту в правильную комнату.
 *   3. PATCH disabledTools в `recorded` — БД обновлена, publish не
 *      вызван (replay-режим, активной комнаты нет).
 *   4. PATCH `{title, disabledTools}` в `live` → 400, ничего не
 *      записано (ADR §2.3.1).
 *   5. PATCH disabledTools=[] в `live` + binding — publish c пустым
 *      массивом доходит до gateway и эмитится в комнату с тем же
 *      пустым массивом (фронт интерпретирует это как «все инструменты
 *      разрешены» — см. KS-3902).
 *   6. Регрессия: для live без `liveAnalysisId` (лекция без сессии)
 *      publish не вызывается даже если статус `live` — нет ключа
 *      комнаты в gateway.
 *
 * Тесты не поднимают socket.io / ioredis / Nest application: вручную
 * конструируем `LecturesService` и `LiveAnalysisGateway`, моки
 * Prisma/Redis передаются через конструктор. Передача сообщения от
 * сервиса в шлюз эмулируется хелпером `relayLastPublish`, который
 * берёт аргументы последнего `redis.publish(...)` и зовёт
 * `gateway.handleRedisMessage(...)` напрямую. Подмена реального
 * ioredis pub/sub на прямой вызов корректна, так как формат
 * сообщения (channel + JSON payload) контрактом фиксирован, а
 * ioredis pub/sub в проде делает ровно это — доставляет байты в
 * подписчик без преобразований.
 */

import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { BadRequestException } from '@nestjs/common';
import { LecturesService } from './lectures.service';
import { LiveAnalysisGateway } from '../live-analysis/live-analysis.gateway';
import { LiveAnalysisService } from '../live-analysis/live-analysis.service';
import { LectureAudioS3Service } from '../lecture-audio/lecture-audio-s3.service';
import { LectureAudioService } from '../lecture-audio/lecture-audio.service';
import { RedisService } from '../redis/redis.service';
import type { PrismaService } from '../prisma/prisma.service';
import { LiveAnalysisEvents } from '@kingside/shared';

describe('KS-3904 / ADR-117 A07: lecture-tools end-to-end (PATCH → Redis → WS)', () => {
  let prisma: {
    lecture: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let liveAnalysis: { closeBySlug: jest.Mock };
  let config: { get: jest.Mock };
  let audioS3: { isDisabled: jest.Mock };
  let audioService: { finalizeRecording: jest.Mock };
  let redis: { publish: jest.Mock };
  let service: LecturesService;

  let gateway: LiveAnalysisGateway;
  let serverEmit: jest.Mock;
  let serverTo: jest.Mock;

  /** Базовая запись live-лекции с привязкой к LiveAnalysis. */
  const liveBound = {
    id: 'l-1',
    ownerId: 'u-1',
    status: 'live' as const,
    liveAnalysisId: 'la-1',
  };
  const liveBoundUpdated = (disabledTools: string[]) => ({
    id: 'l-1',
    ownerId: 'u-1',
    status: 'live' as const,
    liveAnalysisId: 'la-1',
    disabledTools,
    liveAnalysis: { id: 'la-1', slug: 'FLOWSLUG01' },
  });

  beforeEach(() => {
    prisma = {
      lecture: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    liveAnalysis = { closeBySlug: jest.fn() };
    config = {
      get: jest.fn(
        (key: string) =>
          key === 'PUBLIC_BASE_URL' ? 'https://kingside.site' : undefined,
      ),
    };
    audioS3 = { isDisabled: jest.fn().mockReturnValue(false) };
    audioService = { finalizeRecording: jest.fn() };
    redis = { publish: jest.fn().mockResolvedValue(1) };

    service = new LecturesService(
      prisma as unknown as PrismaService,
      liveAnalysis as unknown as LiveAnalysisService,
      config as unknown as ConfigService,
      audioS3 as unknown as LectureAudioS3Service,
      audioService as unknown as LectureAudioService,
      redis as unknown as RedisService,
      // KS-3942: lecturesAccess (publishRevokeEvent) — в KS-3904 не задействуется,
      // подставляем пустую заглушку через `as never`.
      { publishRevokeEvent: jest.fn() } as never,
    );

    // Gateway собираем тоже вручную; зависимости не используются в
    // handleRedisMessage, поэтому передаём пустые объекты.
    gateway = new LiveAnalysisGateway(
      {} as JwtService,
      {} as unknown as LiveAnalysisService,
      {} as ConfigService,
      {} as unknown as PrismaService,
      {} as never,
      {} as never,
    );
    serverEmit = jest.fn();
    serverTo = jest.fn().mockReturnValue({ emit: serverEmit });
    (gateway as unknown as {
      server: { to: jest.Mock; in: jest.Mock };
    }).server = {
      to: serverTo,
      in: jest.fn().mockReturnValue({ socketsLeave: jest.fn() }),
    };
  });

  /**
   * Эмулирует доставку последнего сообщения, опубликованного через
   * `RedisService.publish`, обработчику `LiveAnalysisGateway`.
   * Возвращает payload, поданный в gateway — для удобства assert'ов.
   */
  function relayLastPublish(): { channel: string; payload: unknown } {
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = redis.publish.mock.calls[0] as [string, string];
    const payload = JSON.parse(message);
    (gateway as unknown as {
      handleRedisMessage: (c: string, m: string) => void;
    }).handleRedisMessage(channel, message);
    return { channel, payload };
  }

  // ─── 1. scheduled ─────────────────────────────────────────────────

  it('scheduled: PATCH disabledTools обновляет БД, publish не вызывается', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'l-1',
      ownerId: 'u-1',
      status: 'scheduled',
      liveAnalysisId: null,
    });
    prisma.lecture.update.mockResolvedValueOnce({
      id: 'l-1',
      ownerId: 'u-1',
      status: 'scheduled',
      liveAnalysisId: null,
      disabledTools: ['engine'],
      liveAnalysis: null,
    });

    await service.update('l-1', 'u-1', { disabledTools: ['engine'] });

    expect(prisma.lecture.update).toHaveBeenCalledTimes(1);
    expect(prisma.lecture.update.mock.calls[0][0].data).toEqual({
      disabledTools: ['engine'],
    });
    expect(redis.publish).not.toHaveBeenCalled();
    expect(serverTo).not.toHaveBeenCalled();
  });

  // ─── 2. live + binding ────────────────────────────────────────────

  it('live + binding: PATCH → publish → gateway emit (полный цикл)', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce(liveBound);
    prisma.lecture.update.mockResolvedValueOnce(
      liveBoundUpdated(['engine', 'book']),
    );

    await service.update('l-1', 'u-1', { disabledTools: ['engine', 'book'] });

    // (а) Prisma update
    expect(prisma.lecture.update).toHaveBeenCalledTimes(1);
    expect(prisma.lecture.update.mock.calls[0][0].data).toEqual({
      disabledTools: ['engine', 'book'],
    });

    // (б) Redis publish — служебный канал + JSON-payload
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = redis.publish.mock.calls[0];
    expect(channel).toBe('lecture-tools-changed');
    expect(JSON.parse(message)).toEqual({
      slug: 'FLOWSLUG01',
      lectureId: 'l-1',
      disabledTools: ['engine', 'book'],
    });

    // (в) Gateway получает сообщение и эмитит в комнату
    relayLastPublish();
    expect(serverTo).toHaveBeenCalledWith('live-analysis:FLOWSLUG01');
    expect(serverEmit).toHaveBeenCalledWith(
      LiveAnalysisEvents.LECTURE_TOOLS,
      {
        slug: 'FLOWSLUG01',
        lectureId: 'l-1',
        disabledTools: ['engine', 'book'],
      },
    );
  });

  // ─── 3. recorded ─────────────────────────────────────────────────

  it('recorded: PATCH обновляет БД, publish не вызывается', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'l-1',
      ownerId: 'u-1',
      status: 'recorded',
      liveAnalysisId: 'la-1',
    });
    prisma.lecture.update.mockResolvedValueOnce({
      id: 'l-1',
      ownerId: 'u-1',
      status: 'recorded',
      liveAnalysisId: 'la-1',
      disabledTools: ['ai_comment'],
      liveAnalysis: { id: 'la-1', slug: 'FLOWSLUG01' },
    });

    await service.update('l-1', 'u-1', { disabledTools: ['ai_comment'] });

    expect(prisma.lecture.update).toHaveBeenCalledTimes(1);
    expect(prisma.lecture.update.mock.calls[0][0].data).toEqual({
      disabledTools: ['ai_comment'],
    });
    expect(redis.publish).not.toHaveBeenCalled();
    expect(serverTo).not.toHaveBeenCalled();
  });

  // ─── 4. совмещённый PATCH {title, disabledTools} в live ─────────

  it('live: совмещённый PATCH {title, disabledTools} → 400, ничего не пишется и не публикуется', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce(liveBound);

    await expect(
      service.update('l-1', 'u-1', {
        title: 'Новое название',
        disabledTools: ['engine'],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.lecture.update).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
    expect(serverTo).not.toHaveBeenCalled();
  });

  // ─── 5. пустой массив в live ────────────────────────────────────

  it('live + binding: PATCH disabledTools=[] публикуется как [] и эмитится подписчикам', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce(liveBound);
    prisma.lecture.update.mockResolvedValueOnce(liveBoundUpdated([]));

    await service.update('l-1', 'u-1', { disabledTools: [] });

    expect(prisma.lecture.update.mock.calls[0][0].data).toEqual({
      disabledTools: [],
    });
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [, message] = redis.publish.mock.calls[0];
    expect(JSON.parse(message).disabledTools).toEqual([]);

    relayLastPublish();
    expect(serverEmit).toHaveBeenCalledWith(
      LiveAnalysisEvents.LECTURE_TOOLS,
      expect.objectContaining({
        slug: 'FLOWSLUG01',
        lectureId: 'l-1',
        disabledTools: [],
      }),
    );
  });

  // ─── 6. live без привязки к LiveAnalysis ────────────────────────

  it('live без liveAnalysisId: publish не вызывается (нет комнаты)', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'l-1',
      ownerId: 'u-1',
      status: 'live',
      liveAnalysisId: null,
    });
    prisma.lecture.update.mockResolvedValueOnce({
      id: 'l-1',
      ownerId: 'u-1',
      status: 'live',
      liveAnalysisId: null,
      disabledTools: ['engine'],
      liveAnalysis: null,
    });

    await service.update('l-1', 'u-1', { disabledTools: ['engine'] });

    expect(prisma.lecture.update).toHaveBeenCalledTimes(1);
    expect(redis.publish).not.toHaveBeenCalled();
    expect(serverTo).not.toHaveBeenCalled();
  });
});
