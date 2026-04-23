import {
  loadHtml,
  findSection,
  findDataRows,
  parseIntLoose,
  parseNumberLoose,
  type ParseResult,
} from './parser-common';
import type { CrosstableTeamEntry } from '@kingside/shared';

/**
 * Парсер `art=0` для team-турниров (KS-1731, A06 part 1).
 *
 * На chess-results `art=0` для team-турниров — это **рейтинг команд**.
 * Заголовок секции варьируется по типу турнира:
 *   - team-swiss: `<h2>Rank after Round N</h2>`, колонки
 *     `Rk. | SNo | Team | Games | + | = | - | TB1 | TB2 | TB3 | TB4 | TB5`.
 *     `+ / = / -` — wins / draws / losses; `TB1` обычно match-points,
 *     `TB2` board-points (зависит от tournament setup).
 *   - team-rr:    `<h2>Ranking crosstable (Pts.)</h2>` (или `(MP)`),
 *     колонки `Rk. | Team | 1 | 2 | … | N | TB1 | TB2 | TB3`. Это матрица
 *     N×N (где N=число команд) с board-points в ячейках, плюс tiebreaks.
 *     Команды извлекаем; саму матрицу для v1 не возвращаем — финальная
 *     shape `CrosstableTeam` (KS-1726) её не требует.
 *
 * Дисциплина диспетчинга: `parseTeamStandings` сам определяет вариант по
 * h2 и вызывает соответствующий sub-парсер.
 */

export interface ParseTeamStandingsData {
  teams: CrosstableTeamEntry[];
  /** Только для team-swiss; `null` для team-rr (там crosstable). */
  roundCount: number | null;
  /** `'team-swiss' | 'team-round-robin'` — для дальнейшего dispatch. */
  variant: 'team-swiss' | 'team-round-robin';
  /** Имена tiebreak-колонок (TB1..TBn). */
  tiebreakLabels: string[];
}

const SWISS_H2_RE = /^Rank after Round (\d+)$/i;
const RR_H2_RE = /^Ranking crosstable\s*\((Pts\.|MP)\)/i;

export function parseTeamStandings(
  html: string,
): ParseResult<ParseTeamStandingsData> {
  const $ = loadHtml(html);

  let variant: 'team-swiss' | 'team-round-robin' | null = null;
  let roundCount: number | null = null;
  const section = findSection($, (text) => {
    const swissMatch = SWISS_H2_RE.exec(text);
    if (swissMatch) {
      variant = 'team-swiss';
      roundCount = Number.parseInt(swissMatch[1], 10);
      return true;
    }
    if (RR_H2_RE.test(text)) {
      variant = 'team-round-robin';
      return true;
    }
    return false;
  });
  if (!section || !variant) {
    return {
      ok: false,
      reason:
        'h2 not matched (expected "Rank after Round N" for team-swiss or "Ranking crosstable (Pts.)" for team-rr)',
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
  const labels: string[] = [];
  headerCells.each((_, el) => {
    labels.push($(el).text().trim());
  });
  // localize columns: Rk., Team, Pts. (для swiss обычно нет — берём `+ / = / -`
  // как match-wins, или TB1 как match-points).
  const rkIdx = labels.findIndex((l) => /^Rk\.?$/i.test(l));
  const teamIdx = labels.findIndex((l) => /^team$/i.test(l));
  if (rkIdx < 0 || teamIdx < 0) {
    return { ok: false, reason: 'cannot locate Rk./Team columns' };
  }
  // Tiebreaks по labels TB1..TB_N (case-insensitive).
  const tiebreakCols: { idx: number; label: string }[] = [];
  for (let i = 0; i < labels.length; i++) {
    const m = /^TB(\d+)$/i.exec(labels[i]);
    if (m) tiebreakCols.push({ idx: i, label: `tb${m[1]}` });
  }

  // Team Pts. колонка: для team-swiss явной нет; традиция —
  // points = TB1 (match points). Для team-rr — Pts. отсутствует, очки
  // считаются как сумма board-points по строке, но shape только нужны
  // ranks + names + (оптимально) первый tiebreak. В простой реализации
  // points = первый TB ИЛИ 0.
  const teams: CrosstableTeamEntry[] = [];
  const dataRows = findDataRows($, table);
  dataRows.each((_, rowEl) => {
    const $row = $(rowEl);
    const cells = $row.find('td');
    if (!cells.length) return;
    const rank = parseIntLoose(cells.eq(rkIdx).text().trim());
    if (rank === null) return;
    const name = cells.eq(teamIdx).text().trim();
    if (!name) return;

    let points = 0;
    if (tiebreakCols.length > 0) {
      const v = parseNumberLoose(cells.eq(tiebreakCols[0].idx).text().trim());
      if (v !== null) points = v;
    }

    teams.push({ name, rank, points });
  });

  if (teams.length === 0) {
    return { ok: false, reason: 'no team rows parsed' };
  }

  return {
    ok: true,
    data: {
      teams,
      roundCount,
      variant,
      tiebreakLabels: tiebreakCols.map((t) => t.label),
    },
  };
}
