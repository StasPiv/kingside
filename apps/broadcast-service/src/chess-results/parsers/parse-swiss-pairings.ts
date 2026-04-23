import {
  loadHtml,
  findSection,
  findDataRows,
  parseIntLoose,
  parseNumberLoose,
  type ParseResult,
  type CheerioRoot,
  type CheerioCollection,
} from './parser-common';
import { normalizePlayerName } from '../../crosstable/player-matcher';

/**
 * Парсер `art=2` pairings/results swiss-турнира (KS-1730, A05 part 2).
 *
 * Заголовок секции — `<h2>Pairings/Results</h2>`. Внутри секции — несколько
 * `<h3>Round N on YYYY/MM/DD at HH:MM</h3>` блоков, каждый с собственной
 * таблицей `class="CRs1"`. Chess-results на одной art=2-странице обычно
 * отдаёт **только текущий + следующий тур** (не все туры, как может
 * показаться по тикету); чтобы получить все, sync-service запрашивает
 * `art=2&rd=K` отдельно на каждый тур (ADR-023 §2.5 «по запросу»).
 *
 * Парсер возвращает **сырые** pairings в `RawSwissRound[]`. Финальная
 * `CrosstableCell[][]` shape строится в sync-service (A09), который
 * объединяет pairings со standings (rank → name mapping) и нашими
 * broadcast_games (через `composeGameRefs`).
 *
 * Колонки `<table>`:
 *   Bo. | (флаг) | Title | White | Typ | Rtg | Club | Pts. | Result | Pts. |
 *        (флаг) | Title | Black | Typ | Rtg | Club | (?) | PGN
 *
 * `White` / `Black` — `<a href="...&snr=N">Name</a>`. SNo (стартовый номер)
 * извлекается из href — это стабильный ID игрока в рамках турнира.
 * Парсер возвращает `snr` + `name` (rank рассчитывается caller'ом по
 * sync standings).
 *
 * `Result` — `1-0` / `0-1` / `½-½` / `1` / `0` / `½` / пусто (тур ещё не
 * сыгран). У chess-results format'е иногда два числа: white-points и
 * black-points в отдельных колонках вокруг `Result`. Мы берём `Result`-
 * колонку как нормализованную истину.
 *
 * `not paired` — игрок без пары на этот тур (получил bye / withdraw).
 */

export interface RawSwissPlayer {
  /** Стартовый номер (SNo), извлечён из `href ...snr=N`. */
  snr: number | null;
  /** Имя как пришло из chess-results. */
  name: string;
  /** Нормализованное имя — для матчинга с broadcast_games. */
  normalizedName: string;
  rating: number | null;
  title: string | null;
}

export interface RawSwissPair {
  board: number;
  white: RawSwissPlayer | null;
  black: RawSwissPlayer | null;
  /** `'win' | 'loss' | 'draw'` с точки зрения белого. `null` если не сыграно. */
  result: 'win' | 'loss' | 'draw' | null;
  /** true если в строке есть `bye`/`not paired`-маркер. */
  isBye: boolean;
}

export interface RawSwissRound {
  roundNumber: number;
  /** ISO-строка starts_at, либо null если не распарсилось. */
  startsAt: string | null;
  pairs: RawSwissPair[];
}

export interface ParseSwissPairingsData {
  rounds: RawSwissRound[];
}

const H2_PREDICATE = (text: string): boolean =>
  /^Pairings\/Results$/i.test(text);

const ROUND_RE = /^Round\s+(\d+)\s+on\s+(\S+)\s+at\s+(\S+(?:\s+[AP]M)?)/i;

export function parseSwissPairings(
  html: string,
): ParseResult<ParseSwissPairingsData> {
  const $ = loadHtml(html);
  const section = findSection($, H2_PREDICATE);
  if (!section) {
    return { ok: false, reason: 'h2 "Pairings/Results" not found' };
  }

  // Каждый Round = h3 + следующий за ним table.CRs1. Идём по детям div'а
  // и собираем пары (h3, table).
  const rounds: RawSwissRound[] = [];
  const children = section.children();
  for (let i = 0; i < children.length; i++) {
    const el = children.eq(i);
    if (el.is('h3')) {
      const headerText = el.text().trim().replace(/\s+/g, ' ');
      const m = ROUND_RE.exec(headerText);
      if (!m) continue;
      const roundNumber = Number.parseInt(m[1], 10);
      const startsAt = parseRoundStartsAt(m[2], m[3]);
      // Следующий sibling-table — наша.
      let table: CheerioCollection | null = null;
      for (let j = i + 1; j < children.length; j++) {
        const next = children.eq(j);
        if (next.is('table.CRs1')) {
          table = next;
          break;
        }
        if (next.is('h3')) break; // следующий round без таблицы — пропускаем
      }
      if (!table) continue;
      const pairs = parsePairsFromTable($, table);
      rounds.push({ roundNumber, startsAt, pairs });
    }
  }

  if (rounds.length === 0) {
    return { ok: false, reason: 'no Round h3+table sections found' };
  }

  return { ok: true, data: { rounds } };
}

function parseRoundStartsAt(
  dateRaw: string,
  timeRaw: string,
): string | null {
  // chess-results format: "2026/04/24" + "09:00 AM" / "02:30 PM" / "14:00".
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(dateRaw.trim());
  if (!m) return null;
  const [, y, mm, d] = m;
  let hours = 0;
  let minutes = 0;
  const tt = timeRaw.trim();
  const ampm = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(tt);
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(tt);
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
  const iso =
    `${y}-${mm}-${d}T${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:00`;
  // Не указываем часовой пояс — chess-results local time, sync-service
  // знает турнирный TZ (или принимает как «без таймзоны»).
  return iso;
}

function parsePairsFromTable(
  $: CheerioRoot,
  table: CheerioCollection,
): RawSwissPair[] {
  const headerRow = table.find('tr.CRng1b, tr.CRg1b').first();
  if (!headerRow.length) return [];
  // Локализуем индексы колонок по заголовку (case-insensitive).
  // Note: header содержит и `<th>` и `<td>` (chess-results смешивает),
  // выбираем все.
  const headerCells = headerRow.children('th, td');
  const labels: string[] = [];
  headerCells.each((_, el) => {
    labels.push($(el).text().trim().toLowerCase());
  });

  const findIdx = (predicate: (s: string) => boolean): number => {
    for (let i = 0; i < labels.length; i++) {
      if (predicate(labels[i])) return i;
    }
    return -1;
  };
  const boardIdx = findIdx((s) => s === 'bo.' || s === 'bo');
  const resultIdx = findIdx((s) => s === 'result');
  const whiteIdx = findIdx((s) => s === 'white');
  const blackIdx = findIdx((s) => s === 'black');
  if (boardIdx < 0 || whiteIdx < 0 || blackIdx < 0) return [];

  // Title-колонки и Rtg-колонки — относительно white/black-name.
  // Эвристика: title — `<th></th>` непосредственно перед Name; rtg — после.
  const whiteTitleIdx =
    whiteIdx > 0 && labels[whiteIdx - 1] === '' ? whiteIdx - 1 : -1;
  const blackTitleIdx =
    blackIdx > 0 && labels[blackIdx - 1] === '' ? blackIdx - 1 : -1;
  // Rtg-колонка — следующая после white-name (пропуская Typ, если есть).
  const whiteRtgIdx = findRtgAfter(labels, whiteIdx);
  const blackRtgIdx = findRtgAfter(labels, blackIdx);

  const dataRows = findDataRows($, table);
  const pairs: RawSwissPair[] = [];
  dataRows.each((_, rowEl) => {
    const $row = $(rowEl);
    const cells = $row.find('td');
    if (!cells.length) return;
    const board = parseIntLoose(cells.eq(boardIdx).text().trim());
    if (board === null) return;

    const white = extractPairPlayer(
      $,
      cells,
      whiteIdx,
      whiteTitleIdx,
      whiteRtgIdx,
    );
    const black = extractPairPlayer(
      $,
      cells,
      blackIdx,
      blackTitleIdx,
      blackRtgIdx,
    );

    let result: 'win' | 'loss' | 'draw' | null = null;
    if (resultIdx >= 0) {
      const raw = cells.eq(resultIdx).text().trim();
      result = parseResultText(raw);
    }
    const isBye =
      (black?.name ?? '').toLowerCase().includes('not paired') ||
      (white?.name ?? '').toLowerCase().includes('not paired') ||
      (black?.name ?? '').toLowerCase() === 'bye' ||
      (white?.name ?? '').toLowerCase() === 'bye';

    pairs.push({
      board,
      white: white && !isPlaceholder(white.name) ? white : null,
      black: black && !isPlaceholder(black.name) ? black : null,
      result,
      isBye,
    });
  });
  return pairs;
}

function isPlaceholder(name: string): boolean {
  const s = name.toLowerCase().trim();
  return s === '' || s === 'not paired' || s === 'bye';
}

function findRtgAfter(labels: string[], from: number): number {
  for (let i = from + 1; i < labels.length; i++) {
    if (/^rtg/.test(labels[i])) return i;
  }
  return -1;
}

function extractPairPlayer(
  $: CheerioRoot,
  cells: CheerioCollection,
  nameIdx: number,
  titleIdx: number,
  rtgIdx: number,
): RawSwissPlayer | null {
  const cell = cells.eq(nameIdx);
  if (!cell.length) return null;
  const name = cell.text().trim();
  if (!name) return null;
  // SNo из href: ...snr=N
  const href = cell.find('a').attr('href') ?? '';
  const snrMatch = /[?&]snr=(\d+)/.exec(href);
  const snr = snrMatch ? Number.parseInt(snrMatch[1], 10) : null;
  const title =
    titleIdx >= 0 ? (cells.eq(titleIdx).text().trim() || null) : null;
  const rating =
    rtgIdx >= 0 ? parseIntLoose(cells.eq(rtgIdx).text().trim()) : null;
  return {
    snr,
    name,
    normalizedName: normalizePlayerName(name),
    rating,
    title,
  };
}

/**
 * `Result`-текст → `'win' | 'loss' | 'draw' | null` (с точки зрения белого).
 *   - `1` / `1-0` / `1 - 0` → win.
 *   - `0` / `0-1` / `0 - 1` → loss.
 *   - `½` / `½-½` / `½ - ½` / `1/2-1/2` → draw.
 *   - пусто / unknown → null.
 */
function parseResultText(raw: string): 'win' | 'loss' | 'draw' | null {
  const t = raw.trim().replace(/\s+/g, '');
  if (t === '' || t === '\u00a0') return null;
  if (t === '1' || t === '1-0') return 'win';
  if (t === '0' || t === '0-1') return 'loss';
  if (t === '½' || t === '½-½' || t === '1/2-1/2' || t === '0,5-0,5')
    return 'draw';
  return null;
}
