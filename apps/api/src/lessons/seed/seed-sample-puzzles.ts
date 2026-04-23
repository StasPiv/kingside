/**
 * Идемпотентный скрипт наполнения `puzzles` минимальным набором задач
 * для QA и локальной разработки (KS-1783).
 *
 * Запуск: `npm run seed:sample-puzzles --workspace=@kingside/api`
 *
 * До импорта реальной Lichess-puzzle-базы (отдельная devops-задача)
 * resolver в курсе «Начинающий» возвращал пустой список. Этот seed
 * кладёт ~20 синтетических задач с нужными темами/рейтингами, чтобы
 * PuzzleStep работал end-to-end.
 *
 * Upsert по `id`. Все задачи помечены `source='sample'` — отфильтруются
 * одной строкой `DELETE FROM puzzles WHERE source='sample'` при импорте
 * реального Lichess-набора.
 *
 * Перед записью — валидация FEN через chess.js. Если валидация падает,
 * seed завершается с кодом 1 без записи.
 */

import { Chess } from 'chess.js';
import { PrismaClient } from '@kingside/db';
import { SAMPLE_PUZZLES } from './sample-puzzles';

async function main(): Promise<void> {
  // 1. Валидация FEN — перед любым upsert'ом.
  const errors: string[] = [];
  for (const p of SAMPLE_PUZZLES) {
    const chess = new Chess();
    try {
      chess.load(p.fen);
    } catch (e) {
      errors.push(`${p.id}: invalid FEN — ${(e as Error).message}`);
      continue;
    }
    const firstMove = p.moves.split(' ')[0];
    if (firstMove && firstMove.length >= 4) {
      try {
        const mv = chess.move({
          from: firstMove.slice(0, 2),
          to: firstMove.slice(2, 4),
          promotion: firstMove.length > 4 ? firstMove.slice(4, 5) : undefined,
        });
        if (!mv) errors.push(`${p.id}: first move "${firstMove}" not legal from FEN`);
      } catch {
        errors.push(`${p.id}: first move "${firstMove}" not legal from FEN`);
      }
    }
  }
  if (errors.length > 0) {
    process.stderr.write(
      `✗ sample-puzzles validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`,
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    let upserted = 0;
    for (const p of SAMPLE_PUZZLES) {
      await prisma.puzzle.upsert({
        where: { id: p.id },
        update: {
          fen: p.fen,
          moves: p.moves,
          rating: p.rating,
          themes: p.themes.join(' '),
          // KS-1783: `source='generated'` выбран сознательно —
          // `puzzleService.validatePlayerSide` для non-lichess source
          // трактует `playerColor = initialTurn` и не требует setup-хода
          // перед решением (а мои задачи — один ход игрока с текущего FEN).
          // После импорта реальной Lichess-базы эти задачи легко удалить:
          // `DELETE FROM puzzles WHERE id LIKE 'DEV-%'`.
          source: 'generated',
        },
        create: {
          id: p.id,
          fen: p.fen,
          moves: p.moves,
          rating: p.rating,
          themes: p.themes.join(' '),
          // KS-1783: `source='generated'` выбран сознательно —
          // `puzzleService.validatePlayerSide` для non-lichess source
          // трактует `playerColor = initialTurn` и не требует setup-хода
          // перед решением (а мои задачи — один ход игрока с текущего FEN).
          // После импорта реальной Lichess-базы эти задачи легко удалить:
          // `DELETE FROM puzzles WHERE id LIKE 'DEV-%'`.
          source: 'generated',
        },
      });
      upserted++;
    }
    process.stdout.write(`✓ seed-sample-puzzles done: ${upserted} puzzles\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  process.stderr.write(`✗ seed-sample-puzzles crashed: ${e.stack ?? e}\n`);
  process.exit(1);
});
