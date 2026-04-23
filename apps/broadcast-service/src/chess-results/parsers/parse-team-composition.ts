import {
  loadHtml,
  findSection,
  parseIntLoose,
  parseNumberLoose,
  parseCellResult,
  type ParseResult,
  type CheerioRoot,
  type CheerioCollection,
} from './parser-common';
import { normalizePlayerName } from '../../crosstable/player-matcher';
import type { CrosstablePlayer } from '@kingside/shared';

/**
 * Парсер `art=1` для team-турниров (KS-1731, A06 part 2).
 *
 * Заголовок секции — `<h2>Team-Composition with round-results</h2>`.
 * Внутри `<table class="CRs1">` — последовательность блоков, каждый для
 * одной команды:
 *   1. `<tr class="CRg1b"><td colspan="17">  N. <Team Name> (RtgAvg:..., TB1:..., TB2:...)</td></tr>`
 *   2. `<tr class="CRg1b">` с `<th>` — заголовки колонок:
 *      `Bo. | Title | Name | Rtg | FED | FideID | Gr | Typ | 1 | … | K | Pts. | Games | RtgAvg`.
 *   3. Несколько `<tr class="CRg1|CRg2">` — игроки команды.
 *
 * Парсер возвращает `players: CrosstablePlayer[]` с правильным `team`-полем
 * и `teams: TeamMeta[]` (rank+name+points). Sync-service использует teams
 * для финального `CrosstableTeam.teams`, а players — для
 * `CrosstableTeam.players`.
 */

export interface TeamMeta {
  rank: number;
  name: string;
  /** Сырое: первый из tiebreak'ов из header'а команды (обычно match-points). */
  points: number;
  /** RtgAvg — средний рейтинг команды (для UI tooltip). */
  ratingAvg: number | null;
}

export interface ParseTeamCompositionData {
  teams: TeamMeta[];
  players: CrosstablePlayer[];
}

const H2_RE = /^Team-Composition\s+with\s+round-results$/i;

// «1. Chongqing (RtgAvg:2569, TB1: 8 / TB2: 59)» → {rank, name, ratingAvg, tb1}.
const TEAM_HEADER_RE =
  /^\s*(\d+)\.\s+(.+?)\s*\((?:RtgAvg:\s*(\d+))?(?:[,\s]*TB1:\s*([\d,.]+))?/i;

export function parseTeamComposition(
  html: string,
): ParseResult<ParseTeamCompositionData> {
  const $ = loadHtml(html);
  const section = findSection($, (text) => H2_RE.test(text));
  if (!section) {
    return {
      ok: false,
      reason: 'h2 "Team-Composition with round-results" not found',
    };
  }
  const table = section.find('table.CRs1').first();
  if (!table.length) {
    return { ok: false, reason: 'table.CRs1 not found' };
  }

  const teams: TeamMeta[] = [];
  const players: CrosstablePlayer[] = [];

  // Идём по всем `<tr>` подряд и интерпретируем по содержимому.
  // Состояние: `currentTeam` (последняя «прочитанная» команда) и
  // `currentColMap` (для player-строк: индексы Bo./Name/Rtg/FED/FideID/Pts./Games/RtgAvg).
  let currentTeam: TeamMeta | null = null;
  let currentColMap: TeamPlayerCols | null = null;

  table.find('tr').each((_, rowEl) => {
    const $row = $(rowEl);
    const cls = $row.attr('class') ?? '';

    // Header-строки — class CRg1b/CRng1b. Их два типа: team-block-header
    // (один <td colspan="17">) и column-headers (несколько <th>).
    if (/CR(n)?g1b/.test(cls)) {
      const tdSingle = $row.children('td').first();
      const colspan = tdSingle.attr('colspan');
      if (tdSingle.length && colspan && Number.parseInt(colspan, 10) > 1) {
        // Team-block-header.
        const text = tdSingle.text().trim().replace(/\s+/g, ' ');
        const m = TEAM_HEADER_RE.exec(text);
        if (m) {
          const rank = Number.parseInt(m[1], 10);
          const name = m[2].trim();
          const ratingAvg = m[3] ? Number.parseInt(m[3], 10) : null;
          const points = m[4] ? parseFloatLoose(m[4]) ?? 0 : 0;
          currentTeam = { rank, name, points, ratingAvg };
          teams.push(currentTeam);
          // Column-map обновится на следующей `CRg1b` строке (с <th>).
          currentColMap = null;
        }
        return;
      }
      // Column-headers (with <th>).
      const ths = $row.children('th');
      if (ths.length) {
        const labels: string[] = [];
        ths.each((_, el) => {
          labels.push($(el).text().trim());
        });
        currentColMap = detectTeamPlayerColumns(labels);
      }
      return;
    }

    // Data-row.
    if (!currentTeam || !currentColMap) return;
    const cells = $row.children('td');
    if (!cells.length) return;
    const player = extractTeamPlayer($, cells, currentColMap, currentTeam.name);
    if (player) players.push(player);
  });

  if (teams.length === 0) {
    return { ok: false, reason: 'no team blocks parsed' };
  }

  return { ok: true, data: { teams, players } };
}

interface TeamPlayerCols {
  boardIdx: number;
  titleIdx: number | null;
  nameIdx: number;
  ratingIdx: number | null;
  fedIdx: number | null;
  fideIdIdx: number | null;
  pointsIdx: number | null;
  gamesIdx: number | null;
  /** Индексы round-cell'ов (1, 2, ..., K). */
  roundIdxs: number[];
}

function detectTeamPlayerColumns(labels: string[]): TeamPlayerCols | null {
  const findIdx = (predicate: (s: string) => boolean): number | null => {
    for (let i = 0; i < labels.length; i++) {
      if (predicate(labels[i])) return i;
    }
    return null;
  };
  const lower = labels.map((l) => l.toLowerCase());

  const boardIdx = findIdx((s) => s.toLowerCase() === 'bo.' || s.toLowerCase() === 'bo');
  const nameIdx = findIdx((s) => s.toLowerCase() === 'name');
  const ratingIdx = findIdx((s) => /^rtg(?:avg)?$/i.test(s));
  // RtgAvg исключаем (это последняя колонка), берём первый match.
  const ratingIdxStrict = findIdx((s) => /^rtg$/i.test(s) || /^rtgi$/i.test(s));
  const fedIdx = findIdx((s) => s.toLowerCase() === 'fed' || s.toLowerCase() === 'fed.');
  const fideIdIdx = findIdx((s) => /^fide\s*id$/i.test(s));
  const pointsIdx = findIdx((s) => s.toLowerCase() === 'pts.' || s.toLowerCase() === 'pts');
  const gamesIdx = findIdx((s) => s.toLowerCase() === 'games');

  if (boardIdx === null || nameIdx === null) return null;

  // Title — пустой `<th></th>` непосредственно перед Name.
  const titleIdx = nameIdx > 0 && lower[nameIdx - 1] === '' ? nameIdx - 1 : null;
  // Round-cells — лейблы `1`..`K` между fideId/Gr/Typ и Pts.
  const roundIdxs: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (/^\d+$/.test(labels[i])) roundIdxs.push(i);
  }

  return {
    boardIdx,
    titleIdx,
    nameIdx,
    ratingIdx: ratingIdxStrict ?? ratingIdx,
    fedIdx,
    fideIdIdx,
    pointsIdx,
    gamesIdx,
    roundIdxs,
  };
}

function extractTeamPlayer(
  $: CheerioRoot,
  cells: CheerioCollection,
  cols: TeamPlayerCols,
  teamName: string,
): CrosstablePlayer | null {
  const at = (i: number | null): string => {
    if (i === null) return '';
    const c = cells.eq(i);
    return c.length ? c.text().trim() : '';
  };

  const board = parseIntLoose(at(cols.boardIdx));
  if (board === null) return null;
  const name = at(cols.nameIdx);
  if (!name) return null;
  const elo = cols.ratingIdx !== null ? parseIntLoose(at(cols.ratingIdx)) : null;
  const title = cols.titleIdx !== null ? at(cols.titleIdx) || undefined : undefined;
  const fed =
    cols.fedIdx !== null ? at(cols.fedIdx) || undefined : undefined;
  const fideId =
    cols.fideIdIdx !== null ? at(cols.fideIdIdx) || undefined : undefined;
  const points =
    cols.pointsIdx !== null ? parseNumberLoose(at(cols.pointsIdx)) ?? 0 : 0;

  // gamesPlayed: явная колонка ИЛИ считаем непустые round-cells.
  let gamesPlayed: number;
  if (cols.gamesIdx !== null) {
    gamesPlayed = parseIntLoose(at(cols.gamesIdx)) ?? 0;
  } else {
    let g = 0;
    for (const ri of cols.roundIdxs) {
      const parsed = parseCellResult(at(ri));
      if (parsed.score !== null) g++;
    }
    gamesPlayed = g;
  }

  return {
    rank: board,
    name,
    normalizedName: normalizePlayerName(name),
    federation: fed,
    elo: elo ?? undefined,
    title: title || undefined,
    fideId: fideId || undefined,
    points,
    gamesPlayed,
    team: teamName,
  };
}

function parseFloatLoose(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
