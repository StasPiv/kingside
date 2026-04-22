/**
 * KS-1687 — генератор синтетических TWIC-фикстур для замера peak RSS и
 * тестов chunk-loop'а в `TwicImporter.runForIssue`.
 *
 * Каждая партия — минимально валидный PGN ~20 полуходов, разные
 * White/Black/Round/Site → уникальный `content_hash`. Реальная TWIC-партия
 * ~2-3 KB в PGN + 80 полуходов; синтетика меньше (чтобы fixture build был
 * быстрым), но этого достаточно для профилирования пайплайна parse →
 * filterAlreadyImported → insert.
 *
 * Если нужен chunk-boundary тест — используй `generateTwicFixtureWithDuplicate`.
 */

import AdmZip from 'adm-zip';

/**
 * Валидная партия длиной ≥40 полуходов (ADR-014 §1.2 — индексер берёт ply
 * ≤40). Достаточно реалистична, чтобы parseBatch+position-row-builder
 * доработали полную ветку, но быстрее чем живая TWIC (~80 полуходов).
 * classifyGame без TimeControl/blacklist → `classical-legacy`/
 * `isClassical:true` — путь через indexer и writer активен.
 */
/**
 * Детерминированная 80-полуходовая партия, заранее сгенерированная
 * через chess.js (pseudo-random legal moves, seeded на hash(FEN)) и
 * валидированная `chess.Chess().loadPgn(...)`. 80 ply — верхняя граница
 * реальной TWIC-партии (живая классическая партия 40-80 полуходов);
 * это реалистично нагружает parseBatch (фулл ParsedGame[], 80 FEN на
 * партию) и position-row-builder (capped at ARCHIVE_PLY_LIMIT=40).
 * На 8000 партиях ≈ современный TWIC-выпуск по объёму памяти.
 */
const STANDARD_80_HALFMOVES =
  '1. e3 Na6 2. Nc3 h5 3. Na4 Nf6 4. Nb6 e6 5. f4 Nb8 ' +
  '6. Nxd7 Nh7 7. g4 f5 8. c4 Qh4+ 9. Ke2 Bd6 10. d4 a6 ' +
  '11. Nc5 g5 12. Kd3 b5 13. Kc3 Nc6 14. Rb1 Be5 15. Nh3 Ke7 ' +
  '16. Bg2 Na5 17. Nxe6 Rg8 18. Nhxg5 b4+ 19. Kd3 Qh3 20. Qd2 fxg4 ' +
  '21. Qe1 Kf6 22. Bd5 c6 23. Ke2 Nb7 24. b3 Bd6 25. Bd2 Rh8 ' +
  '26. Rf1 Qxf1+ 27. Qxf1 cxd5 28. Nf8 Kf5 29. Qh3 Be7 30. e4+ dxe4 ' +
  '31. Nf3 Nxf8 32. Be1 a5 33. c5 Rh7 34. Bg3 Rh8 35. Ra1 exf3+ ' +
  '36. Kf1 Ra6 37. Ke1 Rhh6 38. Kf1 a4 39. Bh4 Rag6 40. Ke1 Rc6';

function buildGamePgn(
  index: number,
  site: string,
  round: string,
  white: string,
  black: string,
): string {
  return [
    '[Event "Synthetic TWIC fixture"]',
    `[Site "${site}"]`,
    '[Date "2025.01.01"]',
    `[Round "${round}"]`,
    `[White "${white}"]`,
    `[Black "${black}"]`,
    `[WhiteElo "${2200 + (index % 200)}"]`,
    `[BlackElo "${2100 + (index % 300)}"]`,
    '[Result "1-0"]',
    '',
    `${STANDARD_80_HALFMOVES} 1-0`,
    '',
  ].join('\n');
}

/**
 * Генерирует PGN-текст с `count` партиями. Все партии имеют
 * уникальные `content_hash` (разные Round, которые включены в хэш).
 */
export function generateTwicFixturePgn(count: number): string {
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push(
      buildGamePgn(
        i,
        `TestSite-${i % 50}`,
        `R${i + 1}`,
        `WhitePlayer_${i}`,
        `BlackPlayer_${i}`,
      ),
    );
  }
  return chunks.join('\n');
}

/**
 * Генерирует in-memory zip с TWIC PGN-файлом внутри.
 */
export function generateTwicZip(
  count: number,
  fileName = 'twic9999.pgn',
): Buffer {
  const pgn = generateTwicFixturePgn(count);
  const zip = new AdmZip();
  zip.addFile(fileName, Buffer.from(pgn, 'utf-8'));
  return zip.toBuffer();
}

/**
 * Генерирует fixture с парой партий-дубликатов на заданных индексах
 * (одна и та же комбинация White/Black/Round/Date/ходов → одинаковый
 * content_hash). Используется в chunk-boundary UNIQUE-тесте: индексы
 * подбираются так, чтобы дубли попали в разные chunk'и.
 */
export function generateTwicZipWithDuplicateAt(
  count: number,
  firstIdx: number,
  secondIdx: number,
  fileName = 'twic9999.pgn',
): Buffer {
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i === secondIdx) {
      // Копия партии под firstIdx — идентичный content_hash.
      chunks.push(
        buildGamePgn(
          firstIdx,
          `TestSite-${firstIdx % 50}`,
          `R${firstIdx + 1}`,
          `WhitePlayer_${firstIdx}`,
          `BlackPlayer_${firstIdx}`,
        ),
      );
    } else {
      chunks.push(
        buildGamePgn(
          i,
          `TestSite-${i % 50}`,
          `R${i + 1}`,
          `WhitePlayer_${i}`,
          `BlackPlayer_${i}`,
        ),
      );
    }
  }
  const pgn = chunks.join('\n');
  const zip = new AdmZip();
  zip.addFile(fileName, Buffer.from(pgn, 'utf-8'));
  return zip.toBuffer();
}
