/**
 * KS-4695: DTO-валидация POST /events. Контракт от T2 — фронт-клиент
 * шлёт `{events: [{type, payload?, ts}]}`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateEventsDto, assertPayloadSizes } from './create-events.dto';

function validate(input: unknown) {
  const dto = plainToInstance(CreateEventsDto, input);
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

describe('CreateEventsDto', () => {
  it('минимально валидный', () => {
    const { errors } = validate({
      events: [{ type: 'page_view', payload: { p: 1 }, ts: '2026-06-27T10:00:00.000Z' }],
    });
    expect(errors).toHaveLength(0);
  });

  it('payload опционален', () => {
    const { errors } = validate({
      events: [{ type: 'page_view', ts: '2026-06-27T10:00:00.000Z' }],
    });
    expect(errors).toHaveLength(0);
  });

  it('пустой массив отклоняется', () => {
    const { errors } = validate({ events: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('>50 событий — ошибка', () => {
    const events = Array.from({ length: 51 }, () => ({
      type: 'page_view',
      ts: '2026-06-27T10:00:00.000Z',
    }));
    const { errors } = validate({ events });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('type вне regex — ошибка', () => {
    const { errors } = validate({
      events: [{ type: 'bad type!', ts: '2026-06-27T10:00:00.000Z' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ts не ISO — ошибка', () => {
    const { errors } = validate({
      events: [{ type: 'page_view', ts: 'not-iso' }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('assertPayloadSizes', () => {
  it('допустимый размер ОК', () => {
    expect(() =>
      assertPayloadSizes({
        events: [{ type: 'a', payload: { k: 'x' }, ts: '2026-06-27T00:00:00.000Z' }],
      } as any),
    ).not.toThrow();
  });

  it('payload >8 KB — бросает', () => {
    const big = { blob: 'x'.repeat(9 * 1024) };
    expect(() =>
      assertPayloadSizes({
        events: [{ type: 'a', payload: big, ts: '2026-06-27T00:00:00.000Z' }],
      } as any),
    ).toThrow(/too large/);
  });
});
