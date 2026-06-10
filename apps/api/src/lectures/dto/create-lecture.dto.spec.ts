/**
 * KS-3899 / ADR-117 A02. Тесты валидации `disabledTools` в
 * `CreateLectureDto` и `UpdateLectureDto`. Используем
 * `class-validator` + `class-transformer` — те же инструменты, что
 * Nest `ValidationPipe` применяет в боевом потоке. Если валидатор
 * возвращает ошибки, Nest сконвертирует их в 400 BadRequest.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ALL_LECTURE_DISABLED_TOOLS } from '@kingside/shared';
import { CreateLectureDto, UpdateLectureDto } from './create-lecture.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  const instance = plainToInstance(cls, payload);
  return validate(instance, { whitelist: true });
}

describe('CreateLectureDto.disabledTools (KS-3899 / ADR-117)', () => {
  const base = { title: 'Test lecture' };

  it('поле опциональное: без него ошибок нет', async () => {
    const errors = await validateDto(CreateLectureDto, base);
    expect(errors).toHaveLength(0);
  });

  it('пустой массив — валиден (означает «ничего не отключено»)', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      disabledTools: [],
    });
    expect(errors).toHaveLength(0);
  });

  it('один валидный элемент — без ошибок', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      disabledTools: ['engine'],
    });
    expect(errors).toHaveLength(0);
  });

  it('все элементы из whitelist — без ошибок', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      disabledTools: [...ALL_LECTURE_DISABLED_TOOLS],
    });
    expect(errors).toHaveLength(0);
  });

  it('невалидное значение в массиве → ошибка валидации (isIn)', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      disabledTools: ['engine', 'unknown-tool'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('disabledTools');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/isIn/);
  });

  it('не массив (строка) → ошибка валидации (isArray)', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      disabledTools: 'engine',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('disabledTools');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/isArray/);
  });

  it('дубликаты в массиве → ошибка валидации (arrayUnique)', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      disabledTools: ['engine', 'engine'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('disabledTools');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/arrayUnique/);
  });
});

describe('UpdateLectureDto.disabledTools (KS-3899 / ADR-117)', () => {
  it('поле опциональное: пустой PATCH-payload без ошибок', async () => {
    const errors = await validateDto(UpdateLectureDto, {});
    expect(errors).toHaveLength(0);
  });

  it('пустой массив — валиден (снять все ограничения)', async () => {
    const errors = await validateDto(UpdateLectureDto, { disabledTools: [] });
    expect(errors).toHaveLength(0);
  });

  it('валидный полный набор инструментов — без ошибок', async () => {
    const errors = await validateDto(UpdateLectureDto, {
      disabledTools: ['engine', 'book', 'ai_comment'],
    });
    expect(errors).toHaveLength(0);
  });

  it('невалидное значение → ошибка валидации', async () => {
    const errors = await validateDto(UpdateLectureDto, {
      disabledTools: ['engine', 'totally_made_up'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('disabledTools');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/isIn/);
  });

  it('дубликаты → ошибка валидации (arrayUnique)', async () => {
    const errors = await validateDto(UpdateLectureDto, {
      disabledTools: ['book', 'book'],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('disabledTools');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/arrayUnique/);
  });
});

/**
 * KS-4039. Валидация `hideMetricsTab` в Create/Update DTO.
 */
describe('CreateLectureDto.hideMetricsTab (KS-4039)', () => {
  const base = { title: 'Test lecture' };

  it('поле опциональное: без него ошибок нет', async () => {
    const errors = await validateDto(CreateLectureDto, base);
    expect(errors).toHaveLength(0);
  });

  it('hideMetricsTab=true — валидно', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      hideMetricsTab: true,
    });
    expect(errors).toHaveLength(0);
  });

  it('hideMetricsTab=false — валидно', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      hideMetricsTab: false,
    });
    expect(errors).toHaveLength(0);
  });

  it('не булево (строка) → ошибка валидации', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      hideMetricsTab: 'yes',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('hideMetricsTab');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/isBoolean/);
  });

  it('не булево (число) → ошибка валидации', async () => {
    const errors = await validateDto(CreateLectureDto, {
      ...base,
      hideMetricsTab: 1,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('hideMetricsTab');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/isBoolean/);
  });
});

describe('UpdateLectureDto.hideMetricsTab (KS-4039)', () => {
  it('опциональное: пустой payload — без ошибок', async () => {
    const errors = await validateDto(UpdateLectureDto, {});
    expect(errors).toHaveLength(0);
  });

  it('hideMetricsTab=true — валидно', async () => {
    const errors = await validateDto(UpdateLectureDto, {
      hideMetricsTab: true,
    });
    expect(errors).toHaveLength(0);
  });

  it('hideMetricsTab=false — валидно (снять флажок)', async () => {
    const errors = await validateDto(UpdateLectureDto, {
      hideMetricsTab: false,
    });
    expect(errors).toHaveLength(0);
  });

  it('не булево → ошибка валидации', async () => {
    const errors = await validateDto(UpdateLectureDto, {
      hideMetricsTab: 'on',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('hideMetricsTab');
    expect(JSON.stringify(errors[0].constraints)).toMatch(/isBoolean/);
  });
});
