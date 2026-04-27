/**
 * KS-2030 — функциональный тест PDF-пути на главе 1 PDF Калиниченко 2016.
 *
 * PDF лежит вне репозитория (`/tmp/courses/...`). Если файла нет — тест
 * помечается skipped через ранний return (как и в raster-тесте).
 *
 * Эталон: 19 диаграмм главы 1, выписанных вручную с PDF и сопоставленных
 * с фикстурами KS-2028 (там, где они пересекаются — все совпадают).
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { recognizePdfBoards } from '../src/index.js';

const PDF_PATH =
  '/tmp/courses/Калиниченко Н. М. (авт.-сост.) - Хосе Рауль Капабланка. Основы шахматной игры - (Шахматы. Классики) - 2016.pdf';

interface PageExpectation {
  page: number;
  fens: string[];
}

// Глава 1, страницы 14–22 (1-indexed). Порядок FEN — порядок чтения
// (сверху вниз, слева направо).
const CHAPTER1_EXPECTED: PageExpectation[] = [
  { page: 14, fens: ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'] },
  { page: 15, fens: ['8/8/8/2R5/4R3/8/8/8', '8/8/8/1B2B3/8/8/8/8'] },
  { page: 16, fens: ['8/8/8/8/3N4/8/8/8', '8/8/8/4Q3/8/8/8/8'] },
  { page: 17, fens: ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', '8/8/8/8/8/4K3/8/8'] },
  { page: 18, fens: ['8/8/8/3pnp2/4P3/8/8/8'] },
  { page: 19, fens: ['Q3k3/7R/8/8/1n4p1/1b6/1Pp2q1P/2K5', '1R3nk1/5p1p/5B1P/8/6K1/8/8/8'] },
  {
    page: 20,
    fens: [
      'r2qk2r/pp1nbppp/2pp1n2/4p3/2BPP1b1/2N1BN2/PPPQ1PPP/R3K2R',
      'r2qk2r/pppnbppp/3p1n2/4p3/2BPP1b1/2NQ1N2/PPP2PPP/R1B1K2R',
      'r2qk2r/pp1nbppp/2pp1n2/4p3/2BPP1b1/2N1BN2/PPPQ1PPP/2KR3R',
      'r2qk2r/pppnbppp/3p1n2/4p3/2BPP1b1/2NQ1N2/PPP2PPP/R1B2RK1',
    ],
  },
  {
    page: 21,
    fens: [
      'rn1qk2r/p2nbppp/bppp4/4p3/3PP3/1BN1BN2/PPP2PPP/R2QK2R',
      '8/8/8/8/8/8/8/8',
    ],
  },
  {
    page: 22,
    fens: [
      '2qrr1k1/ppb1nppp/2p1bn2/3pN3/2PPpP2/2N1B3/PPB1Q1PP/3R1RK1',
      '2kq4/2pn3r/1pRp1b2/1P1PR3/Q2K1PBr/2N5/8/8',
      '2qrr1k1/ppb1nppp/2p1bn2/3pN3/2PP4/2N1Bp2/PPB1Q1PP/3R1RK1',
    ],
  },
];

describe('board-image-to-fen PDF recognizer (KS-2030)', () => {
  for (const exp of CHAPTER1_EXPECTED) {
    it(`page ${exp.page}: decodes ${exp.fens.length} diagram(s)`, async () => {
      if (!existsSync(PDF_PATH)) {
        return; // dataset not available → skip
      }
      const boards = await recognizePdfBoards(PDF_PATH, { page: exp.page });
      const got = boards.map((b) => b.fen_board);
      expect(got).toEqual(exp.fens);
    }, 20_000);
  }

  it('all-pages aggregate: chapter 1 (pages 14–22) yields 19 diagrams in reading order', async () => {
    if (!existsSync(PDF_PATH)) {
      return;
    }
    const boards = await recognizePdfBoards(PDF_PATH, { allPages: true });
    const ch1 = boards.filter((b) => b.page >= 14 && b.page <= 22);
    expect(ch1.length).toBe(19);
    // Спот-проверка соответствия между --page-режимом и --all-pages-режимом
    // на конкретной странице с 4 диаграммами (стр. 20).
    const onP20 = ch1.filter((b) => b.page === 20).map((b) => b.fen_board);
    expect(onP20).toEqual(
      CHAPTER1_EXPECTED.find((e) => e.page === 20)!.fens,
    );
  }, 60_000);
});
