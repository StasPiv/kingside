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
 * Стабильный fingerprint списка партий по `id:pgnLen` независимо от порядка
 * массива. Используется в polling-циклах, чтобы `setGames` не дёргался при
 * перестановке порядка от backend (только при реальном изменении пар).
 */
export function gamesFingerprint(
  games: readonly { id: string; pgn?: string | null }[],
): string {
  return games
    .map((g) => `${g.id}:${g.pgn?.length ?? 0}`)
    .sort()
    .join('|');
}
