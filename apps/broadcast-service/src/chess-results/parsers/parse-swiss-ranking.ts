import {
  loadHtml,
  findSection,
  findDataRows,
  detectColumns,
  extractPlayer,
  parseIntLoose,
  parseNumberLoose,
  type ParseResult,
  type CheerioRoot,
  type CheerioCollection,
} from './parser-common';
import type { CrosstablePlayer } from '@kingside/shared';

/**
 * Парсер `art=1` ranking-страницы swiss-турнира (KS-1730, A05 part 1).
 *
 * Заголовок секции — `<h2>Rank after Round N</h2>` (N — последний сыгранный
 * тур; для не-стартовавшего турнира N=0 — это edge-case, см. fallback в
 * §2.9.1 ADR-023). Структура `class="CRs1"`:
 *
 *   Rk. | SNo | (флаг) | Title | Name | Typ | sex | FED | RtgI | Club/City | Pts. | TB1 | … | TBn
 *
 * (Может слегка варьироваться: некоторые турниры скрывают `Typ`, `sex`,
 * `Club/City`. Мы используем `detectColumns` для устойчивого маппинга по
 * label'ам header'а.)
 *
 * `roundCount` извлекается из h2 (`Rank after Round N`).
 *
 * Возврат:
 *   - `{ ok: true, data: { players, roundCount } }`.
 *   - `{ ok: false, reason }` при h2-несовпадении или пустой таблице.
 *     Round 0 (турнир ещё не стартовал) — допустимый случай: возвращаем
 *     `players` со стартовым рейтингом и `roundCount=0`. Sync-service сам
 *     решит — отдавать ли пустой crosstable или fallback.
 */

export interface ParseSwissRankingData {
  players: CrosstablePlayer[];
  /** Число туров, по которым уже есть данные (0 для не-стартовавшего). */
  roundCount: number;
  /**
   * Имена tiebreak-колонок в порядке появления (TB1..TBN). Пишем в
   * `CrosstablePlayer.tiebreaks` под этими ключами. Для прода фронт может
   * отображать только нужные.
   */
  tiebreakLabels: string[];
}

const H2_RE = /^Rank after Round (\d+)$/i;

export function parseSwissRanking(
  html: string,
): ParseResult<ParseSwissRankingData> {
  const $ = loadHtml(html);
  let roundCount = 0;
  const section = findSection($, (text) => {
    const m = H2_RE.exec(text);
    if (!m) return false;
    roundCount = Number.parseInt(m[1], 10);
    return true;
  });
  if (!section) {
    return {
      ok: false,
      reason: 'h2 "Rank after Round N" not found',
    };
  }
  const table = section.find('table.CRs1').first();
  if (!table.length) {
    return { ok: false, reason: 'table.CRs1 not found inside section' };
  }
  const headerRow = table.find('tr.CRg1b, tr.CRng1b').first();
  if (!headerRow.length) {
    return { ok: false, reason: 'header row not found' };
  }
  const headerCells = headerRow.find('th');
  const cols = detectColumns(headerCells);
  if (!cols) {
    return {
      ok: false,
      reason: 'cannot detect required columns (No./Rk./Name)',
    };
  }

  // TB-колонки: всё что после `Pts.` и имеет лейбл `TB\d+` (case-insensitive).
  const tbInfo = pickTiebreaks(headerCells, $);

  const dataRows = findDataRows($, table);
  const players: CrosstablePlayer[] = [];
  dataRows.each((_, rowEl) => {
    const $row = $(rowEl);
    const cells = $row.find('td');
    if (!cells.length) return;
    const player = extractPlayer($, cells, cols);
    if (!player) return;
    if (tbInfo.length) {
      const tiebreaks: Record<string, number> = {};
      for (const tb of tbInfo) {
        const v = parseNumberLoose(cells.eq(tb.colIdx).text().trim());
        if (v !== null) tiebreaks[tb.label] = v;
      }
      if (Object.keys(tiebreaks).length) {
        player.tiebreaks = tiebreaks;
      }
    }
    players.push(player);
  });

  if (players.length === 0) {
    return { ok: false, reason: 'no data rows parsed' };
  }

  return {
    ok: true,
    data: {
      players,
      roundCount,
      tiebreakLabels: tbInfo.map((t) => t.label),
    },
  };
}

interface TiebreakColumn {
  colIdx: number;
  label: string;
}

function pickTiebreaks(
  headerCells: CheerioCollection,
  $: CheerioRoot,
): TiebreakColumn[] {
  const out: TiebreakColumn[] = [];
  headerCells.each((_, el) => {
    const idx = headerCells.index(el);
    const text = $(el).text().trim();
    const m = /^TB(\d+)$/i.exec(text);
    if (m) {
      out.push({ colIdx: idx, label: `tb${m[1]}` });
    }
  });
  return out;
}

/**
 * Удобный re-export для caller'ов, которым нужен round-int отдельно
 * (например, sync-service логирует «обработали turn N»).
 */
export function extractRoundCountFromH2(h2Text: string): number | null {
  const m = H2_RE.exec(h2Text.trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const n = parseIntLoose(m[1]);
  return n;
}
