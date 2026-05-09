import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2673 — скриншоты /precision?mine=true с реальными карточками
 * (один draft, один public). Перед запуском фикстура создаёт пазлы
 * через `POST /puzzles/batch` (тот же эндпоинт, что использует
 * PuzzleGeneratorModal в проде). Один остаётся приватным (draft),
 * второй публикуется через `PATCH /puzzles/:id { isPublic: true }`.
 *
 * Делает по 4 кадра (desktop+mobile × ru+en) + bonus desktop-RU
 * с tooltip над иконкой Delete.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2673';

fs.mkdirSync(DIR, { recursive: true });

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

async function devBypass(username: string): Promise<Tokens> {
  const res = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_BYPASS_SECRET, user: username }),
  });
  if (!res.ok) throw new Error(`dev-bypass ${res.status}`);
  return (await res.json()) as Tokens;
}

async function seedAuth(
  page: Page,
  tokens: Tokens,
  locale: 'ru' | 'en',
): Promise<void> {
  await page.addInitScript(
    ([a, r, loc]) => {
      localStorage.setItem('token', a);
      localStorage.setItem('refreshToken', r);
      localStorage.setItem('locale', loc);
    },
    [tokens.accessToken, tokens.refreshToken, locale] as [
      string,
      string,
      string,
    ],
  );
}

async function api<T>(
  tokens: Tokens,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

interface BatchPuzzle {
  fen: string;
  moves: string;
  acceptedMoves: string;
  rating: number;
  gap: number;
  themes: string;
  sourceType: string;
  sourceId: string | null;
  sourceMoveNum: number;
  solutionMode: 'play-vs-engine';
  isPublic: boolean;
}

async function seedTwoPuzzles(tokens: Tokens): Promise<{
  publicId: string;
  draftId: string;
}> {
  // KS-2673: backend на dev отдаёт `count: 0` если в БД уже есть пазл
  // с таким же FEN (uniq-constraint по (fen, ...)). Чтобы каждый прогон
  // создавал свежие пазлы, варьируем halfmove/fullmove counter в FEN
  // от timestamp — позиция остаётся той же шахматной, но строка-FEN
  // уникальна.
  // KS-2673: каждая пара уникальна по (halfmove, fullmove) — берём
  // двойной nonce из timestamp+random, чтобы избежать конфликтов с
  // соседними прогонами e2e (которые могут попасть в ту же мс).
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 9000) + 1000;
  const halfA = (ts + rnd) % 99;
  const fullA = ((ts + rnd) % 89) + 10;
  const halfB = (ts + rnd + 17) % 99;
  const fullB = ((ts + rnd + 17) % 89) + 10;
  const PUBLIC: BatchPuzzle = {
    fen: `r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - ${halfA} ${fullA}`,
    moves: '',
    acceptedMoves: '',
    rating: 1500,
    gap: 50,
    themes: 'middlegame',
    sourceType: 'pgn',
    sourceId: `ks2673-${ts}-a`,
    sourceMoveNum: 7,
    solutionMode: 'play-vs-engine',
    isPublic: false,
  };
  const DRAFT: BatchPuzzle = {
    fen: `rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - ${halfB} ${fullB}`,
    moves: '',
    acceptedMoves: '',
    rating: 1450,
    gap: 40,
    themes: 'opening',
    sourceType: 'pgn',
    sourceId: `ks2673-${ts}-b`,
    sourceMoveNum: 5,
    solutionMode: 'play-vs-engine',
    isPublic: false,
  };
  await api(tokens, 'POST', '/puzzles/batch', {
    puzzles: [PUBLIC, DRAFT],
  });
  // Список своих с фильтром по `createdBy` — берём 2 самых свежих
  // (backend сортирует createdAt DESC). При обращении со свежим
  // юзером это будут именно наши seed-пазлы.
  const me = await api<{ id: string }>(tokens, 'GET', '/auth/me');
  const list = await api<{
    data: Array<{
      id: string;
      isPublic: boolean;
      rating: number;
      createdBy: string | null;
    }>;
  }>(tokens, 'GET', '/puzzles/browse?mine=1&source=generated&limit=10');
  const mine = (list.data ?? []).filter(
    (p) => p.createdBy === me.id,
  );
  const publicItem = mine.find((p) => p.rating === 1500);
  const draftItem = mine.find((p) => p.rating === 1450);
  if (!publicItem || !draftItem) {
    throw new Error(
      `seeded puzzles not found (mine=${mine.length}, total=${(list.data ?? []).length})`,
    );
  }
  await api(tokens, 'PATCH', `/puzzles/${publicItem.id}`, {
    isPublic: true,
  });
  return { publicId: publicItem.id, draftId: draftItem.id };
}

async function cleanupPuzzles(
  tokens: Tokens,
  ids: string[],
): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      fetch(`${API_URL}/puzzles/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }).catch(() => {}),
    ),
  );
}

test.describe.configure({ mode: 'serial' });

for (const locale of ['ru', 'en'] as const) {
  test(`KS-2673: /precision?mine=true с реальными пазлами (${locale})`, async ({
    page,
  }, testInfo) => {
    const proj = testInfo.project.name;
    const tokens = await devBypass(`ks2673-${locale}-${proj}-${Date.now()}`);
    const { publicId, draftId } = await seedTwoPuzzles(tokens);
    await seedAuth(page, tokens, locale);
    await page.goto('/precision?mine=true');
    // Дождёмся обеих карточек.
    await page
      .getByTestId('play-vs-engine-card')
      .first()
      .waitFor({ timeout: 15_000 });
    // Карточек должно быть 2.
    const cards = await page.getByTestId('play-vs-engine-card').count();
    if (cards < 2) {
      throw new Error(`expected ≥2 cards, got ${cards}`);
    }
    await page.screenshot({
      path: `${DIR}/${proj}-precision-mine-${locale}.png`,
      fullPage: true,
    });

    // Bonus: tooltip над Delete-иконкой (только desktop+ru — для
    // визуального доказательства локализации).
    if (proj === 'desktop' && locale === 'ru') {
      const deleteBtn = page
        .getByTestId('precision-card-delete')
        .first();
      try {
        await deleteBtn.hover({ timeout: 5_000 });
        // Дать времени появиться CSS-tooltip'у (transition 120ms).
        await page.waitForTimeout(300);
      } catch {
        // hover не критичен — tooltip опционален; всё равно делаем
        // скриншот текущего состояния.
      }
      await page.screenshot({
        path: `${DIR}/${proj}-precision-mine-ru-tooltip.png`,
        fullPage: true,
      });
    }

    await cleanupPuzzles(tokens, [publicId, draftId]);
    void draftId;
  });
}

/**
 * KS-2673 + KS-2675 — Delete действительно удаляет пазл с попытками.
 * Backend в KS-2675 поставил Cascade на FK puzzle_attempts → DELETE
 * `/puzzles/:id` теперь не падает с 500 даже когда есть attempts.
 *
 * Сценарий: создать пазл → submit attempt → DELETE → GET 404.
 */
test('KS-2673/KS-2675: Delete удаляет пазл с attempts (cascade)', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного desktop-прогона.',
  );
  const tokens = await devBypass(`ks2673-cascade-${Date.now()}`);
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 9000) + 1000;
  const half = (ts + rnd) % 99;
  const full = ((ts + rnd) % 89) + 10;
  // 1) Создаём пазл.
  await request.post(`${API_URL}/puzzles/batch`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    data: {
      puzzles: [
        {
          fen: `r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - ${half} ${full}`,
          moves: '',
          acceptedMoves: '',
          rating: 1500,
          gap: 50,
          themes: 'middlegame',
          sourceType: 'pgn',
          sourceId: `cascade-${ts}-${rnd}`,
          sourceMoveNum: 7,
          solutionMode: 'play-vs-engine',
          isPublic: false,
        },
      ],
    },
  });
  const list = await api<{ data: Array<{ id: string; rating: number }> }>(
    tokens,
    'GET',
    '/puzzles/browse?mine=1&source=generated&limit=5',
  );
  const id = list.data?.[0]?.id;
  if (!id) throw new Error('seeded puzzle missing in browse');
  // 2) Submit attempt → создастся puzzle_attempts row.
  const attemptRes = await request.post(
    `${API_URL}/puzzles/${id}/attempts`,
    {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      data: { result: 'solved', timeMs: 1000 },
    },
  );
  if (!attemptRes.ok()) {
    throw new Error(`attempt failed: ${attemptRes.status()}`);
  }
  // 3) DELETE — после KS-2675 не падает на FK constraint.
  const delRes = await request.delete(`${API_URL}/puzzles/${id}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!delRes.ok()) {
    throw new Error(`delete failed: ${delRes.status()}`);
  }
  // 4) GET → 404.
  const getRes = await request.get(`${API_URL}/puzzles/${id}`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (getRes.status() !== 404) {
    throw new Error(`expected 404 after delete, got ${getRes.status()}`);
  }
});
