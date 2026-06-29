/**
 * KS-4806 / ADR-153 §2.4. Проверяем, что `HintLifecycleBodyDto`
 * принимает `reason: 'quiet_page'` без 400 (whitelist расширен).
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  HINT_LIFECYCLE_REASONS,
  HintLifecycleBodyDto,
} from './hints-lifecycle.dto';

function transform(input: Record<string, unknown>): HintLifecycleBodyDto {
  return plainToInstance(HintLifecycleBodyDto, input);
}

describe('HintLifecycleBodyDto', () => {
  it('reason=quiet_page → ок (KS-4806)', () => {
    expect(validateSync(transform({ reason: 'quiet_page' }))).toHaveLength(0);
  });

  it('все ранее существовавшие reason остаются валидными', () => {
    for (const r of ['no_anchor', 'close_button', 'cta_clicked', 'accepted_by', 'ttl_expired'] as const) {
      const errors = validateSync(transform({ reason: r }));
      if (errors.length > 0) {
        throw new Error(`reason=${r} unexpectedly invalid: ${JSON.stringify(errors)}`);
      }
    }
  });

  it('reason отсутствует → ок (поле опционально)', () => {
    expect(validateSync(transform({}))).toHaveLength(0);
  });

  it('reason не из whitelist → ошибка', () => {
    expect(validateSync(transform({ reason: 'arbitrary' }))).not.toHaveLength(0);
  });

  it('константа HINT_LIFECYCLE_REASONS содержит quiet_page', () => {
    expect(HINT_LIFECYCLE_REASONS).toContain('quiet_page');
  });
});
