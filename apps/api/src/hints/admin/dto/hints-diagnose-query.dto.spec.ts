/**
 * KS-4803. DTO-тест `HintsDiagnoseQueryDto`.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { HintsDiagnoseQueryDto } from './hints-diagnose-query.dto';

function transform(input: Record<string, unknown>): HintsDiagnoseQueryDto {
  return plainToInstance(HintsDiagnoseQueryDto, input);
}

const VALID_UUID = '06f68cfd-be49-4944-9519-9f1a05f12750';
const VALID_HINT_UUID = 'fcec1e85-f2dd-4001-889d-00e4ef601213';

describe('HintsDiagnoseQueryDto', () => {
  it('actorId обязателен', () => {
    expect(validateSync(transform({}))).not.toHaveLength(0);
  });

  it('actorId не UUID v4 → ошибка', () => {
    expect(validateSync(transform({ actorId: 'not-a-uuid' }))).not.toHaveLength(0);
  });

  it('валидный actorId, без actorType → ок', () => {
    expect(validateSync(transform({ actorId: VALID_UUID }))).toHaveLength(0);
  });

  it('actorType=user|guest → ок; bot → ошибка', () => {
    expect(validateSync(transform({ actorId: VALID_UUID, actorType: 'user' }))).toHaveLength(0);
    expect(validateSync(transform({ actorId: VALID_UUID, actorType: 'guest' }))).toHaveLength(0);
    expect(validateSync(transform({ actorId: VALID_UUID, actorType: 'bot' }))).not.toHaveLength(0);
  });

  it('actorType case-insensitive', () => {
    const dto = transform({ actorId: VALID_UUID, actorType: 'GUEST' });
    expect(dto.actorType).toBe('guest');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('hintId — опциональный UUID v4', () => {
    const dto = transform({ actorId: VALID_UUID, hintId: VALID_HINT_UUID });
    expect(dto.hintId).toBe(VALID_HINT_UUID);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('hintId не UUID → ошибка', () => {
    expect(validateSync(transform({ actorId: VALID_UUID, hintId: 'bad' }))).not.toHaveLength(0);
  });
});
