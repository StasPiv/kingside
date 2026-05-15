import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateAnalysisDto } from './update-analysis.dto';

describe('UpdateAnalysisDto', () => {
  function createDto(overrides: Partial<Record<string, any>> = {}): UpdateAnalysisDto {
    return plainToInstance(UpdateAnalysisDto, overrides);
  }

  it('пустой объект — валиден (PATCH без полей)', async () => {
    const errors = await validate(createDto());
    expect(errors).toHaveLength(0);
  });

  // KS-3045: валидация поля boardOrientation в PATCH /analyses/:id.
  // Допустимые значения — 'white' | 'black' | null. Пропуск (undefined)
  // тоже валиден — IsOptional. Любая другая строка / число → 400.
  describe('KS-3045 boardOrientation', () => {
    it('boardOrientation=undefined (пропуск) — валидно', async () => {
      const errors = await validate(createDto({ title: 'x' }));
      expect(errors).toHaveLength(0);
    });

    it('boardOrientation=null — валидно (сброс на дефолт фронта)', async () => {
      const errors = await validate(createDto({ boardOrientation: null }));
      expect(errors).toHaveLength(0);
    });

    it("boardOrientation='white' — валидно", async () => {
      const errors = await validate(createDto({ boardOrientation: 'white' }));
      expect(errors).toHaveLength(0);
    });

    it("boardOrientation='black' — валидно", async () => {
      const errors = await validate(createDto({ boardOrientation: 'black' }));
      expect(errors).toHaveLength(0);
    });

    it("boardOrientation='foo' — невалидно (acceptance: 400)", async () => {
      const errors = await validate(createDto({ boardOrientation: 'foo' }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('boardOrientation');
    });

    it('boardOrientation=123 (число) — невалидно', async () => {
      const errors = await validate(createDto({ boardOrientation: 123 }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('boardOrientation');
    });

    it("boardOrientation='WHITE' (capslock) — невалидно", async () => {
      const errors = await validate(createDto({ boardOrientation: 'WHITE' }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('boardOrientation');
    });
  });
});
