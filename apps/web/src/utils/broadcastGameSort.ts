import type { BroadcastGameSummary } from '@kingside/shared';

/**
 * KS-2446: жёсткая сортировка партий тура трансляции по фамилии белых A→Z
 * (locale-aware, sensitivity 'base'). Lichess отдаёт `whitePlayer` в формате
 * «Фамилия, Имя», поэтому прямой `localeCompare` уже эквивалентен сортировке
 * по фамилии. Tiebreak: blackPlayer (для тёзок) → id (стабильный fallback).
 * Партии без whitePlayer уходят в конец.
 *
 * Источник «прыжков» — backend пересортировывает список при обновлении одной
 * партии. Стабильный порядок держим только во frontend перед рендером.
 *
 * Дженерик, чтобы можно было сортировать как полный `BroadcastGameSummary`,
 * так и упрощённую структуру внутри `BroadcastTournamentPage` (KS-2447) —
 * нужны только id + whitePlayer + blackPlayer.
 */
export function sortGamesByWhite<
  G extends Pick<BroadcastGameSummary, 'id' | 'whitePlayer' | 'blackPlayer'>,
>(games: readonly G[]): G[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', usage: 'sort' });
  return [...games].sort((a, b) => {
    const aw = a.whitePlayer ?? '';
    const bw = b.whitePlayer ?? '';
    if (!aw && !bw) return 0;
    if (!aw) return 1;
    if (!bw) return -1;
    const byWhite = collator.compare(aw, bw);
    if (byWhite !== 0) return byWhite;
    const ab = a.blackPlayer ?? '';
    const bb = b.blackPlayer ?? '';
    const byBlack = collator.compare(ab, bb);
    if (byBlack !== 0) return byBlack;
    return a.id.localeCompare(b.id);
  });
}

/**
 * KS-4893: сортировка партий по времени последнего хода — самые свежие
 * первыми. `lastMoveAt` на клиентском потоке обновляется в момент
 * прихода нового хода (KS-4889, `guardStaleSnapshot`), поэтому порядок
 * живой: доска с последним ходом поднимается наверх.
 *
 * Партии без `lastMoveAt` (не начались / нет данных) — в конец.
 * Tiebreak — порядок по фамилии белых (`sortGamesByWhite`-компаратор),
 * чтобы при равных временах порядок был детерминированным.
 */
export function sortGamesByLastMove<
  G extends Pick<
    BroadcastGameSummary,
    'id' | 'whitePlayer' | 'blackPlayer' | 'lastMoveAt'
  >,
>(games: readonly G[]): G[] {
  const byWhite = sortGamesByWhite(games);
  return [...byWhite].sort((a, b) => {
    const at = a.lastMoveAt ? Date.parse(a.lastMoveAt) : NaN;
    const bt = b.lastMoveAt ? Date.parse(b.lastMoveAt) : NaN;
    const aOk = Number.isFinite(at);
    const bOk = Number.isFinite(bt);
    if (aOk && bOk) return bt - at; // свежие первыми
    if (aOk) return -1;
    if (bOk) return 1;
    return 0; // оба без времени — стабильный порядок byWhite (sort стабилен)
  });
}

/**
 * Стабильный fingerprint списка партий независимо от порядка массива.
 * Триггерит `setGames` при любом значимом изменении: PGN-длины
 * (новый ход), `result` (партия завершилась — KS-2715), `currentFen`
 * (board-state без роста PGN, например chess960-castling), и
 * `clockUpdatedAt` (KS-2700, обновление часов без хода — например
 * шахматные часы добавили инкремент в комментарий PGN).
 *
 * Поле `id` опционально: WS-payload иногда без него (см. KS-2710);
 * fallback по парам игроков для стабильного ключа.
 */
export function gamesFingerprint(
  games: readonly {
    id?: string;
    whitePlayer?: string | null;
    blackPlayer?: string | null;
    pgn?: string | null;
    result?: string | null;
    currentFen?: string | null;
    clockUpdatedAt?: string | null;
  }[],
): string {
  return games
    .map((g) => {
      const key = g.id ?? `${g.whitePlayer ?? '?'}|${g.blackPlayer ?? '?'}`;
      return [
        key,
        g.pgn?.length ?? 0,
        g.result ?? '*',
        g.currentFen ?? '',
        g.clockUpdatedAt ?? '',
      ].join('::');
    })
    .sort()
    .join('|');
}
