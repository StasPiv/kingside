/**
 * KS-4701 / ADR-147 §4.3 + §5.3. DTO для REST lifecycle подсказок.
 *
 *   POST /hints/:hintId/shown      — `<HintHost>` отрендерил.
 *   POST /hints/:hintId/dismissed  — пользователь нажал ×.
 *   POST /hints/:hintId/acted      — клик по CTA / smart-dismiss.
 *   POST /hints/:hintId/ignored    — ttlSec истёк без действия.
 *
 * Поле `reason` — опциональный enum для аналитики, совпадает с
 * `HintLifecycleReason` из shared T7.
 */
import { IsIn, IsOptional, IsString } from 'class-validator';

export const HINT_LIFECYCLE_REASONS = [
  'no_anchor',
  'close_button',
  'cta_clicked',
  'accepted_by',
  'ttl_expired',
  // KS-4806 / ADR-153 §2.4. Клиент уведомляет о cancel pending hint
  // при SPA-переходе на «тихую» страницу до резолва anchor'а.
  'quiet_page',
] as const;

export type HintLifecycleReason = typeof HINT_LIFECYCLE_REASONS[number];

export class HintLifecycleBodyDto {
  @IsOptional()
  @IsString()
  @IsIn(HINT_LIFECYCLE_REASONS as unknown as string[])
  reason?: HintLifecycleReason;
}
