/**
 * Детект типа турнира на уровне **раунда** (KS-1813).
 *
 * Источники:
 *   1. Название раунда (`BroadcastRound.name`, например «Playoffs | Winners»
 *      или «Round 5»).
 *   2. Формат всего броадкаста (`Broadcast.format` — «9-round Swiss»,
 *      «16-team round-robin» и т. п.).
 *   3. Структура пар по играм: если одни и те же два игрока сыграли ≥ 2
 *      партии в рамках одного раунда, и таких матчей ≤ половины игр —
 *      это plеy-off (knockout / match-format).
 *
 * Значения: `'round_robin' | 'swiss' | 'playoff' | 'unknown'`.
 * Фронт (сетка — KS-1814) ждёт именно `'playoff'`. Другие типы
 * рендерятся как обычные раунды.
 *
 * Чистая функция — без внешних зависимостей и без БД.
 */

import type { BroadcastRoundTournamentType } from '@kingside/shared';

export interface DetectRoundInput {
  /** `BroadcastRound.name`. */
  roundName: string;
  /** `Broadcast.format` (или null, если не пришёл с Lichess). */
  broadcastFormat?: string | null;
  /**
   * Пары игроков в раунде. Порядок пары не важен — классификатор
   * нормализует через сортировку внутри пары. Пустой массив допустим
   * (раунд ещё без партий — детект идёт только по названию/формату).
   */
  games?: Array<{ whitePlayer: string | null; blackPlayer: string | null }>;
}

// Ключевые слова knockout-раундов. Собраны по практике Lichess/Chess.com/
// chess-results (Winners/Losers Bracket — это Chess.com Open).
const PLAYOFF_NAME_PATTERNS: RegExp[] = [
  /\bplay[- ]?offs?\b/i,
  /\bknock[- ]?out\b/i,
  /\bbracket\b/i,
  /\bwinners?\b/i,
  /\blosers?\b/i,
  /\bgrand\s+final\b/i,
  // «Final» само по себе в «Round 5 / Final day» бывает неоднозначным —
  // матчим только как слово, не в составе «Final round».
  /\bfinals?\b/i,
  /\bchampionship\b/i,
  /\bsemi[- ]?final(?:s)?\b/i,
  /\bquarter[- ]?final(?:s)?\b/i,
  /\bround\s+of\s+\d+\b/i,
  // Сокращения: `R16 Armageddon`, `R32`, `R8` — Chess.com-стайл именования
  // раундов knockout-сетки. Матч — на границе слова / с разделителями.
  /(?:^|[\s(|/-])R\d{1,3}(?=[\s)|/-]|$)/,
  /(?:^|[\s(|/])(?:QF|SF|F)(?:[\s)|/]|$)/, // abbreviations (case-sensitive — аббревиатуры всегда заглавными)
  // Armageddon — тай-брейк формат, встречается в именах раундов knockout
  // (Chess.com Open, FIDE Grand Prix). Само по себе — сигнал playoff.
  /\barmageddon\b/i,
  // Тай-брейк между двумя игроками пары (Chess.com / Champions Chess Tour)
  // — тоже playoff-контекст.
  /\btie[- ]?break(?:s|er|ers)?\b/i,
];

const SWISS_PATTERN = /\bswiss\b/i;
const ROUND_ROBIN_PATTERN = /\bround[- ]?robin\b/i;

/**
 * Нормализует имя игрока для сравнения пар. Lichess иногда возвращает
 * разные написания одного игрока (FIDE title/без), но в рамках одного
 * раунда имена стабильны, так что хватит lowercase + trim.
 */
function normalizePlayer(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Канонический ключ пары — лексикографически отсортированная склейка
 * нормализованных имён, чтобы перестановка white/black в разных партиях
 * пары ложилась в одну группу.
 */
export function pairKey(a: string | null, b: string | null): string {
  const na = normalizePlayer(a);
  const nb = normalizePlayer(b);
  if (!na || !nb) return '';
  return na <= nb ? `${na}|${nb}` : `${nb}|${na}`;
}

/**
 * Частота пар в наборе игр. Возвращает map `pairKey -> count`. Пустые
 * имена (null/empty) исключаются.
 */
export function countPairs(
  games: Array<{ whitePlayer: string | null; blackPlayer: string | null }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of games) {
    const key = pairKey(g.whitePlayer, g.blackPlayer);
    if (!key) continue;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Структурный сигнал «играют несколько партий между одними и теми же
 * игроками» — характерно для knockout-матчей. Возвращает true, если
 * хотя бы одна пара встречается ≥ 2 раз.
 */
export function hasMatchStructure(
  games: Array<{ whitePlayer: string | null; blackPlayer: string | null }>,
): boolean {
  const pairs = countPairs(games);
  for (const count of pairs.values()) {
    if (count >= 2) return true;
  }
  return false;
}

/**
 * Матчинг по названию раунда. Регулярки не анкерятся — «Playoffs | Winners»
 * ловится одной из альтернатив.
 */
function roundNameLooksLikePlayoff(name: string): boolean {
  return PLAYOFF_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * Итоговый детект. Порядок:
 *   1. playoff-сигналы — роднит knockout-ключевики в названии ИЛИ
 *      структура «одни и те же пары в нескольких партиях» (≥ 2).
 *   2. Явный swiss в формате/названии → `swiss`.
 *   3. Явный round-robin → `round_robin`.
 *   4. `unknown` — fallback.
 *
 * Ключевая особенность: если есть структурный признак match-а, даже
 * при `format = "9-round Swiss"` считаем раунд плей-оффом — бывают
 * турниры, где Swiss-основа и knockout-финал объединены (пример в
 * тикете: «2026 Chess.com Open | Playoffs | Winners»).
 */
export function detectRoundTournamentType(
  input: DetectRoundInput,
): BroadcastRoundTournamentType {
  const name = (input.roundName ?? '').trim();
  const format = (input.broadcastFormat ?? '').trim();
  const games = input.games ?? [];

  const nameSaysPlayoff = roundNameLooksLikePlayoff(name);
  const structureSaysMatch = hasMatchStructure(games);
  if (nameSaysPlayoff || structureSaysMatch) return 'playoff';

  // После плей-оффа идёт либо явный swiss/rr, либо unknown.
  // Критерий — любой из источников: название раунда или format.
  const combined = `${name} ${format}`;
  if (ROUND_ROBIN_PATTERN.test(combined)) return 'round_robin';
  if (SWISS_PATTERN.test(combined)) return 'swiss';
  return 'unknown';
}
