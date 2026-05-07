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
  /**
   * `Broadcast.format` (или null, если не пришёл с Lichess). Алиас
   * `tournamentFormat` для совместимости с явной семантикой «формат
   * турнира» (KS-2474). Если переданы оба — приоритет у
   * `tournamentFormat`.
   */
  broadcastFormat?: string | null;
  /**
   * KS-2474: явный формат турнира (тот же `Broadcast.format`, но с
   * именем, отражающим семантику высшего приоритета). Если содержит
   * однозначные маркеры (`Swiss`, `Round Robin`, `Knockout`,
   * `Single-/Double-elimination`), эвристика по названию раунда не
   * перебивает его. Алиас для `broadcastFormat`.
   */
  tournamentFormat?: string | null;
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
 * Строгий whitelist knockout-маркеров для команд-турниров (KS-1847)
 * и для случаев, когда явный формат турнира противоречит мягкой
 * эвристике имени (KS-2474).
 *
 * В team-форматах `finals/championship/winners/losers/grand final` —
 * часть обычного регламента (Bundesliga «Championship Round 5»,
 * Chess Olympiad «Winners Group»), поэтому для `isTeamTournament=true`
 * триггерим playoff только по маркерам, которые не встречаются в
 * team-контексте как нейтральные бренды: явные «play-off / knockout /
 * bracket / semi-/quarter-final / round of N / R\d+ / QF / SF / armageddon».
 *
 * Тот же набор используется в шаге 2 общего детектора (KS-2474):
 * только эти маркеры могут перебить явный `Swiss` / `Round Robin`
 * формат — слабые сигналы вроде `\bfinals?\b` не должны переписывать
 * швейцарку (трансляция «Sardinia Open A», «9-round Swiss» с раундом
 * «Final Round»).
 *
 * Из индивидуального списка `PLAYOFF_NAME_PATTERNS` убраны:
 *   `finals?`, `grand final`, `championship`, `winners?`, `losers?`,
 *   `tie-?break` — могут быть частью team-регламента или швейцарки.
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
 * KS-2474: маркеры явного knockout-формата на уровне всего турнира.
 * Lichess/chess-results выдают такие строки в `tour.format`:
 *   «Knockout», «Single-elimination», «Double-elimination»,
 *   «Swiss-Knockout» (Champions Chess Tour). При наличии любого из
 *   них в `tournamentFormat`/`broadcastFormat` детектор без оглядок
 *   возвращает `playoff` — этот сигнал согласован со структурой
 *   knockout-сетки и должен иметь высший приоритет.
 *
 * `Elimination` (без префикса) в практике встречается только как
 * часть `single-/double-elimination`, поэтому `\belimination\b`
 * достаточно покрывает оба варианта.
 */
const KNOCKOUT_FORMAT_PATTERN =
  /\b(?:knock[- ]?out|elimination|single[- ]?elim|double[- ]?elim)\b/i;

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
 * Строгий матчинг по названию раунда — для командных турниров (KS-1847)
 * и для override явного формата (KS-2474).
 */
function roundNameLooksLikePlayoffStrict(name: string): boolean {
  return STRICT_PLAYOFF_PATTERNS.some((re) => re.test(name));
}

/**
 * Итоговый детект (порядок применения):
 *
 *   1. **Явный knockout-формат** (`tournamentFormat`/`broadcastFormat`
 *      содержит `Knockout`/`elimination`) → `playoff` без оглядки на
 *      имя. Lichess/chess-results проставляют это поле осознанно —
 *      доверяем больше любых других сигналов (KS-2474).
 *
 *   2. **Strict knockout-маркеры в имени** (`Playoffs`, `Knockout`,
 *      `Bracket`, `Semi-/Quarter-final`, `Round of N`, `R\d+`, `QF`/
 *      `SF`, `Armageddon`) → `playoff`. Эти однозначные ключевики
 *      перебивают даже явный Swiss/Round Robin формат — встречаются
 *      смешанные турниры (Chess.com Open: Swiss-фаза + knockout-фаза).
 *
 *   3. **Структурный сигнал** «одни и те же пары в нескольких партиях»
 *      → `playoff`. Отключён для team-турниров (KS-1847) и для явного
 *      round-robin формата (KS-2212), где Lichess создаёт placeholder-
 *      игры, ложно триггерящие сигнал.
 *
 *   4. **Явный Swiss/Round Robin формат** → `swiss`/`round_robin`
 *      (KS-2474). Перебивает мягкие маркеры в имени (`Final Round`,
 *      `Championship Day`, `Winners Group`, `Tiebreak`) — Lichess
 *      выдаёт «9-round Swiss» осознанно для всей трансляции.
 *
 *   5. **Полный whitelist в имени** (`Final`, `Championship`,
 *      `Winners`, `Losers`, `Grand Final`, `Tiebreak`) — старая
 *      эвристика. Применяется только для одиночных турниров
 *      (`isTeamTournament !== true`) и только если до 4 шага мы
 *      не приняли решения. Для team — strict whitelist в шаге 2 уже
 *      исчерпывает knockout-маркеры.
 *
 *   6. **Swiss/Round Robin в имени** → `swiss`/`round_robin` (если
 *      формат пуст).
 *
 *   7. `unknown` — fallback.
 */
export function detectRoundTournamentType(
  input: DetectRoundInput,
): BroadcastRoundTournamentType {
  const name = (input.roundName ?? '').trim();
  // KS-2474: `tournamentFormat` имеет приоритет над `broadcastFormat`,
  // если переданы оба. По смыслу — одно и то же поле, новый алиас
  // вводится только для семантической ясности в callsite-ах.
  const format = (
    input.tournamentFormat ??
    input.broadcastFormat ??
    ''
  ).trim();
  const games = input.games ?? [];
  const isTeam = input.isTeamTournament === true;

  // 1. Явный knockout-формат имеет высший приоритет.
  if (KNOCKOUT_FORMAT_PATTERN.test(format)) return 'playoff';

  // 2. Strict knockout-маркеры в имени перебивают любой формат
  // (смешанные турниры: Swiss + knockout-финал, Chess.com Open).
  if (roundNameLooksLikePlayoffStrict(name)) return 'playoff';

  // 3. Структурный сигнал. Отключён для team (KS-1847) и для явного
  // round-robin (KS-2212) или Swiss формата (KS-2474 hotfix).
  // Lichess создаёт placeholder-партии за день до раунда, и одна и та
  // же пара может встречаться ≥ 2 раз (placeholder + реальная игра).
  // Это ложно триггерит structureSaysMatch=true и перебивает явный
  // формат — Sardinia Open A Round 1 классифицировалась как playoff
  // несмотря на «9-round Swiss» в title. Для смешанных Swiss+knockout
  // турниров knockout-стадия ловится strict-маркерами в имени (шаг 2).
  const formatIsRoundRobin = ROUND_ROBIN_PATTERN.test(format);
  const formatIsSwiss = SWISS_PATTERN.test(format);
  const structureSaysMatch =
    !isTeam &&
    !formatIsRoundRobin &&
    !formatIsSwiss &&
    hasMatchStructure(games);
  if (structureSaysMatch) return 'playoff';

  // 4. Явный Swiss/RR формат перебивает мягкие маркеры имени
  // (KS-2474: «Final Round» в «9-round Swiss» — это всё ещё швейцарка).
  if (formatIsRoundRobin) return 'round_robin';
  if (formatIsSwiss) return 'swiss';

  // 5. Полный whitelist в имени — только для одиночных турниров.
  // Для team шаг 2 (strict) — единственный источник playoff.
  if (!isTeam && roundNameLooksLikePlayoff(name)) return 'playoff';

  // 6. Swiss/RR в имени (формата нет).
  if (ROUND_ROBIN_PATTERN.test(name)) return 'round_robin';
  if (SWISS_PATTERN.test(name)) return 'swiss';

  return 'unknown';
}
