import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitAttemptDto } from './submit-attempt.dto';

/**
 * KS-4032. Регрессия: депт > 60 у Stockfish — валидный кейс. Прежний
 * `@Max(60)` на `moves[].depth` резал реальные submit'ы (63, 70+) →
 * 400 → попытка не сохранялась. Тесты фиксируют новое поведение
 * (граница снята) и страхуют от регрессии.
 */

const BASE_MOVE = {
  ply: 1,
  fenBefore:
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  playedUci: 'e2e4',
  bestUci: 'e2e4',
  wdlBefore: { w: 1000, d: 0, l: 0 },
  wdlAfter: { w: 1000, d: 0, l: 0 },
};

describe('SubmitAttemptDto — KS-4032 depth ограничения', () => {
  it('valid: depth=63 (реальный кейс Stanislav) — без ошибок', async () => {
    const dto = plainToInstance(SubmitAttemptDto, {
      result: 'solved',
      timeMs: 5000,
      moves: [{ ...BASE_MOVE, depth: 63 }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('valid: depth=100 — без ошибок (Stockfish может уходить далеко)', async () => {
    const dto = plainToInstance(SubmitAttemptDto, {
      result: 'solved',
      timeMs: 5000,
      moves: [{ ...BASE_MOVE, depth: 100 }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('valid: depth=0 — допустимо (mate already found)', async () => {
    const dto = plainToInstance(SubmitAttemptDto, {
      result: 'solved',
      timeMs: 5000,
      moves: [{ ...BASE_MOVE, depth: 0 }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('valid: depth опущен — без ошибок (поле опциональное)', async () => {
    const dto = plainToInstance(SubmitAttemptDto, {
      result: 'solved',
      timeMs: 5000,
      moves: [{ ...BASE_MOVE }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('invalid: depth=строка — отклоняется (IsInt)', async () => {
    const dto = plainToInstance(SubmitAttemptDto, {
      result: 'solved',
      timeMs: 5000,
      moves: [{ ...BASE_MOVE, depth: 'twelve' }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('invalid: depth=12.5 — отклоняется (IsInt)', async () => {
    const dto = plainToInstance(SubmitAttemptDto, {
      result: 'solved',
      timeMs: 5000,
      moves: [{ ...BASE_MOVE, depth: 12.5 }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
