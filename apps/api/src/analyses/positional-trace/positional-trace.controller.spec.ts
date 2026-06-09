/**
 * KS-4026 / ADR-122. Smoke-тесты контроллера + DTO-валидации
 * (переезд с `gameId` на `analysisId`):
 *   - GET счастливый путь устанавливает Cache-Control;
 *   - POST счастливый путь возвращает 201 при первой записи и 200 при перезаписи;
 *   - DELETE отдаёт 204 (через @HttpCode на хендлере);
 *   - DTO-валидация: пустой sfVersion, value_mg за пределами ±20, ply вне диапазона.
 *
 * Контроллер тонкий, поэтому сервис мокается полностью.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { POSITIONAL_TRACE_VERSION } from '@kingside/shared';
import type { Response } from 'express';
import { PositionalTraceController } from './positional-trace.controller';
import type { PositionalTraceService } from './positional-trace.service';
import type { AuthenticatedRequest } from '../../common/authenticated-request';
import {
  PositionalTraceUpsertDto,
  PositionalTracePlyDto,
  PositionalSubtermInputDto,
} from './dto/positional-trace.dto';

const ANALYSIS = '00000000-0000-0000-0000-000000004026';
const USER = '00000000-0000-0000-0000-000000000001';

function makeResMock(): Response {
  const r: Partial<Response> = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };
  return r as Response;
}

function makeReqMock(): AuthenticatedRequest {
  return { user: { id: USER, username: 'alice' } } as AuthenticatedRequest;
}

describe('PositionalTraceController (KS-4026)', () => {
  it('GET — кладёт Cache-Control: private, max-age=300', async () => {
    const service = {
      getOrThrow: jest.fn().mockResolvedValue({
        analysisId: ANALYSIS,
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [],
        durationMs: null,
        createdAt: '2026-06-09T00:00:00.000Z',
        updatedAt: '2026-06-09T00:00:00.000Z',
      }),
    } as unknown as PositionalTraceService;
    const ctrl = new PositionalTraceController(service);
    const res = makeResMock();
    const dto = await ctrl.get(
      ANALYSIS,
      { v: POSITIONAL_TRACE_VERSION } as never,
      res,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, max-age=300',
    );
    expect((dto as { analysisId: string }).analysisId).toBe(ANALYSIS);
  });

  it('POST — 201 при первом сохранении', async () => {
    const service = {
      upsert: jest.fn().mockResolvedValue({
        trace: {
          analysisId: ANALYSIS,
          sfVersion: POSITIONAL_TRACE_VERSION,
          plies: [],
          durationMs: null,
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
        },
        wasCreated: true,
      }),
    } as unknown as PositionalTraceService;
    const ctrl = new PositionalTraceController(service);
    const res = makeResMock();
    await ctrl.post(
      ANALYSIS,
      {
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [{ ply: 0, subterms: [] }],
      } as never,
      makeReqMock(),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('POST — 200 при перезаписи', async () => {
    const service = {
      upsert: jest.fn().mockResolvedValue({
        trace: {
          analysisId: ANALYSIS,
          sfVersion: POSITIONAL_TRACE_VERSION,
          plies: [],
          durationMs: null,
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
        },
        wasCreated: false,
      }),
    } as unknown as PositionalTraceService;
    const ctrl = new PositionalTraceController(service);
    const res = makeResMock();
    await ctrl.post(
      ANALYSIS,
      {
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [{ ply: 0, subterms: [] }],
      } as never,
      makeReqMock(),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('DELETE — делегирует сервису userId из req.user.id', async () => {
    const service = {
      deleteByAnalysis: jest.fn().mockResolvedValue(undefined),
    } as unknown as PositionalTraceService;
    const ctrl = new PositionalTraceController(service);
    await ctrl.delete(ANALYSIS, makeReqMock());
    expect(service.deleteByAnalysis).toHaveBeenCalledWith(ANALYSIS, USER);
  });
});

// ─── DTO ────────────────────────────────────────────────────────────

describe('PositionalTraceUpsertDto validation (KS-4026)', () => {
  function dto(input: unknown) {
    return plainToInstance(PositionalTraceUpsertDto, input);
  }

  it('валидный payload проходит', async () => {
    const errors = await validate(
      dto({
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [
          {
            ply: 0,
            subterms: [
              { id: 'space', color: 'w', value_mg: 0.1, value_eg: 0.0 },
            ],
          },
        ],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('пустой sfVersion → ошибка', async () => {
    const errors = await validate(
      dto({ sfVersion: '', plies: [{ ply: 0, subterms: [] }] }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('value_mg за пределами ±20 → ошибка', async () => {
    const errors = await validate(
      dto({
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [
          {
            ply: 0,
            subterms: [
              { id: 'x', value_mg: 9999, value_eg: 0 },
            ],
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('value_eg NaN → ошибка', async () => {
    const errors = await validate(
      dto({
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [
          {
            ply: 0,
            subterms: [{ id: 'x', value_mg: 0, value_eg: NaN }],
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('plies пустой → ошибка (ArrayMinSize)', async () => {
    const errors = await validate(
      dto({ sfVersion: POSITIONAL_TRACE_VERSION, plies: [] }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('color не в {w,b} → ошибка', async () => {
    const errors = await validate(
      dto({
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [
          {
            ply: 0,
            subterms: [
              { id: 'x', color: 'red', value_mg: 0, value_eg: 0 },
            ],
          },
        ],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ply отрицательный → ошибка', async () => {
    const errors = await validate(
      dto({
        sfVersion: POSITIONAL_TRACE_VERSION,
        plies: [{ ply: -1, subterms: [] }],
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('PositionalSubtermInputDto validation', () => {
  it('square не в a1..h8 → ошибка', async () => {
    const sub = plainToInstance(PositionalSubtermInputDto, {
      id: 'x',
      square: 'z9',
      value_mg: 0,
      value_eg: 0,
    });
    const errors = await validate(sub);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('valid square a1..h8 проходит', async () => {
    const sub = plainToInstance(PositionalSubtermInputDto, {
      id: 'x',
      square: 'e4',
      value_mg: 0.1,
      value_eg: 0.05,
    });
    const errors = await validate(sub);
    expect(errors).toHaveLength(0);
  });
});

describe('PositionalTracePlyDto validation', () => {
  it('phase > 256 → ошибка', async () => {
    const ply = plainToInstance(PositionalTracePlyDto, {
      ply: 0,
      subterms: [],
      phase: 999,
    });
    const errors = await validate(ply);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('phase в диапазоне 0..256 проходит', async () => {
    const ply = plainToInstance(PositionalTracePlyDto, {
      ply: 0,
      subterms: [],
      phase: 128,
    });
    const errors = await validate(ply);
    expect(errors).toHaveLength(0);
  });
});
