/**
 * KS-1824: вычисление связей между парами плей-офф (advance / loser
 * links). Используется и при sync-цикле (пишем `advance_to_pair_id` /
 * `loser_to_pair_id` в `broadcast_games`), и в endpoint
 * `GET /broadcasts/:id/bracket` (формируется массив `links`).
 *
 * Алгоритм:
 *   1. Собираем уникальные пары из всех playoff-раундов броадкаста и
 *      классифицируем по side (`winners` | `losers` | `main` | `grand`)
 *      и «размеру стадии» (`round_of_N` → N, `quarter`=8, `semi`=4,
 *      `final`=2, `grand_final`=1, `grand_final_reset`=0).
 *   2. Для каждой side ≠ `grand`: упорядочиваем стадии от большей к
 *      меньшей. Пары внутри стадии сортируем лексикографически по
 *      `bracketPairId` (детерминированный порядок без внешней
 *      топологии), разбиваем на bucket'ы по 2. k-й bucket попадает в
 *      k-ю пару следующей стадии — это и есть `advanceToPairId`.
 *   3. Последняя стадия winners (finals) → grand_final, если есть.
 *      То же для последней стадии losers (finals) → grand_final.
 *      `grand_final` → `grand_final_reset`, если reset-пара есть.
 *   4. Для double-elimination: каждая пара `winners_<stage>` получает
 *      `loserToPairId` = пара `losers_<same size>` c тем же
 *      sortedIndex (упрощённая эвристика — Lichess не отдаёт реальную
 *      топологию, а порядок pairId стабилен по лексикографическому
 *      ключу).
 *
 * Ограничения:
 *   - Если на одной стадии число пар нечётное — последний лишний
 *     остаётся без `advanceToPairId` (правильно: он получает «автопроход»,
 *     но в реальных сетках такое встречается только в несимметричных
 *     турнирах; если понадобится — расширим отдельно).
 *   - Для winners→losers маппинг индекс-в-индекс — приближённый. Если
 *     пар разное количество — лишние winners-пары останутся без
 *     `loserToPairId`.
 *
 * Чистая функция, без БД.
 */

import type { BracketLink } from '@kingside/shared';

export interface PairInput {
  bracketPairId: string;
  bracketStage: string;
}

export interface ComputeAdvanceLinksResult {
  /** Map `bracketPairId` → поля для записи в `broadcast_games`. */
  byPair: Map<string, { advanceToPairId: string | null; loserToPairId: string | null }>;
  /**
   * Дедуплицированный список рёбер сетки. Удобно отдавать клиенту,
   * чтобы он не ловил повторы из `games[].advanceToPairId` по разным
   * партиям одной пары.
   */
  links: BracketLink[];
}

type Side = 'winners' | 'losers' | 'main' | 'grand';

interface PairMeta {
  bracketPairId: string;
  stage: string;
  side: Side;
  /** Размер стадии (см. `stageSize`). null — неизвестная стадия. */
  size: number | null;
}

/**
 * Маппинг stage → «размер». Чем больше — тем раньше в сетке.
 * `round_of_16`=16, `quarter`=8, `semi`=4, `final`=2, `grand_final`=1,
 * `grand_final_reset`=0.
 */
export function stageSize(stage: string): number | null {
  const m = stage.match(/round_of_(\d+)/);
  if (m) return parseInt(m[1], 10);
  if (stage === 'grand_final_reset') return 0;
  if (stage === 'grand_final') return 1;
  if (stage.endsWith('final')) return 2;
  if (stage.endsWith('semi')) return 4;
  if (stage.endsWith('quarter')) return 8;
  return null;
}

export function stageSide(stage: string): Side {
  if (stage === 'grand_final' || stage === 'grand_final_reset') return 'grand';
  if (stage.startsWith('winners')) return 'winners';
  if (stage.startsWith('losers')) return 'losers';
  return 'main';
}

export function computeAdvanceLinks(
  pairs: PairInput[],
): ComputeAdvanceLinksResult {
  // Уникальные пары + их meta.
  const metaByPair = new Map<string, PairMeta>();
  for (const p of pairs) {
    if (!p.bracketPairId || metaByPair.has(p.bracketPairId)) continue;
    metaByPair.set(p.bracketPairId, {
      bracketPairId: p.bracketPairId,
      stage: p.bracketStage,
      side: stageSide(p.bracketStage),
      size: stageSize(p.bracketStage),
    });
  }

  // Группируем по side.
  const bySide = new Map<Side, PairMeta[]>();
  for (const meta of metaByPair.values()) {
    const list = bySide.get(meta.side) ?? [];
    list.push(meta);
    bySide.set(meta.side, list);
  }

  const byPair = new Map<
    string,
    { advanceToPairId: string | null; loserToPairId: string | null }
  >();
  for (const id of metaByPair.keys()) {
    byPair.set(id, { advanceToPairId: null, loserToPairId: null });
  }
  const linksKeySet = new Set<string>();
  const links: BracketLink[] = [];

  function addLink(fromPairId: string, toPairId: string, kind: 'winner' | 'loser') {
    if (!fromPairId || !toPairId || fromPairId === toPairId) return;
    const key = `${kind}:${fromPairId}->${toPairId}`;
    if (linksKeySet.has(key)) return;
    linksKeySet.add(key);
    links.push({ fromPairId, toPairId, kind });
  }

  /**
   * Построить цепочку advance внутри одной side. Возвращает пары
   * финальной (наименьшей по size) стадии — их надо будет связать
   * с grand_final, если таковая есть.
   */
  function chainAdvance(side: Side): PairMeta[] {
    const list = bySide.get(side) ?? [];
    if (list.length === 0) return [];
    const bySize = new Map<number, PairMeta[]>();
    for (const meta of list) {
      if (meta.size === null) continue;
      const arr = bySize.get(meta.size) ?? [];
      arr.push(meta);
      bySize.set(meta.size, arr);
    }
    const sortedSizes = [...bySize.keys()].sort((a, b) => b - a); // desc
    for (const [size, arr] of bySize) {
      arr.sort((a, b) => a.bracketPairId.localeCompare(b.bracketPairId));
      bySize.set(size, arr);
    }
    for (let i = 0; i < sortedSizes.length - 1; i++) {
      const current = bySize.get(sortedSizes[i]) ?? [];
      const next = bySize.get(sortedSizes[i + 1]) ?? [];
      for (let j = 0; j < current.length; j++) {
        const bucket = Math.floor(j / 2);
        const target = next[bucket];
        if (!target) continue;
        byPair.get(current[j].bracketPairId)!.advanceToPairId = target.bracketPairId;
        addLink(current[j].bracketPairId, target.bracketPairId, 'winner');
      }
    }
    const lastSize = sortedSizes[sortedSizes.length - 1];
    return lastSize !== undefined ? (bySize.get(lastSize) ?? []) : [];
  }

  const winnersFinals = chainAdvance('winners');
  const losersFinals = chainAdvance('losers');
  const mainFinals = chainAdvance('main');

  // Grand final — объединяем хвосты winners и losers (если есть).
  const grandList = (bySide.get('grand') ?? [])
    .slice()
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const grandFinal = grandList.find((g) => g.stage === 'grand_final');
  const grandReset = grandList.find((g) => g.stage === 'grand_final_reset');

  if (grandFinal) {
    // Все финалисты winners и losers указывают на grand_final —
    // победитель финала идёт в grand.
    for (const m of winnersFinals) {
      byPair.get(m.bracketPairId)!.advanceToPairId = grandFinal.bracketPairId;
      addLink(m.bracketPairId, grandFinal.bracketPairId, 'winner');
    }
    for (const m of losersFinals) {
      byPair.get(m.bracketPairId)!.advanceToPairId = grandFinal.bracketPairId;
      addLink(m.bracketPairId, grandFinal.bracketPairId, 'winner');
    }
    // Одиночная сетка (main) — тоже финалом в grand_final, если есть.
    for (const m of mainFinals) {
      byPair.get(m.bracketPairId)!.advanceToPairId = grandFinal.bracketPairId;
      addLink(m.bracketPairId, grandFinal.bracketPairId, 'winner');
    }
    if (grandReset) {
      byPair.get(grandFinal.bracketPairId)!.advanceToPairId = grandReset.bracketPairId;
      addLink(grandFinal.bracketPairId, grandReset.bracketPairId, 'winner');
    }
  }

  // Double-elimination: winners_<stage> → losers_<same size> по индексу.
  const winnersList = bySide.get('winners') ?? [];
  const losersList = bySide.get('losers') ?? [];
  if (winnersList.length > 0 && losersList.length > 0) {
    const losersBySize = new Map<number, PairMeta[]>();
    for (const m of losersList) {
      if (m.size === null) continue;
      const arr = losersBySize.get(m.size) ?? [];
      arr.push(m);
      losersBySize.set(m.size, arr);
    }
    for (const arr of losersBySize.values()) {
      arr.sort((a, b) => a.bracketPairId.localeCompare(b.bracketPairId));
    }
    const winnersBySize = new Map<number, PairMeta[]>();
    for (const m of winnersList) {
      if (m.size === null) continue;
      const arr = winnersBySize.get(m.size) ?? [];
      arr.push(m);
      winnersBySize.set(m.size, arr);
    }
    for (const arr of winnersBySize.values()) {
      arr.sort((a, b) => a.bracketPairId.localeCompare(b.bracketPairId));
    }
    for (const [size, wArr] of winnersBySize) {
      const lArr = losersBySize.get(size) ?? [];
      for (let i = 0; i < wArr.length; i++) {
        const target = lArr[i];
        if (!target) continue;
        byPair.get(wArr[i].bracketPairId)!.loserToPairId = target.bracketPairId;
        addLink(wArr[i].bracketPairId, target.bracketPairId, 'loser');
      }
    }
  }

  return { byPair, links };
}
