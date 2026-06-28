/**
 * KS-4762 / ADR-150 T4. Общий тип фикстуры для hints-rules.e2e-spec.ts.
 *
 * Каждая фикстура — два сценария:
 *   - matches: при таком наборе events на этой page правило должно
 *     сматчиться (evaluateRule → true).
 *   - noMatch: ослаблено одно из условий → правило НЕ должно сматчиться
 *     (evaluateRule → false).
 *
 * actor генерируется suite'ом per-run (UUID), здесь только type
 * (user/guest). created_at для events задаётся через хелперы `daysAgo`,
 * `hoursAgo`, `minutesAgo`.
 */
export interface FixtureEvent {
  type: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

export interface FixtureScenario {
  events: FixtureEvent[];
  page: string;
}

export interface RuleFixture {
  /** ключ правила в БД */
  key: string;
  /** тип actor (user или guest) */
  actorType: 'user' | 'guest';
  /** matches-сценарий */
  matches: FixtureScenario;
  /** no-match сценарий */
  noMatch: FixtureScenario;
}

export function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

export function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
