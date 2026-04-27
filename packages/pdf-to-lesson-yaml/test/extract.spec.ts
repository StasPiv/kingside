/**
 * KS-2045 — функциональный smoke-тест: глава 1 Калиниченко 2016.
 *
 * PDF лежит вне репозитория (`/tmp/courses/...`). Если файла нет —
 * тест помечается skipped через ранний return (как и в раст-тесте
 * `board-image-to-fen`).
 *
 * Этап 1 не требует точного 1:1 соответствия с ручным `01-ch1-...lesson.yml`
 * (там 12 шагов, конвертер выдаёт 14 — разница описана в README).
 * Acceptance: распознано все 19 диаграмм, FEN корректен, AJV-валидация
 * прошла.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { extractPdf } from '../src/extractor.js';
import { buildLesson } from '../src/transformer.js';
import { validateLesson } from '../src/validator.js';
import type { ConverterChapterConfig } from '../src/types.js';

const PDF_PATH =
  '/tmp/courses/Калиниченко Н. М. (авт.-сост.) - Хосе Рауль Капабланка. Основы шахматной игры - (Шахматы. Классики) - 2016.pdf';

// Глава 1: 19 диаграмм, FEN'ы из верифицированного эталона KS-2030 / KS-2028.
// Порядок — column-major по reading-order extractor'а (column ASC, y ASC, x ASC).
const EXPECTED_FENS_CH1: string[] = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',                                     // pg14, col 0, start
  '8/8/8/2R5/4R3/8/8/8',                                                              // pg15, col 0, R+R
  '8/8/8/1B2B3/8/8/8/8',                                                              // pg15, col 1, B+B
  '8/8/8/4Q3/8/8/8/8',                                                                // pg16, col 0, Q
  '8/8/8/8/3N4/8/8/8',                                                                // pg16, col 1, N
  '8/8/8/8/8/4K3/8/8',                                                                // pg17, col 0, K
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',                                     // pg17, col 1, start (повтор)
  '8/8/8/3pnp2/4P3/8/8/8',                                                            // pg18, knights example
  'Q3k3/7R/8/8/1n4p1/1b6/1Pp2q1P/2K5',                                                // pg19, mate
  '1R3nk1/5p1p/5B1P/8/6K1/8/8/8',                                                     // pg19, stalemate
  'r2qk2r/pp1nbppp/2pp1n2/4p3/2BPP1b1/2N1BN2/PPPQ1PPP/R3K2R',                         // pg20, castling 1
  'r2qk2r/pppnbppp/3p1n2/4p3/2BPP1b1/2NQ1N2/PPP2PPP/R1B1K2R',                         // pg20, castling 2
  'r2qk2r/pp1nbppp/2pp1n2/4p3/2BPP1b1/2N1BN2/PPPQ1PPP/2KR3R',                         // pg20, castling 3
  'r2qk2r/pppnbppp/3p1n2/4p3/2BPP1b1/2NQ1N2/PPP2PPP/R1B2RK1',                         // pg20, castling 4
  'rn1qk2r/p2nbppp/bppp4/4p3/3PP3/1BN1BN2/PPP2PPP/R2QK2R',                            // pg21, castle under attack
  '8/8/8/8/8/8/8/8',                                                                  // pg21, empty (notation)
  '2kq4/2pn3r/1pRp1b2/1P1PR3/Q2K1PBr/2N5/8/8',                                        // pg22, complex notation
  '2qrr1k1/ppb1nppp/2p1bn2/3pN3/2PPpP2/2N1B3/PPB1Q1PP/3R1RK1',                        // pg22, en-passant before
  '2qrr1k1/ppb1nppp/2p1bn2/3pN3/2PP4/2N1Bp2/PPB1Q1PP/3R1RK1',                         // pg22, en-passant after
];

function makeChapterConfig(): ConverterChapterConfig {
  return {
    title: 'Глава 1. Игра, фигуры, их ходы, цель игры',
    slug: 'ch1-game-pieces-moves-goal',
    pageRange: [14, 22],
    blockKey: 'rules',
    kind: 'theory',
    order: 0,
    estMinutes: 40,
    titleKey: 'lessons.capablanca-primer.ch1.l1.title',
    summaryKey: 'lessons.capablanca-primer.ch1.l1.summary',
    isPublished: false,
  };
}

describe('pdf-to-lesson-yaml — Chapter 1 smoke test (KS-2045)', () => {
  it('extracts all 19 diagrams from Kalinichenko 2016 ch.1', async () => {
    if (!existsSync(PDF_PATH)) {
      return; // dataset not available → skip
    }
    const ast = await extractPdf(PDF_PATH, { pageStart: 14, pageEnd: 22 });
    const diagrams = ast.blocks.filter((b) => b.kind === 'diagram') as Array<
      Extract<(typeof ast.blocks)[number], { kind: 'diagram' }>
    >;
    expect(diagrams.length).toBe(19);
    expect(diagrams.map((d) => d.fen_board)).toEqual(EXPECTED_FENS_CH1);
  }, 60_000);

  it('builds a lesson YAML that passes lesson.schema.json validation', async () => {
    if (!existsSync(PDF_PATH)) {
      return;
    }
    const ast = await extractPdf(PDF_PATH, { pageStart: 14, pageEnd: 22 });
    const lesson = buildLesson(ast, makeChapterConfig(), 'capablanca-primer');
    const problems = validateLesson(lesson);
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
    // Этап 1 даёт ≥ 1 шаг и ≥ 19 diagram-ссылок суммарно.
    expect(lesson.steps.length).toBeGreaterThanOrEqual(1);
    const totalDiagrams = lesson.steps.reduce(
      (sum, s) => sum + (s.diagrams?.length ?? 0),
      0,
    );
    expect(totalDiagrams).toBe(19);
  }, 60_000);
});
