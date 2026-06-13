/**
 * KS-4094 (блокер записи видео B3 /precision). Сид истории попыток
 * precision для тестового аккаунта записи.
 *
 * Зеркалит логику `PrecisionService.createTestFixtureAttempt`
 * (apps/api/src/precision/precision.service.ts): пишет PuzzleAttempt +
 * PrecisionAttempt + PrecisionAttemptMove, считая классификацию ходов
 * (`classifyMove`) и звёздную оценку (`computePrecisionScore`) из
 * @kingside/shared. Дополнительно к fixture:
 *   - проставляет created_at попыток на ≥2 РАЗНЫХ дня назад (иначе
 *     тренд /precision/trends/me не рисуется — нужно ≥2 точки по датам);
 *   - заполняет ratingBefore/ratingAfter (восходящая кривая) — чтобы
 *     /precision/history показывал дельты рейтинга;
 *   - проставляет objectiveAchieved (удержано/упущено);
 *   - upsert user_precision_ratings (итоговый рейтинг + счётчик).
 *
 * Ходы генерируются легальными через chess.js (детальная страница
 * /precision/attempts/:id рендерит доску по fenBefore+playedUci), WDL —
 * синтетические (как в fixture: classifyMove смотрит на WDL, не на
 * реальную оценку позиции).
 *
 * Попытки привязываются к локальным PVE-пазлам (solutionMode=
 * 'play-vs-engine') — иначе stats/trends/breakdowns их не учитывают
 * (фильтр puzzle.solutionMode='play-vs-engine').
 *
 * Идемпотентно: перед сидом удаляет прошлые PVE-попытки этого юзера.
 *
 * Запуск (из apps/api, чтобы резолвились @kingside/db и @kingside/shared):
 *   DATABASE_URL=postgresql://kingside:kingside@localhost:5432/kingside \
 *     node /project/tools/seed-precision-ks4094.mjs [userId]
 */
import { PrismaClient } from '@kingside/db';
import { classifyMove, computePrecisionScore } from '@kingside/shared';
import pkg from 'chess.js';
const { Chess } = pkg;

const USER_ID =
  process.argv[2] || '35422f29-8dba-483f-b009-e9e3b923e0e6'; // ks-4066-precision

const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;

/**
 * Синтетические WDL-пресеты (per-mille, POV side-to-move).
 *
 * Важно: `computePrecisionScore` (KS-3774, ADR-065 §3.74) считает балл
 * ТОЛЬКО по дельте expected-score между первым `wdlBefore` и последним
 * `wdlAfter` — промежуточные ходы в звёздную оценку не входят (но идут
 * в per-move счётчики/классификацию для breakdown'ов). Поэтому ЗВЕЗДУ
 * задаёт ПОСЛЕДНИЙ полуход попытки. Пресеты подобраны по E=(w+d/2)/1000:
 *   E_start(winning)=0.93; loss_E = 0.93 − E_end → scorePct → звёзды.
 */
const WDL = {
  winning: { w: 880, d: 100, l: 20 }, // E=0.93 старт/удержание → 5★
  s4: { w: 860, d: 94, l: 46 }, // E=0.907 loss≈0.02 → good → 4★ (90.2)
  s3: { w: 820, d: 104, l: 76 }, // E=0.872 loss≈0.06 → inaccuracy → 3★ (77.0)
  s2: { w: 740, d: 120, l: 140 }, // E=0.80 loss≈0.13 → mistake → 2★ (55.4)
  blunder: { w: 20, d: 10, l: 970 }, // l>950 → blunder → 1★ (0)
};

/**
 * Сценарии попыток. kind задаёт качество ходов:
 *   'best'  — ход = PV1 (5★-составляющая),
 *   'good'  — лёгкая неточность,
 *   'slip'  — ошибка,
 *   'blunder' — зевок.
 * dayOffset — на сколько дней назад датировать.
 * ratingBefore/After — дельта рейтинга для истории и тренда.
 */
const SCENARIOS = [
  // — 3 дня назад —
  {
    label: 'miss-1star',
    dayOffset: 3,
    solved: false,
    objective: false,
    ratingBefore: 1500,
    ratingAfter: 1487,
    plies: ['best', 'blunder'],
  },
  {
    label: 'hold-4star',
    dayOffset: 3,
    solved: true,
    objective: true,
    ratingBefore: 1487,
    ratingAfter: 1506,
    plies: ['best', 'best', 's4'],
  },
  // — 1 день назад —
  {
    label: 'miss-2star',
    dayOffset: 1,
    solved: false,
    objective: false,
    ratingBefore: 1506,
    ratingAfter: 1497,
    plies: ['best', 's2'],
  },
  {
    label: 'hold-5star',
    dayOffset: 1,
    solved: true,
    objective: true,
    ratingBefore: 1497,
    ratingAfter: 1519,
    plies: ['best', 'best', 'best', 'best'],
  },
  // — сегодня —
  {
    label: 'hold-3star',
    dayOffset: 0,
    solved: true,
    objective: true,
    ratingBefore: 1519,
    ratingAfter: 1531,
    plies: ['best', 's3'],
  },
  {
    label: 'hold-5star-b',
    dayOffset: 0,
    solved: true,
    objective: true,
    ratingBefore: 1531,
    ratingAfter: 1552,
    plies: ['best', 'best', 'best'],
  },
];

/** UCI из verbose-хода chess.js. */
const uci = (m) => m.from + m.to + (m.promotion || '');

/**
 * Построить легальные ходы попытки. Для каждого полухода решающего:
 *   - fenBefore = текущая позиция,
 *   - playedUci = легальный ход (для 'best' он же best),
 *   - bestUci   = для 'best' == playedUci; иначе другой легальный ход,
 *   - WDL by kind.
 * После хода решающего играем легальный ответ движка (чтобы очередь
 * вернулась и позиция оставалась легальной для следующего полухода).
 */
function buildMoves(startFen, plies) {
  const chess = new Chess(startFen);
  const out = [];
  for (let i = 0; i < plies.length; i++) {
    const kind = plies[i];
    const legal = chess.moves({ verbose: true });
    if (legal.length === 0) break;
    const fenBefore = chess.fen();

    const playedMove = legal[0];
    const played = uci(playedMove);
    // best: для 'best' тот же ход; иначе — альтернативный легальный.
    const isBest = kind === 'best';
    const altMove = legal[1] ?? legal[0];
    const best = isBest ? played : uci(altMove);

    const wdl = kind === 'best' ? WDL.winning : WDL[kind];
    // wdlBefore — всегда выигрышная (решающий имеет перевес), wdlAfter —
    // по качеству хода. Для 'best' остаётся выигрышной (loss_E≈0).
    const wdlBefore = WDL.winning;
    const wdlAfter = wdl;

    out.push({
      ply: i + 1,
      fenBefore,
      playedUci: played,
      bestUci: best,
      wdlBefore,
      wdlAfter,
      isBest,
    });

    // Применяем ход решающего + ответ движка для легальной непрерывности.
    chess.move({
      from: playedMove.from,
      to: playedMove.to,
      promotion: playedMove.promotion,
    });
    const reply = chess.moves({ verbose: true })[0];
    if (reply) {
      chess.move({
        from: reply.from,
        to: reply.to,
        promotion: reply.promotion,
      });
    }
  }
  return out;
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { id: USER_ID },
    select: { id: true, username: true },
  });
  if (!user) throw new Error(`user ${USER_ID} not found in dev DB`);
  console.log(`Seeding precision history for ${user.username} (${user.id})`);

  const pvePuzzles = await prisma.puzzle.findMany({
    where: { solutionMode: 'play-vs-engine' },
    select: { id: true, fen: true },
    take: SCENARIOS.length,
  });
  if (pvePuzzles.length === 0) {
    throw new Error('no local PVE puzzles to attach attempts to');
  }

  // Идемпотентность: удалить прошлые PVE-попытки этого юзера (cascade
  // снимет precision_attempts + precision_attempt_moves).
  const old = await prisma.puzzleAttempt.findMany({
    where: {
      userId: USER_ID,
      puzzle: { is: { solutionMode: 'play-vs-engine' } },
    },
    select: { id: true },
  });
  if (old.length > 0) {
    await prisma.puzzleAttempt.deleteMany({
      where: { id: { in: old.map((o) => o.id) } },
    });
    console.log(`  removed ${old.length} prior PVE attempt(s)`);
  }

  const now = Date.now();
  let lastAt = null;
  let finalRating = 1500;

  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];
    const puzzle = pvePuzzles[i % pvePuzzles.length];
    const moves = buildMoves(puzzle.fen, sc.plies);

    // Классификация + агрегаты (как в createTestFixtureAttempt).
    const classified = moves.map((m) => ({
      m,
      klass: classifyMove({
        wdlBefore: m.wdlBefore,
        wdlAfter: m.wdlAfter,
        isBestMove: m.isBest,
      }),
    }));
    const counts = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    let firstMistakePly = null;
    let wdlLeakSum = 0;
    for (const c of classified) {
      counts[c.klass]++;
      if (
        firstMistakePly == null &&
        (c.klass === 'mistake' || c.klass === 'blunder')
      ) {
        firstMistakePly = c.m.ply;
      }
      const wb = c.m.wdlBefore;
      const wa = c.m.wdlAfter;
      const eBefore = (wb.w + wb.d / 2) / 1000;
      const eAfter = (wa.w + wa.d / 2) / 1000;
      wdlLeakSum += Math.max(0, eBefore - eAfter);
    }
    const total = classified.length;
    const accuracyPercent =
      total > 0 ? ((counts.best + counts.good) / total) * 100 : 0;

    const scoreResult = computePrecisionScore(
      classified.map(({ m, klass }) => ({
        wdlBefore: m.wdlBefore,
        wdlAfter: m.wdlAfter,
        classification: klass,
        isBestMove: m.isBest,
      })),
    );

    const wdlSigned = (w) => (w ? (w.w - w.l) / 1000 : 0);
    const wdlAtStartSigned = wdlSigned(moves[0].wdlBefore);
    const wdlAtEndSigned = wdlSigned(moves[moves.length - 1].wdlAfter);

    // created_at: раскидываем внутри дня, чтобы порядок был стабилен.
    const createdAt = new Date(now - sc.dayOffset * DAY + i * 60_000);
    const endReason = sc.solved ? 'win' : 'lose-wdl';

    await prisma.$transaction(async (tx) => {
      const pa = await tx.puzzleAttempt.create({
        data: {
          puzzleId: puzzle.id,
          userId: USER_ID,
          solved: sc.solved,
          timeMs: 30_000 + i * 5_000,
          ratingBefore: sc.ratingBefore,
          ratingAfter: sc.ratingAfter,
          userMoves: moves.map((m) => m.playedUci).join(' '),
          hintsUsed: 0,
          createdAt,
        },
        select: { id: true },
      });

      await tx.precisionAttempt.create({
        data: {
          attemptId: pa.id,
          wdlAtStartSigned,
          wdlAtEndSigned,
          halfMovesPlayed: total,
          halfMovesTarget: total,
          accuracyPercent,
          bestMovesCount: counts.best,
          goodMovesCount: counts.good,
          inaccuraciesCount: counts.inaccuracy,
          mistakesCount: counts.mistake,
          blundersCount: counts.blunder,
          firstMistakePly,
          wdlLeakSum,
          endReason,
          score: scoreResult.stars,
          scorePct: scoreResult.scorePct,
          objectiveAchieved: sc.objective,
          ratingBefore: sc.ratingBefore,
          ratingAfter: sc.ratingAfter,
        },
      });

      await tx.precisionAttemptMove.createMany({
        data: classified.map(({ m, klass }) => ({
          attemptId: pa.id,
          ply: m.ply,
          fenBefore: m.fenBefore,
          playedUci: m.playedUci,
          bestUci: m.bestUci,
          wdlBeforeW: m.wdlBefore.w,
          wdlBeforeD: m.wdlBefore.d,
          wdlBeforeL: m.wdlBefore.l,
          wdlAfterW: m.wdlAfter.w,
          wdlAfterD: m.wdlAfter.d,
          wdlAfterL: m.wdlAfter.l,
          depth: 22,
          classification: klass,
        })),
      });

      console.log(
        `  [${sc.label}] day-${sc.dayOffset} score=${scoreResult.stars}★ ` +
          `acc=${accuracyPercent.toFixed(0)}% solved=${sc.solved} ` +
          `rating ${sc.ratingBefore}→${sc.ratingAfter} moves=${total}`,
      );
    });

    if (!lastAt || createdAt > lastAt) lastAt = createdAt;
    finalRating = sc.ratingAfter;
  }

  // Итоговый precision-рейтинг пользователя.
  await prisma.userPrecisionRating.upsert({
    where: { userId: USER_ID },
    create: {
      userId: USER_ID,
      rating: finalRating,
      deviation: 90,
      attempts: SCENARIOS.length,
      lastAttemptAt: lastAt,
    },
    update: {
      rating: finalRating,
      deviation: 90,
      attempts: SCENARIOS.length,
      lastAttemptAt: lastAt,
    },
  });

  console.log(
    `Done. ${SCENARIOS.length} attempts across 3 days, final rating ${finalRating}.`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('SEED FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
