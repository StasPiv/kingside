/**
 * KS-2376: тест на корректную привязку ETag к ресурсу /analyses/<id>.
 *
 * Жалоба пользователя: при открытии любой партии в окне анализа
 * показывалась одна и та же партия. По ALB-логам — backend отдавал
 * 304 Not Modified на разные uuid'ы, браузер использовал тело
 * предыдущего запроса из своего HTTP-кэша.
 *
 * Лечение в `findOne`:
 *   - ETag = `W/"analysis-<id>-<updatedAt-ms>"` — гарантированно
 *     уникален per-resource, любой If-None-Match от другого ресурса
 *     не совпадёт.
 *   - Cache-Control: private, no-cache, must-revalidate.
 */
import { AnalysisController } from './analysis.controller';
import type { AnalysisService } from './analysis.service';
import type { SavedFilterService } from './saved-filter.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import type { Response } from 'express';

describe('AnalysisController.findOne — KS-2376 ETag', () => {
  function makeRes() {
    const headers: Record<string, string> = {};
    return {
      headers,
      res: {
        setHeader: jest.fn((name: string, value: string) => {
          headers[name.toLowerCase()] = value;
        }),
      } as unknown as Response,
    };
  }

  function makeReq(userId = 'user-1'): AuthenticatedRequest {
    return { user: { id: userId } } as AuthenticatedRequest;
  }

  it('ETag привязан к id + updatedAt; Cache-Control: private, no-cache, must-revalidate', async () => {
    const updatedAt = new Date('2026-05-04T12:34:56.789Z');
    const analysisId = 'd470d1fb-1111-2222-3333-444455556666';

    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id: analysisId,
        userId: 'user-1',
        title: 'Game A',
        updatedAt,
        tags: [],
      }),
    } as unknown as AnalysisService;
    const filterSvc = {} as SavedFilterService;

    const controller = new AnalysisController(svc, filterSvc);
    const { res, headers } = makeRes();

    const result = await controller.findOne(makeReq(), analysisId, res);
    expect(result.id).toBe(analysisId);

    expect(headers['etag']).toBe(
      `W/"analysis-${analysisId}-${updatedAt.getTime()}"`,
    );
    expect(headers['cache-control']).toBe(
      'private, no-cache, must-revalidate',
    );
  });

  it('разные id → разные ETag (нет cross-resource совпадений)', async () => {
    const updatedAt = new Date('2026-05-04T12:00:00.000Z');
    const idA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const svc = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({
          id: idA,
          userId: 'u1',
          updatedAt,
          tags: [],
        })
        .mockResolvedValueOnce({
          id: idB,
          userId: 'u1',
          updatedAt,
          tags: [],
        }),
    } as unknown as AnalysisService;
    const filterSvc = {} as SavedFilterService;
    const controller = new AnalysisController(svc, filterSvc);

    const a = makeRes();
    const b = makeRes();
    await controller.findOne(makeReq(), idA, a.res);
    await controller.findOne(makeReq(), idB, b.res);

    expect(a.headers['etag']).not.toBe(b.headers['etag']);
    expect(a.headers['etag']).toContain(idA);
    expect(b.headers['etag']).toContain(idB);
  });

  it('updatedAt-строка из JSON сериализации тоже корректно парсится', async () => {
    const updatedAtStr = '2026-05-04T10:00:00.000Z';
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    const svc = {
      findOne: jest.fn().mockResolvedValue({
        id,
        userId: 'u1',
        updatedAt: updatedAtStr,
        tags: [],
      }),
    } as unknown as AnalysisService;
    const filterSvc = {} as SavedFilterService;
    const controller = new AnalysisController(svc, filterSvc);
    const { res, headers } = makeRes();

    await controller.findOne(makeReq(), id, res);
    expect(headers['etag']).toBe(
      `W/"analysis-${id}-${new Date(updatedAtStr).getTime()}"`,
    );
  });
});
