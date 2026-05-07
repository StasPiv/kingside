/**
 * KS-2477 — сортировка `players[]` в `CrosstableResponse` по убыванию
 * очков с tiebreak'ом и пересборка `matrix` / `pairings` под новый
 * порядок.
 *
 * Корневая причина бага (Latvijas čempionāts): chess-results art=5
 * (round-robin crosstable) отдаёт игроков в порядке `parseRrCrosstable`
 * (по стартовой нумерации chess-results) — без сортировки по очкам.
 * Фронт рендерит таблицу как есть, и пользователь видит лидера на 5-м
 * месте.
 *
 * Алгоритм:
 *   1. Снимок oldRank → oldIdx и oldIdx → oldRank.
 *   2. Tiebreak score per игрок:
 *      - round-robin: Sonneborn-Berger по matrix (sum точек оппонентов
 *        по победам + 0.5 × по ничьим). Если в players[] уже есть
 *        `tiebreaks.sonnebornBerger` — берём его как готовое значение.
 *      - swiss: первый из `tiebreaks.{buchholz, sonnebornBerger, tb1,
 *        tb2}`; если ничего — 0.
 *      - team-*: сортируем `teams[]` по points DESC (rank).
 *   3. Stable sort по `(points DESC, tiebreak DESC, oldRank ASC)`.
 *   4. Перенумерация `rank = newIdx + 1`.
 *   5. Reorder matrix / pairings + обновление `opponentRank` в ячейках
 *      через `oldRank → newRank` mapping.
 *
 * Pure-функция: возвращает новый объект, исходный не мутирует.
 */

import type {
  CrosstableCell,
  CrosstablePlayer,
  CrosstableResponse,
  CrosstableRoundRobin,
  CrosstableSwiss,
  CrosstableTeam,
  CrosstableTeamEntry,
} from '@kingside/shared';

interface IndexEntry {
  oldIdx: number;
  oldRank: number;
  points: number;
  tiebreak: number;
}

/**
 * Считает Sonneborn-Berger по строке матрицы для round-robin.
 * Игнорирует ячейки с `opponentRank == null` (невалидные / диагональ).
 */
function computeSonnebornBerger(
  rowIdx: number,
  matrix: CrosstableCell[][],
  players: ReadonlyArray<CrosstablePlayer>,
): number {
  let sb = 0;
  const row = matrix[rowIdx] ?? [];
  for (const cell of row) {
    if (cell.opponentRank == null) continue;
    // opponentRank — позиция в players (1-based в исходном порядке).
    const oppIdx = cell.opponentRank - 1;
    const oppPts = players[oppIdx]?.points ?? 0;
    if (cell.result === 'win') sb += oppPts;
    else if (cell.result === 'draw') sb += 0.5 * oppPts;
  }
  return Math.round(sb * 100) / 100;
}

/**
 * Извлекает tiebreak-скор для Swiss из `players[i].tiebreaks`. Берёт
 * первый ненулевой ключ из приоритетного списка. Если нет — 0.
 */
function extractSwissTiebreak(p: CrosstablePlayer): number {
  const tb = p.tiebreaks ?? {};
  const keys = ['buchholz', 'sonnebornBerger', 'tb1', 'tb2', 'tb3'];
  for (const k of keys) {
    const v = tb[k];
    if (typeof v === 'number') return v;
  }
  return 0;
}

function sortRoundRobin(response: CrosstableRoundRobin): CrosstableRoundRobin {
  const { players, matrix } = response;
  const N = players.length;
  if (N === 0) return response;

  const entries: IndexEntry[] = players.map((p, oldIdx) => ({
    oldIdx,
    oldRank: p.rank,
    points: p.points,
    tiebreak:
      p.tiebreaks?.sonnebornBerger ?? computeSonnebornBerger(oldIdx, matrix, players),
  }));

  // Stable sort: points DESC, tiebreak DESC, oldRank ASC.
  entries.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.tiebreak !== a.tiebreak) return b.tiebreak - a.tiebreak;
    return a.oldRank - b.oldRank;
  });

  const newOrder = entries.map((e) => e.oldIdx);
  const oldRankToNewRank = new Map<number, number>();
  entries.forEach((e, newIdx) => {
    oldRankToNewRank.set(e.oldRank, newIdx + 1);
  });

  const newPlayers = newOrder.map((oldIdx, newIdx) => ({
    ...players[oldIdx],
    rank: newIdx + 1,
  }));

  const newMatrix: CrosstableCell[][] = newOrder.map((oldI) =>
    newOrder.map((oldJ) => remapCell(matrix[oldI]?.[oldJ], oldRankToNewRank)),
  );

  return {
    ...response,
    players: newPlayers,
    matrix: newMatrix,
  };
}

function sortSwiss(response: CrosstableSwiss): CrosstableSwiss {
  const { players, pairings } = response;
  const N = players.length;
  if (N === 0) return response;

  const entries: IndexEntry[] = players.map((p, oldIdx) => ({
    oldIdx,
    oldRank: p.rank,
    points: p.points,
    tiebreak: extractSwissTiebreak(p),
  }));

  entries.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.tiebreak !== a.tiebreak) return b.tiebreak - a.tiebreak;
    return a.oldRank - b.oldRank;
  });

  const newOrder = entries.map((e) => e.oldIdx);
  const oldRankToNewRank = new Map<number, number>();
  entries.forEach((e, newIdx) => {
    oldRankToNewRank.set(e.oldRank, newIdx + 1);
  });

  const newPlayers = newOrder.map((oldIdx, newIdx) => ({
    ...players[oldIdx],
    rank: newIdx + 1,
  }));

  const newPairings: CrosstableCell[][] = newOrder.map((oldI) =>
    (pairings[oldI] ?? []).map((cell) => remapCell(cell, oldRankToNewRank)),
  );

  return {
    ...response,
    players: newPlayers,
    pairings: newPairings,
  };
}

function sortTeam(response: CrosstableTeam): CrosstableTeam {
  const { players, teams } = response;

  // Players внутри team-турнира сортируем по points DESC + rank ASC,
  // tiebreak'ов на уровне игроков обычно нет.
  const newPlayers = [...players].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.rank - b.rank;
  });
  newPlayers.forEach((p, i) => (p.rank = i + 1));

  const newTeams = sortTeamsByPoints(teams);

  return {
    ...response,
    players: newPlayers,
    teams: newTeams,
  };
}

function sortTeamsByPoints(
  teams: CrosstableTeamEntry[],
): CrosstableTeamEntry[] {
  const sorted = [...teams].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.rank - b.rank;
  });
  return sorted.map((t, i) => ({ ...t, rank: i + 1 }));
}

function remapCell(
  cell: CrosstableCell | undefined,
  oldRankToNewRank: Map<number, number>,
): CrosstableCell {
  if (!cell) return { result: null };
  if (cell.opponentRank == null) return cell;
  const newOppRank = oldRankToNewRank.get(cell.opponentRank) ?? cell.opponentRank;
  return { ...cell, opponentRank: newOppRank };
}

/**
 * Главный экспорт: сортирует CrosstableResponse по убыванию очков с
 * tiebreak'ом, пересобирает матрицу / pairings под новый порядок.
 * Idempotent — повторный вызов не меняет результат.
 *
 * Для `tournamentType='unknown'` (CrosstableLegacy) — no-op (там нет
 * matrix/pairings, а players приходят из buildLegacyPlayersFromGames
 * уже отсортированными).
 */
export function sortCrosstableByPoints(
  response: CrosstableResponse,
): CrosstableResponse {
  switch (response.tournamentType) {
    case 'round-robin':
      return sortRoundRobin(response);
    case 'swiss':
      return sortSwiss(response);
    case 'team-swiss':
    case 'team-round-robin':
      return sortTeam(response);
    case 'unknown':
      return response;
  }
}
