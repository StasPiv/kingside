/**
 * KS-4698 / ADR-147 §6.2. Локальный тип-augmentation для User —
 * backend (KS-4697) уже отдаёт поле `analyticsConsent`, но
 * `packages/shared` ещё не обновлён под новый ADR-flow. Используем
 * локальный wrapper, чтобы не плодить `as any` по компонентам.
 */
import type { User } from '@kingside/shared';

export type UserWithConsent = User & {
  /** `true` — дал согласие; `false` — отозвал; `null|undefined` — решение не принято. */
  analyticsConsent?: boolean | null;
};

export function getUserConsent(user: User | null): boolean | null {
  if (!user) return null;
  const value = (user as UserWithConsent).analyticsConsent;
  if (value === true) return true;
  if (value === false) return false;
  return null;
}
