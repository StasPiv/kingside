/**
 * Detection типа турнира по `Broadcast.format` (KS-1727, ADR-023 §2.2.4).
 *
 * Источник истины — `Broadcast.format` (строка из Lichess: «9-round Swiss»,
 * «16-team round-robin», «9-round Swiss for teams» и т.п.) + опциональный
 * флаг `hasTeamTable` (`Broadcast.teamTable`, добавится отдельной задачей).
 *
 * v1 поддерживает 5 значений (ADR-023 §2.2.4 «v1 поддерживает» + KS-1725
 * §валидация Zod):
 *   - `swiss` — большинство опенов;
 *   - `round-robin` — элита (Candidates, Tata Steel Masters);
 *   - `team-swiss` — командная швейцарка (European Club Cup);
 *   - `team-round-robin` — командные round-robin (Bundesliga play-off);
 *   - `unknown` — fallback на legacy crosstable.
 *
 * v1.1 расширит enum (`knockout`, `match`, `scheveningen`,
 * `double-round-robin` как отдельный рендер) — отдельной задачей.
 *
 * Чистая функция, без внешних зависимостей. Импортируется из
 * `BroadcastSyncService` (для записи `tournamentType` в
 * `BroadcastStandings.tournamentType` при первом fetch'е) и из
 * crosstable-builder'а в endpoint'е `GET /broadcasts/:id/crosstable`.
 */

/**
 * Перечисление поддерживаемых типов турниров. Должно быть согласовано с
 * `TournamentType` из `@kingside/shared` (KS-1726) — после A02 импорт
 * перейдёт оттуда. Локальное определение здесь — чтобы детектор оставался
 * независимым от A02 (KS-1727 явно «не зависит от A01/A02 — чистая
 * логика»).
 */
export type TournamentType =
  | 'swiss'
  | 'round-robin'
  | 'team-swiss'
  | 'team-round-robin'
  | 'unknown';

export interface DetectInput {
  /** `Broadcast.format` — строка из Lichess `tour.info.format` или null. */
  format: string | null;
  /**
   * `Broadcast.teamTable` (опциональный, добавится в схему отдельным
   * тикетом). Если `true` — даже без `/team/i` в format, тип получает
   * префикс `team-`.
   */
  hasTeamTable?: boolean;
}

const TEAM_PATTERN = /team/i;
const SWISS_PATTERN = /swiss/i;
const ROUND_ROBIN_PATTERN = /round[- ]?robin/i;

/**
 * Маппит `format` (+ optional `hasTeamTable`) в `TournamentType`.
 *
 * Алгоритм (порядок матёров важен — team-варианты ловим первыми, иначе
 * «9-round Swiss for teams» съест чистый `swiss`):
 *   1. Если `format` пустой/null → `unknown`.
 *   2. Если есть team-сигнал (`/team/i` в format ИЛИ `hasTeamTable=true`):
 *      - `/round[- ]?robin/i` → `team-round-robin`;
 *      - `/swiss/i`           → `team-swiss`;
 *      - иначе                → `unknown` (team есть, но базовый формат
 *        неизвестный — knockout-team / match-team в v1.1).
 *   3. Без team-сигнала:
 *      - `/round[- ]?robin/i` → `round-robin` (включая «double round-robin»
 *        — отдельный рендер появится в v1.1, пока матрица та же);
 *      - `/swiss/i`           → `swiss`;
 *      - иначе                → `unknown` (Knockout, Match, Scheveningen,
 *        пустая строка и любой нераспознанный формат).
 */
export function detectTournamentType(input: DetectInput): TournamentType {
  const raw = input.format?.trim() ?? '';
  if (raw === '') return 'unknown';

  const isTeam = input.hasTeamTable === true || TEAM_PATTERN.test(raw);
  const isRoundRobin = ROUND_ROBIN_PATTERN.test(raw);
  const isSwiss = SWISS_PATTERN.test(raw);

  if (isTeam) {
    if (isRoundRobin) return 'team-round-robin';
    if (isSwiss) return 'team-swiss';
    return 'unknown';
  }

  if (isRoundRobin) return 'round-robin';
  if (isSwiss) return 'swiss';
  return 'unknown';
}
