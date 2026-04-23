import type {
  CrosstablePlayer,
  CrosstableGameRef,
} from '@kingside/shared';

/**
 * Сопоставление chess-results.com ↔ `broadcast_games` (KS-1732, ADR-023 §2.6).
 *
 * Pure-функции: никакого DI, никакого Prisma — типы входных данных
 * объявлены structurally (`BroadcastGameInput`, `BroadcastRoundInput`),
 * чтобы матчер можно было тестировать на простых литералах и переиспользовать
 * вне sync-сервиса (например, в crosstable-builder'е A09).
 *
 * Метрики публикуются через инжектированный интерфейс `MatcherMetrics` —
 * pure-функции не знают про prom-client, тесты подставляют jest-fake.
 *
 * **Почему не FIDE ID:** `BroadcastGame` хранит только строки имён
 * (whitePlayer/blackPlayer) — Lichess в PGN тэги `WhiteFideId`/`BlackFideId`
 * кладёт **непостоянно** (часть broadcasts с FIDE ID, часть — без). Добавлять
 * колонки в `broadcast_games` — отдельная задача, вне scope v1 (ADR-023 §1.3).
 *
 * **Стратегия матчинга** (по приоритету):
 *   1. Точное совпадение `normalizedName`. Для chess-results-стороны имя уже
 *      нормализовано в `CrosstablePlayer.normalizedName` — index'им по нему.
 *   2. При множественных матчах (однофамильцы) — дизамбигуация по Elo: ищем
 *      ближайшего в пределах ±50 (ADR §2.6). Если у нашей game `Elo=null`
 *      или нет игроков в окне — берём первого из матчей и публикуем
 *      `crosstable_ambiguous_match_total`.
 *   3. Fallback: substring по фамилии (для PGN-тэгов вида `"Carlsen"` без
 *      имени). Если в chess-results-стороне ровно один игрок с такой
 *      фамилией — match. Иначе — `null` + `crosstable_unmatched_player_total`.
 *   4. Полный мисс — `null` + `crosstable_unmatched_player_total`.
 *
 * **Перестановка `"Last, First"` ↔ `"First Last"`:** chess-results часто
 * отдаёт `"Carlsen, Magnus"`, а Lichess в PGN — `"Magnus Carlsen"`. До
 * нормализации мы детектим запятую и переставляем токены, чтобы оба
 * варианта свелись к одинаковому `"magnus carlsen"`.
 */

export interface BroadcastGameInput {
  id: string;
  whitePlayer: string | null;
  blackPlayer: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  roundId: string;
}

export interface BroadcastRoundInput {
  id: string;
  name: string;
  startsAt: Date | null;
}

/**
 * Минимальный поверхностный интерфейс метрик. Production использует
 * prom-client Counter, тесты подставляют jest-fake. Не используем prom
 * напрямую — pure-функции не должны знать про регистры.
 */
export interface MatcherMetrics {
  /** Несколько матчей, выбран первый (или ближайший по Elo, fallback). */
  recordAmbiguousMatch(opts: { reason: 'no-elo' | 'elo-out-of-range' }): void;
  /** Игрок в нашей game есть, в chess-results — нет. */
  recordUnmatchedPlayer(opts: { side: 'white' | 'black' }): void;
}

/** No-op метрики для случаев, когда инструментирование не нужно (тесты простых случаев). */
export const NOOP_METRICS: MatcherMetrics = {
  recordAmbiguousMatch: () => {},
  recordUnmatchedPlayer: () => {},
};

/**
 * Базовая нормализация имени игрока:
 *   - NFD-разложение и удаление combining-marks (диакритика → латиница);
 *   - lowercase;
 *   - удаление всего, кроме [a-z0-9 ,];
 *   - схлопывание whitespace в один пробел;
 *   - trim.
 *
 * Forma `"Last, First"` → `"First Last"`: если в строке ровно одна запятая,
 * меняем местами head/tail. Это согласовано с chess-results (отдают
 * `"Carlsen, Magnus"`) и Lichess PGN (отдаёт `"Magnus Carlsen"`).
 */
export function normalizePlayerName(raw: string | null | undefined): string {
  if (!raw) return '';
  // Перестановка "Last, First" → "First Last" до нормализации, чтобы запятая
  // ещё была видна.
  const trimmed = raw.trim();
  const commaIdx = trimmed.indexOf(',');
  let preNormalized = trimmed;
  if (commaIdx > 0 && trimmed.indexOf(',', commaIdx + 1) === -1) {
    const last = trimmed.slice(0, commaIdx).trim();
    const first = trimmed.slice(commaIdx + 1).trim();
    if (last && first) {
      preNormalized = `${first} ${last}`;
    }
  }
  return preNormalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Извлекает фамилию из normalized-формы имени. Используется для substring-
 * fallback'а: PGN иногда содержит только `"Carlsen"` без имени.
 *
 * Эвристика: после `normalizePlayerName` запятая снята, имя обычно
 * `"first ... last"`. Берём последний токен — это фамилия в большинстве
 * случаев. Для односложных имён (`"madonna"`) — возвращаем как есть.
 */
function extractLastName(normalized: string): string {
  if (!normalized) return '';
  const parts = normalized.split(' ');
  return parts[parts.length - 1] ?? '';
}

/**
 * Результат сопоставления одной партии: rank'и из `chess-results`-таблицы
 * для обеих сторон. `null` — игрок не найден.
 */
export interface MatchResult {
  whiteRank: number | null;
  blackRank: number | null;
}

interface MatchOneResult {
  rank: number | null;
  reason?: 'no-elo' | 'elo-out-of-range';
}

/**
 * Сопоставляет одного игрока (имя + опциональный Elo) с chess-results-таблицей.
 * Возвращает rank или null + причину для метрики.
 */
function matchOne(
  rawName: string | null | undefined,
  rawElo: number | null,
  byNormalized: Map<string, CrosstablePlayer[]>,
  byLastName: Map<string, CrosstablePlayer[]>,
): MatchOneResult {
  const norm = normalizePlayerName(rawName);
  if (!norm) return { rank: null };

  const exact = byNormalized.get(norm);
  if (exact && exact.length === 1) {
    return { rank: exact[0].rank };
  }
  if (exact && exact.length > 1) {
    // Дизамбигуация по Elo. Если нашего Elo нет — берём первого + метрика.
    if (rawElo == null) {
      return { rank: exact[0].rank, reason: 'no-elo' };
    }
    let best: CrosstablePlayer | null = null;
    let bestDelta = Infinity;
    for (const cand of exact) {
      const elo = cand.elo;
      if (elo == null) continue;
      const delta = Math.abs(elo - rawElo);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = cand;
      }
    }
    if (best && bestDelta <= 50) {
      return { rank: best.rank };
    }
    // Все за пределами окна → берём первого + метрика.
    return { rank: exact[0].rank, reason: 'elo-out-of-range' };
  }

  // Fallback: substring по фамилии. Полезно для PGN-тэгов вида "Carlsen".
  const lastName = extractLastName(norm);
  if (lastName) {
    const byLast = byLastName.get(lastName);
    if (byLast && byLast.length === 1) {
      return { rank: byLast[0].rank };
    }
  }

  return { rank: null };
}

/**
 * Главная функция матчинга. Принимает одну `BroadcastGame` и список
 * `CrosstablePlayer`'ов (всех игроков турнира с chess-results) — возвращает
 * rank'и обеих сторон или null.
 *
 * Метрики (через `MatcherMetrics`):
 *   - `recordAmbiguousMatch({reason})` — если несколько кандидатов и пришлось
 *     выбирать (no-elo / elo-out-of-range).
 *   - `recordUnmatchedPlayer({side})` — если ничего не подошло.
 */
export function matchGameToPlayers(
  game: Pick<
    BroadcastGameInput,
    'whitePlayer' | 'blackPlayer' | 'whiteElo' | 'blackElo'
  >,
  chessResultsPlayers: readonly CrosstablePlayer[],
  metrics: MatcherMetrics = NOOP_METRICS,
): MatchResult {
  // Индексы строим один раз. На N=300 игроков — копейки, но если matchGameToPlayers
  // зовётся в цикле по 100+ играм, лучше готовить индексы на стороне caller'а
  // (см. `composeGameRefs`, который индекс'ит один раз per-tournament).
  const byNormalized = new Map<string, CrosstablePlayer[]>();
  const byLastName = new Map<string, CrosstablePlayer[]>();
  for (const p of chessResultsPlayers) {
    const norm = p.normalizedName;
    const arr = byNormalized.get(norm);
    if (arr) arr.push(p);
    else byNormalized.set(norm, [p]);

    const last = extractLastName(norm);
    if (last && last !== norm) {
      const larr = byLastName.get(last);
      if (larr) larr.push(p);
      else byLastName.set(last, [p]);
    } else if (last === norm) {
      // Односложные — кладём только в byNormalized; substring'ом ничего не
      // улучшим.
    }
  }

  const w = matchOne(
    game.whitePlayer,
    game.whiteElo,
    byNormalized,
    byLastName,
  );
  const b = matchOne(
    game.blackPlayer,
    game.blackElo,
    byNormalized,
    byLastName,
  );

  if (w.reason) metrics.recordAmbiguousMatch({ reason: w.reason });
  if (b.reason) metrics.recordAmbiguousMatch({ reason: b.reason });
  if (w.rank == null && game.whitePlayer) {
    metrics.recordUnmatchedPlayer({ side: 'white' });
  }
  if (b.rank == null && game.blackPlayer) {
    metrics.recordUnmatchedPlayer({ side: 'black' });
  }

  return { whiteRank: w.rank, blackRank: b.rank };
}

/**
 * Парсит roundNumber из имени тура. Lichess отдаёт типичные имена вроде
 * `"Round 1"`, `"Round 12"`. Возвращаем целое число; null — если не удалось
 * распарсить (caller использует `round.name` как fallback-ключ).
 */
export function parseRoundNumber(roundName: string): number | null {
  const m = /(\d+)/.exec(roundName);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Composer: для всех `games` в трансляции собирает Map<key, GameRef>, где
 * key = `"${roundNumber}:${whiteRank}:${blackRank}"` (ADR-023 §2.6).
 *
 * Round-mapping:
 *   - Первичный — game.roundId → BroadcastRound (нужен на входе либо
 *     через `roundsById`, либо через `game.round`-связь Prisma).
 *   - `roundsByName` — обратный индекс: имя раунда → BroadcastRound. Нужен
 *     для случаев, когда mapping game→round строится не через id (например,
 *     при репликации данных из chess-results, где роунд знаем по имени).
 *
 * Сигнатура усилена: принимаем `roundsById` напрямую — выводить его из
 * `roundsByName` бессмысленно (caller всё равно делает один запрос
 * `prisma.broadcastRound.findMany({ where: { broadcastId } })`).
 *
 * `roundsByName` остаётся для будущего fallback (если game.roundId
 * отсутствует) — в v1 не используется, но соответствует контракту тикета
 * для будущих расширений.
 */
export function composeGameRefs(
  games: readonly BroadcastGameInput[],
  chessResultsPlayers: readonly CrosstablePlayer[],
  roundsById: ReadonlyMap<string, BroadcastRoundInput>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _roundsByName?: ReadonlyMap<string, BroadcastRoundInput>,
  metrics: MatcherMetrics = NOOP_METRICS,
): Map<string, CrosstableGameRef> {
  const refs = new Map<string, CrosstableGameRef>();
  for (const game of games) {
    const round = roundsById.get(game.roundId);
    if (!round) continue;
    const roundNumber = parseRoundNumber(round.name);
    // Если не парсится — используем имя как label-ключ (стабильность над
    // числами для нестандартных имён вроде "Final" / "TB1").
    const roundKey = roundNumber !== null ? String(roundNumber) : round.name;

    const m = matchGameToPlayers(game, chessResultsPlayers, metrics);
    if (m.whiteRank == null || m.blackRank == null) continue;

    const key = `${roundKey}:${m.whiteRank}:${m.blackRank}`;
    refs.set(key, {
      gameId: game.id,
      roundId: round.id,
      roundName: round.name,
    });
  }
  return refs;
}
