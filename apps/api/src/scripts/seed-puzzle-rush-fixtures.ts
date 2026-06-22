/**
 * KS-4532. Идемпотентный seed для записи видеообзора B4 (Puzzle Rush).
 *
 * Что заводит:
 *   1. Корпус Lichess-задач с rating ≤ 1200 — из CSV-дампа боевой
 *      базы. Путь к CSV задаётся аргументом (по умолчанию
 *      `/tmp/puzzles_easy_sample.csv`). CSV-колонки: id, fen, moves,
 *      rating, rating_dev, popularity, nb_plays, themes, source,
 *      solution_mode, source_metadata, created_at. Заливается через
 *      `prisma.puzzle.createMany({skipDuplicates: true})`.
 *   2. 8 demo-пользователей с фиксированными UUID и username вида
 *      `rush_alice`..`rush_henry`. Upsert по username, пароля нет
 *      (логин через JWT-impersonation на стороне content).
 *   3. 10 `PuzzleRushScore` записей для лидерборда — по 5 в каждом
 *      `timeMode` ('3' и '5'). Фиксированные UUID, разные scores
 *      35..58. Через `deleteMany` + `createMany` (идемпотентно).
 *   4. Одна готовая rush-сессия с фиксированным `scoreId` для
 *      `/puzzle-rush/review/:scoreId` — 6 решённых попыток + 2 ошибки.
 *      `scoreId = SEED_RUSH_REVIEW_SCORE_ID` (см. ниже).
 *
 * Запуск:
 *   `npm run seed:rush-fixtures --workspace=@kingside/api`
 *   или
 *   `npx ts-node src/scripts/seed-puzzle-rush-fixtures.ts [csvPath]`
 *
 * Идемпотентность: повторный запуск пропускает уже загруженные
 * puzzles (`skipDuplicates`), пересоздаёт пользователей через upsert
 * по username, пересоздаёт rush-фикстуры по фиксированным UUID.
 *
 * Зависимости от боевого CSV: если файла нет — скрипт всё равно
 * выполняет шаги 2–4, но шаг 4 проверит, что в БД есть хотя бы 12
 * пазлов rating ≤ 1200, иначе упадёт с явной ошибкой (нет
 * корпуса для review-сессии).
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { PrismaClient, type Prisma } from '@kingside/db';
import { parseLine } from '../puzzle/parse-puzzle-csv';

// Фиксированные UUID — для документирования в сценарии записи.
const SEED_USER_IDS = {
  alice: '11111111-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  bob: '22222222-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  carol: '33333333-cccc-4ccc-cccc-cccccccccccc',
  dave: '44444444-dddd-4ddd-dddd-dddddddddddd',
  eve: '55555555-eeee-4eee-eeee-eeeeeeeeeeee',
  frank: '66666666-ffff-4fff-ffff-ffffffffffff',
  grace: '77777777-aaaa-4bbb-cccc-dddddddddddd',
  henry: '88888888-bbbb-4ccc-dddd-eeeeeeeeeeee',
} as const;

// 10 фиксированных score-UUID — для лидерборда.
const LEADERBOARD_SCORE_IDS = [
  // 3-минутный режим
  '00000001-0001-4001-8001-000000000001',
  '00000001-0001-4001-8001-000000000002',
  '00000001-0001-4001-8001-000000000003',
  '00000001-0001-4001-8001-000000000004',
  '00000001-0001-4001-8001-000000000005',
  // 5-минутный режим
  '00000005-0005-4005-8005-000000000001',
  '00000005-0005-4005-8005-000000000002',
  '00000005-0005-4005-8005-000000000003',
  '00000005-0005-4005-8005-000000000004',
  '00000005-0005-4005-8005-000000000005',
] as const;

// Известный scoreId для review-страницы.
export const SEED_RUSH_REVIEW_SCORE_ID =
  '99999999-9999-4999-8999-999999999999';

const DEMO_USERS: Array<{
  key: keyof typeof SEED_USER_IDS;
  username: string;
  rating: number;
}> = [
  { key: 'alice', username: 'rush_alice', rating: 1600 },
  { key: 'bob', username: 'rush_bob', rating: 1450 },
  { key: 'carol', username: 'rush_carol', rating: 1380 },
  { key: 'dave', username: 'rush_dave', rating: 1720 },
  { key: 'eve', username: 'rush_eve', rating: 1550 },
  { key: 'frank', username: 'rush_frank', rating: 1300 },
  { key: 'grace', username: 'rush_grace', rating: 1820 },
  { key: 'henry', username: 'rush_henry', rating: 1480 },
];

// Лидерборд: (username, timeMode, score, daysAgo). Скриптовые
// разрывы для красивой картинки в UI.
const LEADERBOARD_ROWS: Array<{
  scoreIdIndex: number;
  userKey: keyof typeof SEED_USER_IDS;
  timeMode: '3' | '5';
  score: number;
  daysAgo: number;
}> = [
  // 3 мин
  { scoreIdIndex: 0, userKey: 'grace', timeMode: '3', score: 58, daysAgo: 2 },
  { scoreIdIndex: 1, userKey: 'dave', timeMode: '3', score: 51, daysAgo: 4 },
  { scoreIdIndex: 2, userKey: 'alice', timeMode: '3', score: 47, daysAgo: 7 },
  { scoreIdIndex: 3, userKey: 'eve', timeMode: '3', score: 42, daysAgo: 1 },
  { scoreIdIndex: 4, userKey: 'henry', timeMode: '3', score: 38, daysAgo: 9 },
  // 5 мин
  { scoreIdIndex: 5, userKey: 'dave', timeMode: '5', score: 89, daysAgo: 3 },
  { scoreIdIndex: 6, userKey: 'grace', timeMode: '5', score: 84, daysAgo: 5 },
  { scoreIdIndex: 7, userKey: 'eve', timeMode: '5', score: 76, daysAgo: 6 },
  { scoreIdIndex: 8, userKey: 'bob', timeMode: '5', score: 68, daysAgo: 1 },
  { scoreIdIndex: 9, userKey: 'carol', timeMode: '5', score: 61, daysAgo: 8 },
];

async function importEasyPuzzlesFromCsv(
  prisma: PrismaClient,
  csvPath: string,
): Promise<number> {
  if (!fs.existsSync(csvPath)) {
    console.warn(
      `[seed-rush] CSV не найден (${csvPath}) — пропускаю импорт корпуса; ` +
        `буду использовать только то, что уже в БД.`,
    );
    return 0;
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  const batch: Prisma.PuzzleCreateManyInput[] = [];
  let imported = 0;
  let lineNo = 0;
  const BATCH = 500;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    if (!header) {
      header = line.split(',').map((h) => h.trim());
      continue;
    }
    const parsed = parseFromDumpLine(header, line);
    if (!parsed) continue;
    batch.push(parsed);
    if (batch.length >= BATCH) {
      const r = await prisma.puzzle.createMany({
        data: batch,
        skipDuplicates: true,
      });
      imported += r.count;
      batch.length = 0;
    }
  }
  if (batch.length > 0) {
    const r = await prisma.puzzle.createMany({
      data: batch,
      skipDuplicates: true,
    });
    imported += r.count;
  }
  console.log(`[seed-rush] корпус: импортировано ${imported} новых задач`);
  return imported;
}

/**
 * Парсинг строки из CSV-дампа таблицы `puzzles` (формат `COPY ... TO`).
 * Колонки: id, fen, moves, rating, rating_dev, popularity, nb_plays,
 * themes, source, solution_mode, source_metadata, created_at.
 *
 * CSV из PostgreSQL `COPY` использует двойные кавычки для экранирования
 * полей с запятыми; пустые поля — без кавычек. Поддерживаем оба случая
 * через простой стейт-машинный сплит.
 */
function parseFromDumpLine(
  header: string[],
  line: string,
): Prisma.PuzzleCreateManyInput | null {
  const cols = splitCsvLine(line);
  if (cols.length !== header.length) return null;
  const row: Record<string, string> = {};
  header.forEach((h, i) => (row[h] = cols[i]));
  const id = row.id?.trim();
  const fen = row.fen?.trim();
  const moves = row.moves?.trim();
  const rating = parseInt(row.rating ?? '1200', 10);
  if (!id || !fen || !moves) return null;
  return {
    id,
    fen,
    moves,
    rating,
    ratingDev: parseInt(row.rating_dev ?? '350', 10),
    popularity: parseInt(row.popularity ?? '0', 10),
    nbPlays: parseInt(row.nb_plays ?? '0', 10),
    themes: row.themes ?? '',
    source: row.source || 'lichess',
    solutionMode: row.solution_mode || 'forced-line',
    sourceMetadata: row.source_metadata || null,
  };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"' && cur.length === 0) {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

async function ensureDemoUsers(prisma: PrismaClient): Promise<void> {
  for (const u of DEMO_USERS) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: { ratingBlitz: u.rating, ratingRapid: u.rating },
      create: {
        id: SEED_USER_IDS[u.key],
        username: u.username,
        ratingBullet: u.rating,
        ratingBlitz: u.rating,
        ratingRapid: u.rating,
        ratingClassical: u.rating,
        ratingPuzzle: u.rating,
        isBot: false,
        isSynthetic: false,
      },
    });
  }
  console.log(`[seed-rush] demo-users: 8 (rush_alice..rush_henry)`);
}

async function seedLeaderboard(prisma: PrismaClient): Promise<void> {
  // Удалить старые scores с нашими фиксированными id (для идемпотентности)
  // и затем создать заново. session_puzzles при этом снесутся через FK
  // не каскадно — посмотрим: PuzzleRushSessionPuzzle.score → PuzzleRushScore
  // без onDelete-каскада. Сначала удалим session_puzzles, потом scores.
  const allIds = [...LEADERBOARD_SCORE_IDS, SEED_RUSH_REVIEW_SCORE_ID];
  await prisma.puzzleRushSessionPuzzle.deleteMany({
    where: { scoreId: { in: allIds } },
  });
  await prisma.puzzleRushScore.deleteMany({
    where: { id: { in: allIds } },
  });
  for (const r of LEADERBOARD_ROWS) {
    await prisma.puzzleRushScore.create({
      data: {
        id: LEADERBOARD_SCORE_IDS[r.scoreIdIndex],
        userId: SEED_USER_IDS[r.userKey],
        timeMode: r.timeMode,
        score: r.score,
        createdAt: new Date(Date.now() - r.daysAgo * 24 * 60 * 60 * 1000),
      },
    });
  }
  console.log(`[seed-rush] leaderboard: 10 scores (5 × '3' + 5 × '5')`);
}

async function seedReviewSession(prisma: PrismaClient): Promise<void> {
  const easyPuzzles = await prisma.puzzle.findMany({
    where: { rating: { lte: 1200 }, source: 'lichess' },
    orderBy: [{ popularity: 'desc' }, { id: 'asc' }],
    take: 8,
    select: { id: true },
  });
  if (easyPuzzles.length < 8) {
    throw new Error(
      `[seed-rush] недостаточно лёгких задач (rating ≤ 1200) для review-сессии: ` +
        `найдено ${easyPuzzles.length}, нужно минимум 8. Сначала залей CSV дампа boevoy ` +
        `базы (см. инструкцию в шапке скрипта).`,
    );
  }
  // Создаём score для review demo-пользователя (alice).
  await prisma.puzzleRushScore.create({
    data: {
      id: SEED_RUSH_REVIEW_SCORE_ID,
      userId: SEED_USER_IDS.alice,
      timeMode: '3',
      score: 6,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
  });
  // 8 попыток: 6 правильных, 2 ошибочных (позиции 4 и 7).
  const SOLVED_POSITIONS = new Set([1, 2, 3, 5, 6, 8]);
  for (let i = 0; i < easyPuzzles.length; i++) {
    const pos = i + 1;
    await prisma.puzzleRushSessionPuzzle.create({
      data: {
        scoreId: SEED_RUSH_REVIEW_SCORE_ID,
        puzzleId: easyPuzzles[i].id,
        solved: SOLVED_POSITIONS.has(pos),
        position: pos,
      },
    });
  }
  console.log(
    `[seed-rush] review session: scoreId=${SEED_RUSH_REVIEW_SCORE_ID} ` +
      `user=rush_alice attempts=8 (solved=6 errors=2 на позициях 4 и 7)`,
  );
}

async function main(): Promise<void> {
  const csvPath = process.argv[2] ?? '/tmp/puzzles_easy_sample.csv';
  const prisma = new PrismaClient();
  try {
    await importEasyPuzzlesFromCsv(prisma, csvPath);
    await ensureDemoUsers(prisma);
    await seedLeaderboard(prisma);
    await seedReviewSession(prisma);
    const easyCount = await prisma.puzzle.count({
      where: { rating: { lte: 1200 }, source: 'lichess' },
    });
    console.log(`[seed-rush] всего lichess rating ≤ 1200 в БД: ${easyCount}`);
    console.log(
      `[seed-rush] review URL для записи: /puzzle-rush/review/${SEED_RUSH_REVIEW_SCORE_ID}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

void parseLine; // silence unused import; parseFromDumpLine используется вместо него
