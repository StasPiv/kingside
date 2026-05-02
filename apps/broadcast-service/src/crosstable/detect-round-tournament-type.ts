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
  /**
   * KS-1847: признак командного турнира (`Broadcast.team_table`).
   *
   * В team-форматах (Bundesliga, Team World Championship, TCEC Team) имя
   * раунда штатно содержит `final`/`championship`/`winners`/`losers`
   * как часть регламента — эти слова НЕ являются knockout-маркерами.
   * Плюс структурный сигнал `hasMatchStructure` даёт ложное срабатывание
   * при двухкруговке: команда A vs B играет одних и тех же игроков
   * дважды (белыми и чёрными) — это не playoff-матч, а обычный матч
   * командного round-robin.
   *
   * Значение `true` → применяем строгий whitelist
   * `STRICT_PLAYOFF_PATTERNS` и игнорируем `hasMatchStructure`.
   */
  isTeamTournament?: boolean;
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

/**
 * Строгий whitelist knockout-маркеров для команд-турниров (KS-1847).
 *
 * В team-форматах `finals/championship/winners/losers/grand final` —
 * часть обычного регламента (Bundesliga «Championship Round 5»,
 * Chess Olympiad «Winners Group»), поэтому для `isTeamTournament=true`
 * триггерим playoff только по маркерам, которые не встречаются в
 * team-контексте как нейтральные бренды: явные «play-off / knockout /
 * bracket / semi-/quarter-final / round of N / R\d+ / QF / SF / armageddon».
 *
 * Из индивидуального списка `PLAYOFF_NAME_PATTERNS` убраны:
 *   `finals?`, `grand final`, `championship`, `winners?`, `losers?`,
 *   `tie-?break` — могут быть частью team-регламента.
 *   Одиночная `F` — слишком широкое (`Final` само по себе неоднозначно
 *   в team-контексте).
 */
const STRICT_PLAYOFF_PATTERNS: RegExp[] = [
  /\bplay[- ]?offs?\b/i,
  /\bknock[- ]?out\b/i,
  /\bbracket\b/i,
  /\bsemi[- ]?final(?:s)?\b/i,
  /\bquarter[- ]?final(?:s)?\b/i,
  /\bround\s+of\s+\d+\b/i,
  /(?:^|[\s(|/-])R\d{1,3}(?=[\s)|/-]|$)/,
  /(?:^|[\s(|/])(?:QF|SF)(?:[\s)|/]|$)/,
  /\barmageddon\b/i,
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
 * Строгий матчинг по названию раунда — для командных турниров (KS-1847).
 * Видит только однозначные knockout-маркеры.
 */
function roundNameLooksLikePlayoffStrict(name: string): boolean {
  return STRICT_PLAYOFF_PATTERNS.some((re) => re.test(name));
}

/**
 * Итоговый детект. Порядок:
 *   1. playoff-сигналы — knockout-ключевики в названии ИЛИ структура
 *      «одни и те же пары в нескольких партиях» (≥ 2).
 *   2. Явный swiss в формате/названии → `swiss`.
 *   3. Явный round-robin → `round_robin`.
 *   4. `unknown` — fallback.
 *
 * Ключевая особенность: если есть структурный признак match-а, даже
 * при `format = "9-round Swiss"` считаем раунд плей-оффом — бывают
 * турниры, где Swiss-основа и knockout-финал объединены (пример в
 * тикете: «2026 Chess.com Open | Playoffs | Winners»).
 *
 * KS-1847: для командных турниров (`isTeamTournament=true`) применяется
 * строгий whitelist `STRICT_PLAYOFF_PATTERNS` (без `finals`/
 * `championship`/`winners`/`losers`/`grand_final`/tie-break — они часть
 * team-регламента, не knockout-маркеры), и игнорируется структурный
 * сигнал `hasMatchStructure` (двухкруговка между командами ложно
 * триггерила playoff).
 */
export function detectRoundTournamentType(
  input: DetectRoundInput,
): BroadcastRoundTournamentType {
  const name = (input.roundName ?? '').trim();
  const format = (input.broadcastFormat ?? '').trim();
  const games = input.games ?? [];
  const isTeam = input.isTeamTournament === true;

  const nameSaysPlayoff = isTeam
    ? roundNameLooksLikePlayoffStrict(name)
    : roundNameLooksLikePlayoff(name);
  // Для команд-турниров структурный сигнал отключён — см. доку к
  // `isTeamTournament` в `DetectRoundInput`.
  //
  // KS-2212: для явного round-robin формата структурный сигнал тоже
  // ненадёжен. Lichess создаёт placeholder-игры за день до тура, затем
  // новые lichessGameId для реальных партий — в итоге одна и та же пара
  // встречается ≥ 2 раз в `broadcast_games`, что вызывало ложное
  // `hasMatchStructure = true` → 'playoff' для обычных round-robin
  // туров (пример: Sigeman 2026, Round 2).
  // Если format явно указывает round-robin, доверяем ему, а не структуре.
  const formatIsRoundRobin = ROUND_ROBIN_PATTERN.test(format);
  const structureSaysMatch =
    !isTeam && !formatIsRoundRobin && hasMatchStructure(games);

  if (nameSaysPlayoff || structureSaysMatch) return 'playoff';

  // После плей-оффа идёт либо явный swiss/rr, либо unknown.
  // Критерий — любой из источников: название раунда или format.
  const combined = `${name} ${format}`;
  if (ROUND_ROBIN_PATTERN.test(combined)) return 'round_robin';
  if (SWISS_PATTERN.test(combined)) return 'swiss';
  return 'unknown';
}
