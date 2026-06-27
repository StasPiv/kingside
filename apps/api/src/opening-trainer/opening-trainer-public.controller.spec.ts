/**
 * KS-4160 + KS-4162 + KS-4674 (ADR-128 §6.8.2 + §11.13 + ADR-146):
 * Public-контроллер демо-репертуаров. После KS-4674 источник данных —
 * БД через `OpeningTrainerDemoService`. Тесты file-loader (парсинг
 * PGN/meta/BOM/slug-фильтр) остались в `demo-repertoire-seed.service.spec.ts`
 * — теперь это утилита для bootstrap-скрипта, не runtime.
 *
 * Здесь покрываем:
 *   1. Guards/rate-limit инварианты (KS-4160) — не изменились.
 *   2. Делегирование в `OpeningTrainerDemoService` (KS-4674).
 *   3. 404 на отсутствующий slug.
 */
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RATE_LIMIT_KEY,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { OpeningTrainerController } from './opening-trainer.controller';
import { OpeningTrainerPublicController } from './opening-trainer-public.controller';

function makeDemoSvcMock(opts: {
  list?: unknown[];
  detail?: unknown;
} = {}) {
  return {
    listSummaries: jest.fn().mockResolvedValue(opts.list ?? []),
    getDetail: jest.fn().mockResolvedValue(opts.detail ?? null),
  };
}

describe('OpeningTrainerPublicController', () => {
  const reflector = new Reflector();

  // ── Guards / rate-limit инварианты (KS-4160) ─────────────────────

  it('класс: без JWT/OptionalJwt-guard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerPublicController) ?? [];
    expect(guards).not.toContain(JwtAuthGuard);
    expect(guards).not.toContain(OptionalJwtGuard);
  });

  it('класс: единственный guard — RedisRateLimitGuard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerPublicController) ?? [];
    expect(guards).toContain(RedisRateLimitGuard);
  });

  it('rate-limit: 60 req / 60 sec', () => {
    const limit = reflector.get<{ maxRequests: number; windowSec: number }>(
      RATE_LIMIT_KEY,
      OpeningTrainerPublicController,
    );
    expect(limit).toBeDefined();
    expect(limit.maxRequests).toBe(60);
    expect(limit.windowSec).toBe(60);
  });

  it('регрессия: приватный OpeningTrainerController сохраняет class-JwtAuthGuard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  // ── Делегирование (KS-4674) ──────────────────────────────────────

  it('GET /demo делегирует в demo.listSummaries и возвращает массив', async () => {
    const summary = [
      {
        id: 'italian',
        title: 'Italian',
        description: 'desc',
        treeSize: 12,
        side: 'white' as const,
        languages: [],
      },
    ];
    const svc = makeDemoSvcMock({ list: summary });
    const ctrl = new OpeningTrainerPublicController(svc as never);
    await expect(ctrl.listDemoRepertoires()).resolves.toEqual(summary);
    expect(svc.listSummaries).toHaveBeenCalledTimes(1);
  });

  it('GET /demo возвращает [] на пустом результате', async () => {
    const svc = makeDemoSvcMock({ list: [] });
    const ctrl = new OpeningTrainerPublicController(svc as never);
    await expect(ctrl.listDemoRepertoires()).resolves.toEqual([]);
  });

  it('GET /demo/:id делегирует в demo.getDetail и возвращает detail', async () => {
    const detail = {
      id: 'italian',
      ownerId: '00000000-0000-0000-0000-000000000000',
      title: 'Italian',
      description: null,
      side: 'white' as const,
      nodeCount: 5,
      edgeCount: 4,
      maxDepth: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      pgn: '',
      tree: { rootFen: 'x', nodes: {}, meta: { nodeCount: 5, edgeCount: 4, maxDepth: 3 } },
      sources: [],
    };
    const svc = makeDemoSvcMock({ detail });
    const ctrl = new OpeningTrainerPublicController(svc as never);
    await expect(ctrl.getDemoRepertoire('italian')).resolves.toBe(detail);
    expect(svc.getDetail).toHaveBeenCalledWith('italian');
  });

  it('GET /demo/:id → 404 если getDetail вернул null', async () => {
    const svc = makeDemoSvcMock({ detail: null });
    const ctrl = new OpeningTrainerPublicController(svc as never);
    await expect(ctrl.getDemoRepertoire('unknown')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── POST /sessions: 204 no-op (KS-4160 / §11.13) ─────────────────

  it('POST /sessions: 204 no-op, без рантайм-ошибок', () => {
    const ctrl = new OpeningTrainerPublicController(makeDemoSvcMock() as never);
    expect(ctrl.startSession({})).toBeUndefined();
  });
});
