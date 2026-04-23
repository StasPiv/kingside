/**
 * Минимальный набор синтетических puzzle-задач для dev / staging (KS-1783).
 *
 * До импорта реальной Lichess-puzzle-базы (отдельная devops-задача) на
 * пустой dev-БД `LessonPuzzleResolverService` возвращал пустой список,
 * и PuzzleStep в курсе «Начинающий» выглядел как «No puzzles available».
 *
 * Этот набор — не замена Lichess, а временный минимум для QA и локальной
 * разработки: ≥ 1 задача под каждую тему, используемую в курсе
 * «Начинающий» (блоки 2/3/5/6).
 *
 * Формат каждого элемента совместим с моделью `Puzzle` (Prisma):
 *  - `id` — префикс `DEV-` + семантический ключ (чтобы не пересечься с
 *    будущими Lichess-id, которые все числовые/base36);
 *  - `source` — `'sample'` (не `'lichess'` и не `'generated'`), чтобы
 *    при импорте реальной базы этот набор можно было отфильтровать/удалить
 *    одним запросом `DELETE FROM puzzles WHERE source='sample'`;
 *  - `fen` — валидная позиция (проверяется chess.js);
 *  - `moves` — UCI-ходы решения (первый = ход игрока; synthetic-формат без
 *    setup-хода, т. к. fallback в `puzzle.service.validatePlayerSide` на
 *    non-lichess сорс трактует `playerColor = initialTurn`).
 *
 * Upsert по `id` — идемпотентно.
 */

export interface SamplePuzzle {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string[];
}

export const SAMPLE_PUZZLES: SamplePuzzle[] = [
  // ─── mate / mateIn1 / backRankMate ────────────────────────────
  {
    id: 'DEV-mate1-001',
    fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1',
    moves: 'a1a8',
    rating: 700,
    themes: ['mate', 'mateIn1', 'backRankMate', 'endgame'],
  },
  {
    id: 'DEV-mate1-002',
    fen: '6k1/6pp/8/8/8/8/8/R5K1 w - - 0 1',
    moves: 'a1a8',
    rating: 750,
    themes: ['mate', 'mateIn1', 'backRankMate', 'endgame'],
  },
  {
    id: 'DEV-mate1-003',
    fen: 'r4rk1/ppp2ppp/8/8/8/8/PPP2PPP/4R1K1 w - - 0 1',
    moves: 'e1e8',
    rating: 900,
    themes: ['mate', 'mateIn1', 'backRankMate'],
  },
  {
    id: 'DEV-mate1-005',
    fen: '5rk1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
    moves: 'a1a8',
    rating: 850,
    themes: ['mate', 'mateIn1', 'backRankMate'],
  },

  // ─── mateIn2 ───────────────────────────────────────────────────
  {
    id: 'DEV-mate2-001',
    fen: '6k1/5p1p/8/8/8/8/5PPP/R5K1 w - - 0 1',
    moves: 'a1a8 g8f7',
    rating: 1050,
    themes: ['mate', 'mateIn2'],
  },

  // ─── fork (вилка) ─────────────────────────────────────────────
  {
    id: 'DEV-fork-001',
    fen: 'r3k3/8/2N5/8/8/8/8/4K3 w - - 0 1',
    moves: 'c6e7',
    rating: 900,
    themes: ['fork', 'oneMove'],
  },
  {
    id: 'DEV-fork-002',
    fen: '3rk3/8/8/2N5/8/8/8/4K3 w - - 0 1',
    moves: 'c5e6',
    rating: 950,
    themes: ['fork', 'oneMove'],
  },
  {
    id: 'DEV-fork-003',
    fen: '4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1',
    moves: 'c3e4',
    rating: 1100,
    themes: ['fork', 'oneMove'],
  },
  {
    id: 'DEV-fork-004',
    fen: '4k3/3q4/8/8/4N3/8/8/4K3 w - - 0 1',
    moves: 'e4d6',
    rating: 1150,
    themes: ['fork', 'oneMove'],
  },

  // ─── pin (связка) ─────────────────────────────────────────────
  {
    id: 'DEV-pin-001',
    fen: '4k3/8/8/4n3/8/8/4R3/4K3 w - - 0 1',
    moves: 'e2e5',
    rating: 850,
    themes: ['pin', 'oneMove'],
  },
  {
    id: 'DEV-pin-002',
    fen: '3qk3/8/8/8/3R4/8/8/4K3 w - - 0 1',
    moves: 'd4d8',
    rating: 900,
    themes: ['pin', 'oneMove'],
  },
  {
    id: 'DEV-pin-003',
    fen: '4k3/8/3n4/8/B7/8/8/4K3 w - - 0 1',
    moves: 'a4d7',
    rating: 1000,
    themes: ['pin', 'oneMove'],
  },

  // ─── hangingPiece ─────────────────────────────────────────────
  {
    id: 'DEV-hanging-001',
    fen: '4k3/8/3n4/8/8/8/8/R3K3 w - - 0 1',
    moves: 'a1d1',
    rating: 700,
    themes: ['hangingPiece', 'oneMove'],
  },
  {
    id: 'DEV-hanging-002',
    fen: '4k3/3r4/8/8/8/8/3R4/4K3 w - - 0 1',
    moves: 'd2d7',
    rating: 900,
    themes: ['hangingPiece', 'oneMove'],
  },
  {
    id: 'DEV-hanging-003',
    fen: '4k3/8/2b5/8/8/8/8/2R1K3 w - - 0 1',
    moves: 'c1c6',
    rating: 800,
    themes: ['hangingPiece', 'oneMove'],
  },

  // ─── discoveredAttack ─────────────────────────────────────────
  {
    id: 'DEV-disc-001',
    fen: 'k3q3/8/2r5/8/8/8/4N3/4R2K w - - 0 1',
    moves: 'e2d4',
    rating: 1200,
    themes: ['discoveredAttack'],
  },

  // ─── doubleCheck ──────────────────────────────────────────────
  {
    id: 'DEV-dbl-001',
    fen: '5k2/8/8/4N3/2B5/8/5PPP/6K1 w - - 0 1',
    moves: 'e5f7',
    rating: 1250,
    themes: ['discoveredAttack', 'doubleCheck'],
  },

  // ─── endgame / pawnEndgame / promotion ────────────────────────
  {
    id: 'DEV-endgame-001',
    fen: '8/4P3/8/8/8/8/8/4k1K1 w - - 0 1',
    moves: 'e7e8q',
    rating: 700,
    themes: ['promotion', 'pawnEndgame', 'endgame'],
  },
  {
    id: 'DEV-endgame-002',
    fen: '4k3/8/4K3/4P3/8/8/8/8 b - - 0 1',
    moves: 'e8d8 e6d6',
    rating: 900,
    themes: ['pawnEndgame', 'endgame'],
  },

  // ─── queenEndgame / rookEndgame ──────────────────────────────
  {
    id: 'DEV-q-end-001',
    fen: 'k7/Q7/2K5/8/8/8/8/8 w - - 0 1',
    moves: 'a7b7',
    rating: 900,
    themes: ['mate', 'mateIn1', 'queenEndgame', 'endgame'],
  },
  {
    id: 'DEV-r-end-001',
    fen: 'k6R/8/2K5/8/8/8/8/8 w - - 0 1',
    moves: 'h8a8',
    rating: 1000,
    themes: ['mate', 'mateIn1', 'rookEndgame', 'endgame'],
  },
];
