/**
 * KS-3615 / ADR-102 §8 B. Unit-тесты ReviewCommentController.
 *
 * Auth-Guard (JwtAuthGuard) — часть Nest-пайплайна, проверяется e2e
 * (не входит в этот файл). Тут — DTO-валидация (class-validator) и
 * порядок вызовов сервиса (rate-limit → batchComment).
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BatchCommentDto } from './dto/batch-comment.dto';
import { ReviewCommentController } from './review-comment.controller';

function validFact() {
  // MVP-2 shape (ADR-103 rev 3 §5): добавлены fen_after, tactical_motifs,
  // threats_created, threats_missed, positional_shifts (фронт всегда
  // прокидывает эти поля; принимаются как есть).
  return {
    ply: 0,
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    fen_after: '8/8/8/8/8/8/8/8 b - - 0 1',
    side: 'white',
    move: {
      san: 'e4',
      uci: 'e2e4',
      capture: null,
      check: false,
      mate: null,
      castling: null,
      promotion: null,
    },
    classification: 'best',
    delta_e: 0,
    sf_best: null,
    maia_alternative: null,
    stage: 'opening',
    opening_name: null,
    material_balance: 0,
    material_change: null,
    hanging_piece: null,
    mate_threat_after: null,
    tactical_motifs: [],
    threats_created: {},
    threats_missed: {},
    positional_shifts: [],
    user_elo: 1500,
    user_language: 'en',
  };
}

describe('BatchCommentDto — class-validator', () => {
  it('валидный body → no errors', async () => {
    const dto = plainToInstance(BatchCommentDto, {
      facts: [validFact()],
      userElo: 1500,
      language: 'en',
    });
    const errs = await validate(dto);
    expect(errs).toEqual([]);
  });

  it('пустой `facts: []` → 400 через ArrayMinSize', async () => {
    const dto = plainToInstance(BatchCommentDto, {
      facts: [],
      userElo: 1500,
      language: 'en',
    });
    const errs = await validate(dto);
    expect(errs.length).toBeGreaterThan(0);
    const factsErr = errs.find((e) => e.property === 'facts');
    expect(factsErr?.constraints).toMatchObject({
      arrayMinSize: expect.any(String),
    });
  });

  it('`facts.length === 500` (длинная партия) → проходит (KS-3629)', async () => {
    // KS-3629: верхняя граница на уровне DTO снята. Защита остаётся
    // через JWT + rate-limit + body-parser limit в main.ts.
    const dto = plainToInstance(BatchCommentDto, {
      facts: Array.from({ length: 500 }, validFact),
      userElo: 1500,
      language: 'en',
    });
    const errs = await validate(dto);
    expect(errs).toEqual([]);
  });

  it('неверный `language` → 400 через IsIn', async () => {
    const dto = plainToInstance(BatchCommentDto, {
      facts: [validFact()],
      userElo: 1500,
      language: 'fr', // не en/ru
    });
    const errs = await validate(dto);
    expect(errs.find((e) => e.property === 'language')).toBeTruthy();
  });

  it('`userElo` вне диапазона 800..3000 → 400', async () => {
    const tooLow = plainToInstance(BatchCommentDto, {
      facts: [validFact()],
      userElo: 500,
      language: 'en',
    });
    expect((await validate(tooLow)).find((e) => e.property === 'userElo'))
      .toBeTruthy();

    const tooHigh = plainToInstance(BatchCommentDto, {
      facts: [validFact()],
      userElo: 5000,
      language: 'en',
    });
    expect((await validate(tooHigh)).find((e) => e.property === 'userElo'))
      .toBeTruthy();
  });

  it('факт с невалидным `classification` → ошибка в nested', async () => {
    const f = validFact();
    f.classification = 'godlike' as any;
    const dto = plainToInstance(BatchCommentDto, {
      facts: [f],
      userElo: 1500,
      language: 'en',
    });
    const errs = await validate(dto);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('ReviewCommentController — порядок вызовов', () => {
  function makeController(svcOverrides: Partial<{
    checkRateLimit: jest.Mock;
    incrementRateLimit: jest.Mock;
    batchComment: jest.Mock;
  }> = {}) {
    const svc = {
      checkRateLimit: jest.fn().mockResolvedValue(undefined),
      incrementRateLimit: jest.fn().mockResolvedValue(undefined),
      batchComment: jest.fn().mockResolvedValue(['ok-1', 'ok-2']),
      ...svcOverrides,
    };
    const ctrl = new ReviewCommentController(svc as any);
    return { ctrl, svc };
  }

  const req = { user: { id: 'user-1' } } as any;
  const dto: BatchCommentDto = {
    facts: [validFact()] as any,
    userElo: 1500,
    language: 'en',
  };

  it('rate-limit pass → вызывает check → increment → batchComment, возвращает comments', async () => {
    const { ctrl, svc } = makeController();
    const result = await ctrl.batchComment(req, dto);
    expect(svc.checkRateLimit).toHaveBeenCalledWith('user-1');
    expect(svc.incrementRateLimit).toHaveBeenCalledWith('user-1');
    expect(svc.batchComment).toHaveBeenCalledWith('user-1', dto);
    expect(result).toEqual({ comments: ['ok-1', 'ok-2'] });
    // Порядок: checkRateLimit раньше batchComment.
    const checkOrder = svc.checkRateLimit.mock.invocationCallOrder[0];
    const batchOrder = svc.batchComment.mock.invocationCallOrder[0];
    expect(checkOrder).toBeLessThan(batchOrder);
  });

  it('checkRateLimit бросает 429 → пробрасывается, batchComment НЕ вызывается', async () => {
    const { ctrl, svc } = makeController({
      checkRateLimit: jest.fn().mockRejectedValue(
        new HttpException(
          { error: 'rate_limit', retryAfter: 60 },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      ),
    });
    await expect(ctrl.batchComment(req, dto)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(svc.incrementRateLimit).not.toHaveBeenCalled();
    expect(svc.batchComment).not.toHaveBeenCalled();
  });
});
