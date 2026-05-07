import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FindPuzzlesDto } from './find-puzzles.dto';

/**
 * KS-2472 / ADR-044 §5.5. Whitelist валидации `solutionMode`. На уровне
 * приложения `ValidationPipe` (`whitelist: true, forbidNonWhitelisted:
 * true, transform: true`) превратит constraints failure в HTTP 400.
 */

describe('FindPuzzlesDto — KS-2472 solutionMode', () => {
  it('valid: forced-line', async () => {
    const dto = plainToInstance(FindPuzzlesDto, {
      solutionMode: 'forced-line',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.solutionMode).toBe('forced-line');
  });

  it('valid: play-vs-engine', async () => {
    const dto = plainToInstance(FindPuzzlesDto, {
      solutionMode: 'play-vs-engine',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.solutionMode).toBe('play-vs-engine');
  });

  it('valid: omitted (optional)', async () => {
    const dto = plainToInstance(FindPuzzlesDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.solutionMode).toBeUndefined();
  });

  it('invalid: unknown value → constraint failure (route → 400)', async () => {
    const dto = plainToInstance(FindPuzzlesDto, {
      solutionMode: 'random-mode',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('solutionMode');
    expect(errors[0].constraints).toMatchObject({
      isIn: expect.any(String),
    });
  });

  it('invalid: пустая строка → constraint failure', async () => {
    const dto = plainToInstance(FindPuzzlesDto, { solutionMode: '' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('solutionMode');
  });

  it('combined: solutionMode + rating + themes валидно', async () => {
    const dto = plainToInstance(FindPuzzlesDto, {
      solutionMode: 'play-vs-engine',
      ratingMin: 1200,
      ratingMax: 1800,
      themes: ['fork'],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
