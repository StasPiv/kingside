import {
  loadHtml,
  findSection,
  parseIntLoose,
  parseNumberLoose,
  type ParseResult,
} from './parser-common';

/**
 * Парсер `art=2` для team-турниров (KS-1731, A06 part 3).
 *
 * Заголовок секции — `<h2>Team-Pairings of all rounds</h2>` (имя
 * совпадает для team-swiss и team-rr; chess-results показывает все туры
 * на одной странице).
 *
 * Структура `<table class="CRs1">`:
 *   - блок на тур: `<tr><td colspan="6">Round N on YYYY/MM/DD at HH:MM</td></tr>`
 *   - column-headers `<th>No.</th><th>Team</th><th>Team</th><th>Res.</th><th>:</th><th>Res.</th>`
 *   - data-rows: `No | TeamA | TeamB | scoreA | : | scoreB`
 *   - bye: `TeamA vs "bye" scoreA : (empty)`
 *
 * Возвращаем сырые pairings команд. Sync-service (A09) при необходимости
 * связывает с `parseTeamComposition` (rank команды и игроки).
 */

export interface RawTeamPair {
  /** Порядковый номер пары в туре (No. колонка). */
  no: number;
  teamA: string;
  teamB: string;
  /** Сумма очков по доскам команды A. null если не сыграно. */
  scoreA: number | null;
  /** Сумма по B. null для bye-пар (B == "bye") или не сыграно. */
  scoreB: number | null;
  /** true если одна сторона == "bye" (Wertungspunkt). */
  isBye: boolean;
}

export interface RawTeamRound {
  roundNumber: number;
  startsAt: string | null;
  pairs: RawTeamPair[];
}

export interface ParseTeamPairingsData {
  rounds: RawTeamRound[];
}

const H2_RE = /^Team-Pairings of all rounds$/i;
const ROUND_RE =
  /^Round\s+(\d+)\s+on\s+(\d{4}\/\d{2}\/\d{2})\s+at\s+(\S+(?:\s+[AP]M)?)/i;

export function parseTeamPairings(
  html: string,
): ParseResult<ParseTeamPairingsData> {
  const $ = loadHtml(html);
  const section = findSection($, (text) => H2_RE.test(text));
  if (!section) {
    return { ok: false, reason: 'h2 "Team-Pairings of all rounds" not found' };
  }
  const table = section.find('table.CRs1').first();
  if (!table.length) {
    return { ok: false, reason: 'table.CRs1 not found' };
  }

  const rounds: RawTeamRound[] = [];
  let current: RawTeamRound | null = null;
  let cols: { noIdx: number; teamAIdx: number; teamBIdx: number; resAIdx: number; resBIdx: number } | null = null;

  table.find('tr').each((_, rowEl) => {
    const $row = $(rowEl);
    const cls = $row.attr('class') ?? '';
    if (/CR(n)?g1b/.test(cls)) {
      // Round-header: один <td colspan="6"> с текстом "Round N on …".
      const td = $row.children('td').first();
      const colspan = td.attr('colspan');
      if (td.length && colspan && Number.parseInt(colspan, 10) > 1) {
        const text = td.text().trim().replace(/\s+/g, ' ');
        const m = ROUND_RE.exec(text);
        if (m) {
          const roundNumber = Number.parseInt(m[1], 10);
          const startsAt = parseStartsAt(m[2], m[3]);
          current = { roundNumber, startsAt, pairs: [] };
          rounds.push(current);
          cols = null; // обновится на следующей <th>-строке.
        }
        return;
      }
      // Column-headers.
      const ths = $row.children('th');
      if (ths.length) {
        const labels: string[] = [];
        ths.each((_, el) => {
          labels.push($(el).text().trim());
        });
        // Ожидаем 6 колонок, но обрабатываем устойчиво.
        // No. — индекс 0, Team — 1 (A), Team — 2 (B), Res. — 3, ":" — 4, Res. — 5.
        // Если что-то иначе — fallback по позициям.
        cols = {
          noIdx: labels.findIndex((l) => /^No\.?$/i.test(l)),
          teamAIdx: labels.findIndex((l, i) => /^team$/i.test(l) && i === labels.indexOf(l)),
          teamBIdx: labels.findIndex(
            (l, i) =>
              /^team$/i.test(l) && i !== labels.findIndex((m) => /^team$/i.test(m)),
          ),
          resAIdx: labels.findIndex(
            (l, i) =>
              /^Res\.?$/i.test(l) && i === labels.findIndex((m) => /^Res\.?$/i.test(m)),
          ),
          resBIdx: labels.findIndex(
            (l, i) =>
              /^Res\.?$/i.test(l) && i !== labels.findIndex((m) => /^Res\.?$/i.test(m)),
          ),
        };
        // Если что-то ушло в -1, fallback на фиксированные позиции.
        if (
          cols.noIdx < 0 ||
          cols.teamAIdx < 0 ||
          cols.teamBIdx < 0 ||
          cols.resAIdx < 0 ||
          cols.resBIdx < 0
        ) {
          cols = { noIdx: 0, teamAIdx: 1, teamBIdx: 2, resAIdx: 3, resBIdx: 5 };
        }
      }
      return;
    }

    // Data-row.
    if (!current || !cols) return;
    const cells = $row.children('td');
    if (!cells.length) return;
    const no = parseIntLoose(cells.eq(cols.noIdx).text().trim());
    if (no === null) return;
    const teamA = cells.eq(cols.teamAIdx).text().trim();
    const teamB = cells.eq(cols.teamBIdx).text().trim();
    if (!teamA || !teamB) return;
    const scoreA = parseNumberLoose(cells.eq(cols.resAIdx).text().trim());
    const scoreB = parseNumberLoose(cells.eq(cols.resBIdx).text().trim());
    const isBye = teamA.toLowerCase() === 'bye' || teamB.toLowerCase() === 'bye';
    current.pairs.push({ no, teamA, teamB, scoreA, scoreB, isBye });
  });

  if (rounds.length === 0) {
    return { ok: false, reason: 'no Round blocks parsed' };
  }
  return { ok: true, data: { rounds } };
}

function parseStartsAt(dateRaw: string, timeRaw: string): string | null {
  const dm = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(dateRaw);
  if (!dm) return null;
  const [, y, mm, d] = dm;
  let hours = 0;
  let minutes = 0;
  const ampm = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(timeRaw);
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(timeRaw);
  if (ampm) {
    hours = Number.parseInt(ampm[1], 10) % 12;
    if (/PM/i.test(ampm[3])) hours += 12;
    minutes = Number.parseInt(ampm[2], 10);
  } else if (h24) {
    hours = Number.parseInt(h24[1], 10);
    minutes = Number.parseInt(h24[2], 10);
  } else {
    return null;
  }
  return `${y}-${mm}-${d}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
}
