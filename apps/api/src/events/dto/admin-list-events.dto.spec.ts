/**
 * KS-4801. Юнит-тест DTO `AdminListEventsQueryDto`:
 *   - actorId — обязательный UUID;
 *   - actorType — опционально 'user'|'guest', default отсутствует;
 *   - наследует Transform базового `ListEventsQueryDto` (limit/types/showSystem/cursor).
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminListEventsQueryDto } from './admin-list-events.dto';

function transform(input: Record<string, unknown>): AdminListEventsQueryDto {
  return plainToInstance(AdminListEventsQueryDto, input);
}

const VALID_UUID = '06f68cfd-be49-4944-9519-9f1a05f12750';

describe('AdminListEventsQueryDto', () => {
  it('actorId обязателен — отсутствие → ошибка', () => {
    expect(validateSync(transform({}))).not.toHaveLength(0);
  });

  it('actorId не UUID → ошибка', () => {
    expect(validateSync(transform({ actorId: 'not-a-uuid' }))).not.toHaveLength(0);
  });

  it('actorId — валидный UUID v4 → ок', () => {
    expect(validateSync(transform({ actorId: VALID_UUID }))).toHaveLength(0);
  });

  it('actorType=user/guest → ок; иначе — ошибка', () => {
    expect(validateSync(transform({ actorId: VALID_UUID, actorType: 'user' }))).toHaveLength(0);
    expect(validateSync(transform({ actorId: VALID_UUID, actorType: 'guest' }))).toHaveLength(0);
    expect(validateSync(transform({ actorId: VALID_UUID, actorType: 'bot' }))).not.toHaveLength(0);
  });

  it('actorType нечувствителен к регистру (uppercase → user)', () => {
    const dto = transform({ actorId: VALID_UUID, actorType: 'USER' });
    expect(dto.actorType).toBe('user');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('actorType пустой/undefined → undefined (default применит контроллер)', () => {
    const a = transform({ actorId: VALID_UUID, actorType: '' });
    expect(a.actorType).toBeUndefined();
    expect(validateSync(a)).toHaveLength(0);
    const b = transform({ actorId: VALID_UUID });
    expect(b.actorType).toBeUndefined();
  });

  it('наследует Transform: limit string→int, showSystem "true"→bool', () => {
    const dto = transform({
      actorId: VALID_UUID,
      limit: '25',
      showSystem: 'true',
    });
    expect(dto.limit).toBe(25);
    expect(dto.showSystem).toBe(true);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('наследует валидацию types-грамматики', () => {
    expect(validateSync(transform({ actorId: VALID_UUID, types: 'bad-name' })))
      .not.toHaveLength(0);
  });
});
