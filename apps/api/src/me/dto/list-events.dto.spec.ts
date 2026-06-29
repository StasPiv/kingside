/**
 * KS-4799 / ADR-152 §2.1. Юнит-тест DTO `ListEventsQueryDto`:
 *   - query всегда приходит из express как строки;
 *   - `@Transform` должен корректно привести их к int/bool/string[];
 *   - validate() ловит выход за допустимый диапазон.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListEventsQueryDto } from './list-events.dto';

function transform(input: Record<string, unknown>): ListEventsQueryDto {
  return plainToInstance(ListEventsQueryDto, input);
}

describe('ListEventsQueryDto — Transform', () => {
  it('limit как строка → number', () => {
    const dto = transform({ limit: '25' });
    expect(dto.limit).toBe(25);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('limit отсутствует → undefined (контроллер применит default)', () => {
    const dto = transform({});
    expect(dto.limit).toBeUndefined();
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('limit вне диапазона → ошибка валидации', () => {
    expect(validateSync(transform({ limit: '0' }))).not.toHaveLength(0);
    expect(validateSync(transform({ limit: '101' }))).not.toHaveLength(0);
    expect(validateSync(transform({ limit: '-1' }))).not.toHaveLength(0);
  });

  it('types: comma-list → string[]', () => {
    const dto = transform({ types: 'game_end,puzzle_solved' });
    expect(dto.types).toEqual(['game_end', 'puzzle_solved']);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('types: триммит пробелы и игнорирует пустые', () => {
    const dto = transform({ types: 'a,, b , c ,' });
    expect(dto.types).toEqual(['a', 'b', 'c']);
  });

  it('types: невалидный токен (с дефисом) → ошибка', () => {
    const dto = transform({ types: 'bad-name' });
    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('types: слишком длинный (>64) → ошибка', () => {
    const dto = transform({ types: 'a'.repeat(65) });
    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('showSystem: "true"/"false"/"1"/"0" → boolean', () => {
    expect(transform({ showSystem: 'true' }).showSystem).toBe(true);
    expect(transform({ showSystem: 'false' }).showSystem).toBe(false);
    expect(transform({ showSystem: '1' }).showSystem).toBe(true);
    expect(transform({ showSystem: '0' }).showSystem).toBe(false);
  });

  it('showSystem: "yes" → не приводится, validator падает', () => {
    expect(validateSync(transform({ showSystem: 'yes' }))).not.toHaveLength(0);
  });

  it('cursor: пустой → undefined допустимо', () => {
    expect(validateSync(transform({ cursor: '' }))).toHaveLength(0);
  });

  it('cursor: слишком длинный (>256) → ошибка', () => {
    expect(validateSync(transform({ cursor: 'x'.repeat(257) }))).not.toHaveLength(0);
  });
});
