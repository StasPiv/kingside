/**
 * KS-4492. Сборка PGN-строки для открытия задачи Critical Moment в
 * мастерской по тому же контракту, что и /precision (см. PrecisionAttemptPage
 * `buildAttemptPgn`).
 *
 * До KS-4492 переход «Открыть в анализе» из Critical Moment передавал
 * только `?fen=<puzzleFen>` в URL. Это работало (AnalysisPage умеет
 * стартовать с FEN), но движок выдавал варианты начиная с «1.», а
 * пользователь видел в карточке партии нумерацию хода-источника (35+),
 * — несоответствие читалось как «сбитая нотация». Кроме того, заголовки
 * партии (White/Black/Event/Date) терялись, и в мастерской партия
 * становилась безымянной.
 *
 * Новый поток: PGN строим здесь → `POST /analyses` → `/analysis/<id>`.
 * AnalysisPage в этой ветке грузит сохранённый анализ через `getById`,
 * парсит PGN со всеми тегами `[SetUp "1"][FEN ...]` и корректным
 * фуллмув-стартом — нотация совпадает с реальной партией.
 *
 * Контракт:
 *   - `initialFen` — стартовая позиция задачи; кладётся в `[FEN]`.
 *   - `userMovesUci` — пробел-разделённый UCI-список ходов пользователя
 *     с момента старта задачи (опционально; для предпросмотра попытки).
 *   - `headers` — `puzzle.sourceHeaders` (Seven Tag Roster + ELO), как
 *     отдаёт backend (`TacticPuzzleResponse.sourceHeaders`). Все
 *     `null/undefined` отфильтрованы.
 */
import { Chess } from 'chess.js';

export interface BuildTacticPuzzlePgnArgs {
  initialFen: string;
  /** UCI-ходы пользователя через пробел, опционально. */
  userMovesUci?: string;
  /** PGN-теги исходной партии (как в `puzzle.sourceHeaders`). */
  headers?: Record<string, string> | null;
}

/**
 * Экранирует значение PGN-тега (двойную кавычку в одинарную, чтобы
 * парсер не сломался). Полная замена escape-логикой не нужна — chess.js
 * принимает значения с обычным `'`.
 */
function escapeTagValue(v: string): string {
  return v.replace(/"/g, "'");
}

export function buildTacticPuzzlePgn(
  args: BuildTacticPuzzlePgnArgs,
): string {
  const { initialFen, userMovesUci, headers } = args;

  // Разбираем UCI-ходы пользователя в SAN через chess.js на копии
  // стартовой позиции. На любой невалидной записи — прерываем,
  // оставляя то, что успело распарситься (как делает Precision).
  const chess = new Chess(initialFen);
  const sans: string[] = [];
  if (userMovesUci && userMovesUci.trim()) {
    const uciList = userMovesUci.trim().split(/\s+/).filter(Boolean);
    for (const uci of uciList) {
      if (uci.length < 4) break;
      try {
        const mv = chess.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        if (!mv) break;
        sans.push(mv.san);
      } catch {
        break;
      }
    }
  }

  // Нумерация ходов восстанавливается из FEN: fullmove (поле 6) и side
  // to move (поле 2). Логика 1:1 с PrecisionAttemptPage.buildAttemptPgn —
  // важно, чтобы AnalysisPage в обеих ветках вёл себя одинаково.
  const startParts = initialFen.split(' ');
  const startMvNum = parseInt(startParts[5] || '1', 10) || 1;
  const startIsWhite = startParts[1] !== 'b';
  const movetext: string[] = [];
  for (let i = 0; i < sans.length; i++) {
    const totalHalf = i + (startIsWhite ? 0 : 1);
    const fullMv = startMvNum + Math.floor(totalHalf / 2);
    const isWhiteHalf = totalHalf % 2 === 0;
    if (i === 0 && !startIsWhite) {
      // Чёрные ходят первыми — добавляем явный `N...` префикс.
      movetext.push(`${startMvNum}...`);
    } else if (isWhiteHalf) {
      movetext.push(`${fullMv}.`);
    }
    movetext.push(sans[i]);
  }

  // PGN-заголовки. SetUp/FEN — обязательны, иначе AnalysisPage будет
  // считать стартовой позицию начала партии. Source-теги опциональны
  // (могут отсутствовать у пазлов без партии-источника).
  const headerLines: string[] = [];
  const knownOrder = [
    'Event',
    'Site',
    'Date',
    'Round',
    'White',
    'Black',
    'Result',
    'WhiteElo',
    'BlackElo',
    'ECO',
    'Opening',
    'TimeControl',
  ];
  if (headers) {
    const seen = new Set<string>();
    for (const k of knownOrder) {
      const v = headers[k];
      if (typeof v === 'string' && v.length > 0) {
        headerLines.push(`[${k} "${escapeTagValue(v)}"]`);
        seen.add(k);
      }
    }
    for (const [k, v] of Object.entries(headers)) {
      if (seen.has(k)) continue;
      if (typeof v === 'string' && v.length > 0) {
        headerLines.push(`[${k} "${escapeTagValue(v)}"]`);
      }
    }
  }
  if (!headerLines.some((l) => l.startsWith('[Result '))) {
    headerLines.push(`[Result "*"]`);
  }
  headerLines.push(`[SetUp "1"]`);
  headerLines.push(`[FEN "${initialFen}"]`);

  const tail = movetext.length > 0 ? `${movetext.join(' ')} *` : `*`;
  return `${headerLines.join('\n')}\n\n${tail}`;
}
