/**
 * KS-4823. Юнит-тесты `HintI18nEntryDto`:
 *   - opt поля `ctaLabel` / `instructionBody` корректно валидируются;
 *   - `instructionBody` принимает до 2000 символов;
 *   - >2000 → ошибка.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { HintI18nEntryDto } from './admin-hint.dto';

function transform(input: Record<string, unknown>): HintI18nEntryDto {
  return plainToInstance(HintI18nEntryDto, input);
}

describe('HintI18nEntryDto — instructionBody (KS-4823)', () => {
  it('без instructionBody → ок', () => {
    const dto = transform({ title: 'T', body: 'B' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.instructionBody).toBeUndefined();
  });

  it('instructionBody до 2000 символов → ок', () => {
    const dto = transform({
      title: 'T',
      body: 'B',
      instructionBody: 'x'.repeat(2000),
    });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('instructionBody = 2001 символ → ошибка', () => {
    const dto = transform({
      title: 'T',
      body: 'B',
      instructionBody: 'x'.repeat(2001),
    });
    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('instructionBody — пустая строка → ошибка (Length min 1)', () => {
    const dto = transform({ title: 'T', body: 'B', instructionBody: '' });
    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('instructionBody не строка → ошибка', () => {
    const dto = transform({ title: 'T', body: 'B', instructionBody: 123 });
    expect(validateSync(dto)).not.toHaveLength(0);
  });

  it('title/body остаются обязательными', () => {
    expect(validateSync(transform({}))).not.toHaveLength(0);
    expect(validateSync(transform({ title: 'T' }))).not.toHaveLength(0);
    expect(validateSync(transform({ body: 'B' }))).not.toHaveLength(0);
  });
});
