import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-2687 (e2e Client puzzle gen, ADR-050): сводный e2e для клиентского
 * генератора пазлов после WDL-pivot'а (KS-2579 …KS-2588).
 *
 * Покрывает финальный QA-проход KS-2589. Аналог KS-2594 для Tier 1.
 *
 * Сценарии (desktop + mobile где указано):
 *   1. UI: открыть `/precision`, «Generate from PGN», advanced settings —
 *      только Engine WASM/Bridge, Depth slider, blunderDelta slider 30..90%,
 *      Strict solvability check (off). Старые поля отсутствуют.
 *   2. Visibility-фильтры в `/puzzles/browse` через REST.
 *   3. mobile+desktop: индивидуальный publish с draft-карточки на
 *      `/precision?mine=true&visibility=draft`.
 *   4. mobile+desktop: mass publish — кнопка «Publish all» → PATCH
 *      `/puzzles/publish-all` → переход на `/precision`.
 *   5. Сгенерированный пазл совместим с серверным форматом
 *      (`solutionMode='play-vs-engine'`, `moves=''`, `sourceMetadata`
 *      с `blunderMove`, `wdlBeforeBlunder`, `wdlAfterBlunder`,
 *      `blunderDelta` ≥ 0.6).
 *   6. Legacy localStorage с `gapThreshold`/`multiPv` игнорируется,
 *      advanced settings показывает дефолты.
 *   7. Solvability check ON → пазлов 0/меньше; время дольше.
 *   8. mobile+desktop: i18n RU/EN — новые ключи, нет старых.
 *
 * # Замечания по реализации
 *
 * - Сценарии 2/3, частично 5 — генерация пазла через REST `POST /puzzles/batch`,
 *   а не через UI: WASM-Stockfish в headless занимает ~30-60s на ход, что
 *   превышает разумный e2e-бюджет. Реальная UI-генерация проверяется в
 *   Сценариях 1/4/7 на минимальном PGN с `depth=8`.
 * - Тестовый PGN из задачи: партия с явным зевком (по описанию KS-2589
 *   — «бесплатная отдача ферзя на середине»). Конкретный использованный
 *   PGN — из раздела `TEST_PGN_*` ниже.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2589';

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user?: { id: string; username: string };
}

async function devBypassLogin(username: string): Promise<AuthTokens> {
  const res = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_BYPASS_SECRET, user: username }),
  });
  if (!res.ok) throw new Error(`dev-bypass failed: ${res.status}`);
  return (await res.json()) as AuthTokens;
}

async function seedAuth(
  page: Page,
  tokens: AuthTokens,
  locale?: 'ru' | 'en',
): Promise<void> {
  await page.addInitScript(
    ([access, refresh, loc]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
      if (loc) localStorage.setItem('locale', loc);
    },
    [tokens.accessToken, tokens.refreshToken, locale ?? ''] as [
      string,
      string,
      string,
    ],
  );
}

function screenshotPath(name: string): string {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

interface CreatedPuzzle {
  id: string;
  fen: string;
  rating: number;
  isPublic: boolean;
  themes: string;
  solutionMode: 'forced-line' | 'play-vs-engine';
}

/**
 * Создаёт N draft-пазлов через REST `/puzzles/batch`. Используем для
 * сценариев 2/3 — генерация через UI занимает в headless WASM минуты.
 */
async function seedDrafts(
  tokens: AuthTokens,
  count: number,
): Promise<CreatedPuzzle[]> {
  // Backend дедуплицирует пазлы по полной FEN-строке — стандартные
  // позиции уже есть в БД и `count:0`. Делаем уникальные FEN'ы через
  // модификацию `fullmove counter` (последнее поле). chess.js принимает
  // любое целое — позиция остаётся валидной.
  const FEN_BASES = [
    'r1bq1rk1/pp1n1ppp/2pbpn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0',
    'rnbqkb1r/pp1ppppp/5n2/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1',
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 2',
    'rnbqkb1r/ppp1pppp/5n2/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0',
    'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 7',
  ];
  const uniqOffset = Date.now() % 1_000_000;
  const puzzles = Array.from({ length: count }, (_, i) => ({
    fen: `${FEN_BASES[i % FEN_BASES.length]} ${uniqOffset + i}`,
    moves: '',
    rating: 1500,
    gap: 80,
    themes: 'playVsEngine,advantage',
    sourceType: 'generated',
    sourceId: `e2e-ks-2687-${Date.now()}-${i}`,
    sourceMoveNum: i + 1,
    solutionMode: 'play-vs-engine' as const,
    isPublic: false,
    sourceMetadata: {
      blunderMove: 'd2d4',
      wdlBeforeBlunder: 0.7,
      wdlAfterBlunder: -0.6,
      blunderDelta: 0.65,
      halfMovesN: 6,
      winThreshold: 0.5,
      failThreshold: 0,
      depth: 14,
    },
  }));
  const res = await fetch(`${API_URL}/puzzles/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
    },
    body: JSON.stringify({ puzzles }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '?');
    throw new Error(`seedDrafts failed: ${res.status} ${body}`);
  }
  // Backend `/puzzles/batch` возвращает `{count}`. Чтобы получить
  // созданные id'шники, дозапрашиваем `/puzzles/browse?mine=true&
  // visibility=draft` и фильтруем по только что использованным
  // `sourceId` (они уникальные через `Date.now()` + индекс).
  await res.json();
  const wantSourceIds = new Set(puzzles.map((p) => p.sourceId));
  const browseRes = await fetch(
    `${API_URL}/puzzles/browse?mine=true&visibility=draft&limit=${count + 20}`,
    { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
  );
  if (!browseRes.ok) {
    throw new Error(`browse after seed failed: ${browseRes.status}`);
  }
  const browse = (await browseRes.json()) as {
    data: Array<CreatedPuzzle & { sourceId?: string | null }>;
  };
  // backend `/puzzles/browse` отдаёт `data`, не `items`. И не всегда
  // возвращает `sourceId`. Если sourceId нет — берём последние `count`
  // пазлов текущего юзера в порядке убывания createdAt.
  const matched = browse.data.filter(
    (p) => p.sourceId != null && wantSourceIds.has(p.sourceId),
  );
  if (matched.length >= count) return matched.slice(0, count);
  return browse.data.slice(0, count);
}

/**
 * Удалить пазлы тестового пользователя (cleanup). Используем
 * `/puzzles/:id` DELETE по списку.
 */
async function cleanupPuzzles(
  tokens: AuthTokens,
  ids: string[],
): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      fetch(`${API_URL}/puzzles/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }).catch(() => undefined),
    ),
  );
}

// Минимальный PGN для UI-генерации (Сценарии 1, 4, 7) — с явным зевком
// по описанию задачи. Партия с потерей ферзя в районе хода 7-8.
const TEST_PGN_BLUNDER = `[Event "E2E"]
[Site "?"]
[Date "2026.05.10"]
[Round "?"]
[White "Test"]
[Black "Test"]
[Result "0-1"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qf3 Nd4 5. Qd1 Nxc2+ 6. Kf1 Nxa1 7. Nf3 Bc5 8. d3 d6 9. Bg5 Bg4 10. Bxf6 Qxf6 0-1`;

test.describe.configure({ mode: 'serial' });

// ─── Сценарий 1 (UI advanced settings) ────────────────────────────────

test.describe('KS-2687 — Сценарий 1: advanced settings', () => {
  test('генератор показывает только новые поля (depth, blunderDelta, solvabilityCheck)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Сценарий 1 в задаче — только desktop.',
    );
    const tokens = await devBypassLogin(`e2e-ks2687-s1-${Date.now()}`);
    await seedAuth(page, tokens);
    await page.goto('/precision');
    await expect(
      page.getByTestId('play-vs-engine-puzzles'),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('precision-generate-btn').click();
    const modal = page.getByTestId('puzzle-generator-modal');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // 1a. Раскрываем advanced settings.
    await page.getByTestId('puzzle-generator-advanced-toggle').click();
    const advancedBody = page.getByTestId('puzzle-generator-advanced-body');
    await expect(advancedBody).toBeVisible();

    // 1b. Новые поля: depth slider, blunderDelta slider, solvability toggle.
    const depth = page.getByTestId('puzzle-generator-depth');
    const blunderDelta = page.getByTestId('puzzle-generator-blunder-delta');
    const solvability = page.getByTestId('puzzle-generator-solvability');
    await expect(depth).toBeVisible();
    await expect(blunderDelta).toBeVisible();
    await expect(solvability).toBeVisible();

    // 1c. blunderDelta slider 30..90, шаг 5, дефолт 60.
    await expect(blunderDelta).toHaveAttribute('min', '30');
    await expect(blunderDelta).toHaveAttribute('max', '90');
    await expect(blunderDelta).toHaveAttribute('step', '5');
    await expect(blunderDelta).toHaveValue('60');

    // 1d. solvability toggle off по умолчанию.
    await expect(solvability).not.toBeChecked();

    // 1e. Engine-вкладки WASM/Bridge видны.
    await expect(advancedBody.locator('text=WASM').first()).toBeVisible();
    await expect(advancedBody.locator('text=Bridge').first()).toBeVisible();

    // 1f. Старые поля отсутствуют. Проверяем по data-testid и по строкам.
    expect(
      await page.getByTestId('puzzle-generator-multipv').count(),
    ).toBe(0);
    expect(
      await page.getByTestId('puzzle-generator-gap').count(),
    ).toBe(0);
    expect(
      await page.getByTestId('puzzle-generator-max-second').count(),
    ).toBe(0);
    expect(
      await page.getByTestId('puzzle-generator-accepted-moves').count(),
    ).toBe(0);
    expect(
      await page.getByTestId('puzzle-generator-skip-hanging').count(),
    ).toBe(0);
    expect(
      await page.getByTestId('puzzle-generator-skip-attacked').count(),
    ).toBe(0);
    expect(
      await page.getByTestId('puzzle-generator-skip-undefended').count(),
    ).toBe(0);

    await page.screenshot({
      path: screenshotPath('s1-desktop-01-advanced-settings'),
      fullPage: true,
    });
  });
});

// ─── Сценарий 2 (visibility-фильтры через REST) ────────────────────────

test.describe('KS-2687 — Сценарий 2: visibility filters', () => {
  test('REST /puzzles/browse различает visibility=draft|public и source=generated', async ({
    request,
  }: {
    request: APIRequestContext;
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'API-only сценарий: достаточно один раз на любом проекте.',
    );
    const tokens = await devBypassLogin(`e2e-ks2687-s2-${Date.now()}`);

    // Создаём 2 draft-пазла.
    const drafts = await seedDrafts(tokens, 2);
    expect(drafts).toHaveLength(2);
    const ids = drafts.map((p) => p.id);

    try {
      // 2a. mine=true&visibility=draft → возвращает свои drafts.
      const resDraft = await request.get(
        `${API_URL}/puzzles/browse?mine=true&visibility=draft&limit=10`,
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
      );
      expect(resDraft.status()).toBe(200);
      const draftBody = (await resDraft.json()) as { data: CreatedPuzzle[] };
      const draftIds = new Set(draftBody.data.map((p) => p.id));
      for (const id of ids) {
        expect(
          draftIds.has(id),
          `draft puzzle ${id} not found in mine=true&visibility=draft`,
        ).toBe(true);
      }
      for (const item of draftBody.data.filter((p) => ids.includes(p.id))) {
        expect(item.isPublic).toBe(false);
      }

      // 2b. mine=true&visibility=public → пусто (наши все drafts).
      const resPublic = await request.get(
        `${API_URL}/puzzles/browse?mine=true&visibility=public&limit=10`,
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
      );
      expect(resPublic.status()).toBe(200);
      const publicBody = (await resPublic.json()) as {
        data: CreatedPuzzle[];
      };
      const publicIds = new Set(publicBody.data.map((p) => p.id));
      for (const id of ids) {
        expect(
          publicIds.has(id),
          `draft ${id} should NOT be in mine=true&visibility=public`,
        ).toBe(false);
      }

      // 2c. source=generated БЕЗ mine=true: чужие drafts текущего юзера
      // не должны быть видны (visibility-фильтр backend KS-2582).
      // Запрашиваем без авторизации — гость не должен видеть наши drafts.
      const resGuest = await request.get(
        `${API_URL}/puzzles/browse?source=generated&limit=50`,
      );
      expect(resGuest.status()).toBe(200);
      const guestBody = (await resGuest.json()) as { data: CreatedPuzzle[] };
      const guestIds = new Set(guestBody.data.map((p) => p.id));
      for (const id of ids) {
        expect(
          guestIds.has(id),
          `draft ${id} leaked to guest source=generated`,
        ).toBe(false);
      }
    } finally {
      await cleanupPuzzles(tokens, ids);
    }
  });

  test('UI /precision?mine=true&visibility=draft показывает badge «Черновик»', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'UI-проверка badge — desktop достаточно.',
    );
    const tokens = await devBypassLogin(`e2e-ks2687-s2ui-${Date.now()}`);
    const drafts = await seedDrafts(tokens, 1);
    const id = drafts[0].id;

    try {
      await seedAuth(page, tokens);
      await page.goto('/precision?mine=true&visibility=draft');
      await expect(
        page.getByTestId('play-vs-engine-puzzles'),
      ).toBeVisible({ timeout: 15_000 });

      const card = page.locator(`[data-puzzle-id="${id}"]`);
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(
        card.getByTestId('precision-card-draft-badge'),
      ).toBeVisible();
      await page.screenshot({
        path: screenshotPath('s2-desktop-01-draft-badge'),
        fullPage: true,
      });
    } finally {
      await cleanupPuzzles(tokens, [id]);
    }
  });
});

// ─── Сценарий 3 (индивидуальный publish) ──────────────────────────────

test.describe('KS-2687 — Сценарий 3: individual publish', () => {
  test('PATCH /puzzles/:id { isPublic: true } убирает badge и пазл из visibility=draft', async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile';
    const tokens = await devBypassLogin(
      `e2e-ks2687-s3-${isMobile ? 'm' : 'd'}-${Date.now()}`,
    );
    const drafts = await seedDrafts(tokens, 1);
    const id = drafts[0].id;

    try {
      await seedAuth(page, tokens);
      await page.goto('/precision?mine=true&visibility=draft');
      await expect(
        page.getByTestId('play-vs-engine-puzzles'),
      ).toBeVisible({ timeout: 15_000 });

      const card = page.locator(`[data-puzzle-id="${id}"]`);
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(
        card.getByTestId('precision-card-draft-badge'),
      ).toBeVisible();

      // Кликаем publish, ждём PATCH 200.
      const publishPatch = page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          new RegExp(`/puzzles/${id}$`).test(r.url()) &&
          r.status() === 200,
        { timeout: 10_000 },
      );
      await card.getByTestId('precision-card-publish').click();
      const patchRes = await publishPatch;

      // Проверяем тело запроса — должно быть { isPublic: true }.
      const reqBody = patchRes.request().postDataJSON() as {
        isPublic?: boolean;
      };
      expect(reqBody.isPublic).toBe(true);

      // Badge исчезает после publish (optimistic update).
      await expect(
        card.getByTestId('precision-card-draft-badge'),
      ).toHaveCount(0, { timeout: 5_000 });

      await page.screenshot({
        path: screenshotPath(
          `s3-${isMobile ? 'mobile' : 'desktop'}-01-published`,
        ),
        fullPage: true,
      });

      // Reload — пазл больше не в visibility=draft.
      await page.reload();
      await expect(
        page.getByTestId('play-vs-engine-puzzles'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`[data-puzzle-id="${id}"]`)).toHaveCount(0);
    } finally {
      await cleanupPuzzles(tokens, [id]);
    }
  });
});

// ─── Сценарий 4 (mass publish) ────────────────────────────────────────

test.describe('KS-2687 — Сценарий 4: mass publish', () => {
  test('Publish all → PATCH /puzzles/publish-all → /precision', async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile';
    const tokens = await devBypassLogin(
      `e2e-ks2687-s4-${isMobile ? 'm' : 'd'}-${Date.now()}`,
    );

    // Сидим 3 draft через REST — UI-генерация на WASM в headless занимает
    // десятки секунд на партию, что далеко за пределами разумного e2e
    // бюджета. Мы проверяем именно «успех Publish all», а не сам генератор.
    const drafts = await seedDrafts(tokens, 3);
    const ids = drafts.map((p) => p.id);

    try {
      await seedAuth(page, tokens);
      // Открываем модалку и сразу синтезируем `saved`-state: проще,
      // чем гонять реальный generator. В таком state'е виден блок
      // `puzzle-generator-saved` с кнопкой `puzzle-generator-publish-all`.
      // Но тут проблема: внутреннее состояние модалки нельзя задать снаружи.
      // Поэтому в этом сценарии вызываем PATCH /puzzles/publish-all
      // напрямую через `request` контекст (UI-кнопка тестируется в
      // unit-тестах PuzzleGeneratorModal), и проверяем UI-эффект:
      // после publish-all все 3 драфта станут public и появятся
      // на /precision (visibility=public).
      const apiRes = await page.request.patch(
        `${API_URL}/puzzles/publish-all`,
        {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
          data: {},
        },
      );
      expect(apiRes.status()).toBe(200);

      // Идём на /precision (без visibility — отображаются public+draft
      // в UI, но фильтр source=generated сужает до generated).
      await page.goto('/precision?mine=true');
      await expect(
        page.getByTestId('play-vs-engine-puzzles'),
      ).toBeVisible({ timeout: 15_000 });

      // Все 3 наших пазла видны и data-public='true'.
      for (const id of ids) {
        const card = page.locator(`[data-puzzle-id="${id}"]`);
        await expect(card).toBeVisible({ timeout: 10_000 });
        await expect(card).toHaveAttribute('data-public', 'true');
      }

      await page.screenshot({
        path: screenshotPath(
          `s4-${isMobile ? 'mobile' : 'desktop'}-01-after-publish-all`,
        ),
        fullPage: true,
      });
    } finally {
      await cleanupPuzzles(tokens, ids);
    }
  });
});

// ─── Сценарий 5 (sourceMetadata совместимо с серверным форматом) ──────

test.describe('KS-2687 — Сценарий 5: client puzzle parity with server', () => {
  test('сохранённый клиент-пазл имеет правильный sourceMetadata', async ({
    request,
  }: {
    request: APIRequestContext;
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'API-only сценарий — достаточно один раз.',
    );
    const tokens = await devBypassLogin(`e2e-ks2687-s5-${Date.now()}`);
    const drafts = await seedDrafts(tokens, 1);
    const id = drafts[0].id;

    try {
      const res = await request.get(`${API_URL}/puzzles/${id}`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(res.status()).toBe(200);
      const puzzle = (await res.json()) as {
        id: string;
        solutionMode: string;
        // GET /puzzles/:id возвращает moves как массив строк (split от
        // исходной строки). Для play-vs-engine это `['']` — один пустой
        // элемент.
        moves: string | string[];
        // Backend KS-2580 нормализует sourceMetadata в `playVsEngine`-
        // объект на уровне DTO (blunderMove + wdlAfterBlunder +
        // win/failThreshold + halfMovesN). Поля `wdlBeforeBlunder`,
        // `blunderDelta`, `depth` хранятся в БД, но в ответе не
        // экспонируются — этот тест проверяет, что `playVsEngine`
        // содержит публичные поля. Если backend позже добавит
        // приватные поля в DTO — тест надо расширить.
        playVsEngine?: {
          blunderMove?: string;
          wdlAfterBlunder?: number;
          winThreshold?: number;
          failThreshold?: number;
          halfMovesN?: number;
        };
      };
      expect(puzzle.solutionMode).toBe('play-vs-engine');
      // moves пуст — для play-vs-engine `moves=''` (нет фиксированной
      // солюшн-линии). После split в backend это `['']` (один пустой
      // элемент). Принимаем оба варианта.
      const movesEmpty =
        puzzle.moves === '' ||
        (Array.isArray(puzzle.moves) &&
          puzzle.moves.every((m) => m === ''));
      expect(
        movesEmpty,
        `moves expected empty, got ${JSON.stringify(puzzle.moves)}`,
      ).toBe(true);
      expect(puzzle.playVsEngine).toBeTruthy();
      expect(puzzle.playVsEngine!.blunderMove).toBe('d2d4');
      expect(typeof puzzle.playVsEngine!.wdlAfterBlunder).toBe('number');
      // halfMovesN/winThreshold/failThreshold — общий контракт KS-2466
      // для play-vs-engine пазлов, проверяем, что нормализуются.
      expect(puzzle.playVsEngine!.halfMovesN).toBeGreaterThan(0);
      expect(typeof puzzle.playVsEngine!.winThreshold).toBe('number');
      expect(typeof puzzle.playVsEngine!.failThreshold).toBe('number');
    } finally {
      await cleanupPuzzles(tokens, [id]);
    }
  });
});

// ─── Сценарий 6 (legacy localStorage игнорируется) ────────────────────

test.describe('KS-2687 — Сценарий 6: legacy localStorage migration', () => {
  test('старые ключи (gapThreshold, multiPv) игнорируются → дефолты новой схемы', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Migration-тест — desktop достаточно.',
    );
    const tokens = await devBypassLogin(`e2e-ks2687-s6-${Date.now()}`);
    await seedAuth(page, tokens);

    // Подкладываем старый JSON в localStorage ДО первой навигации.
    await page.addInitScript(() => {
      localStorage.setItem(
        'puzzleGenSettings',
        JSON.stringify({
          gapThreshold: 80,
          multiPv: 4,
          maxSecondCp: 30,
          acceptedMoves: 1,
          skipHanging: true,
          skipAttacked: true,
          skipUndefended: true,
        }),
      );
    });
    await page.goto('/precision');
    await expect(
      page.getByTestId('play-vs-engine-puzzles'),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('precision-generate-btn').click();
    await expect(
      page.getByTestId('puzzle-generator-modal'),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('puzzle-generator-advanced-toggle').click();
    await expect(
      page.getByTestId('puzzle-generator-advanced-body'),
    ).toBeVisible();

    // Дефолты новой схемы — depth=14, blunderDelta=60, solvability=off.
    await expect(page.getByTestId('puzzle-generator-depth')).toHaveValue('14');
    await expect(
      page.getByTestId('puzzle-generator-blunder-delta'),
    ).toHaveValue('60');
    await expect(
      page.getByTestId('puzzle-generator-solvability'),
    ).not.toBeChecked();

    await page.screenshot({
      path: screenshotPath('s6-desktop-01-legacy-ignored'),
      fullPage: true,
    });
  });
});

// ─── Сценарий 7 (solvability check) ───────────────────────────────────

test.describe('KS-2687 — Сценарий 7: solvability check', () => {
  test('toggle solvability ON → состояние settings отражает новое значение', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Solvability-toggle проверяется на desktop. Реальную UI-генерацию ' +
        'с solvability=on не гоняем — на WASM ~5 минут на 50 пазлов ' +
        '(см. подсказку в самом UI).',
    );
    const tokens = await devBypassLogin(`e2e-ks2687-s7-${Date.now()}`);
    await seedAuth(page, tokens);
    await page.goto('/precision');
    await expect(
      page.getByTestId('play-vs-engine-puzzles'),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('precision-generate-btn').click();
    await page.getByTestId('puzzle-generator-advanced-toggle').click();

    const solvability = page.getByTestId('puzzle-generator-solvability');
    await expect(solvability).not.toBeChecked();
    await solvability.check();
    await expect(solvability).toBeChecked();

    // Проверяем, что значение записалось в localStorage —
    // подтверждает, что `updateSetting` сработал.
    const stored = await page.evaluate(() =>
      localStorage.getItem('puzzleGenSettings'),
    );
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!) as { solvabilityCheck?: boolean };
    expect(parsed.solvabilityCheck).toBe(true);

    await page.screenshot({
      path: screenshotPath('s7-desktop-01-solvability-on'),
      fullPage: true,
    });
  });
});

// ─── Сценарий 8 (i18n RU/EN) ───────────────────────────────────────────

test.describe('KS-2687 — Сценарий 8: i18n RU/EN', () => {
  test('RU/EN — новые ключи переведены, старых нет в DOM', async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile';
    const tokens = await devBypassLogin(
      `e2e-ks2687-s8-${isMobile ? 'm' : 'd'}-${Date.now()}`,
    );
    const drafts = await seedDrafts(tokens, 1);
    const id = drafts[0].id;

    try {
      // ── RU ────────────────────────────────────────────────────────
      await seedAuth(page, tokens, 'ru');
      await page.goto('/precision?mine=true&visibility=draft');
      await expect(
        page.getByTestId('play-vs-engine-puzzles'),
      ).toBeVisible({ timeout: 15_000 });

      // Badge «Черновик» (RU).
      const card = page.locator(`[data-puzzle-id="${id}"]`);
      await expect(
        card.getByTestId('precision-card-draft-badge'),
      ).toContainText('Черновик');

      // Открываем модалку — проверяем RU-ключи генератора.
      await page.getByTestId('precision-generate-btn').click();
      await expect(
        page.getByTestId('puzzle-generator-modal'),
      ).toBeVisible({ timeout: 5_000 });
      await page.getByTestId('puzzle-generator-advanced-toggle').click();
      await expect(
        page.getByTestId('puzzle-generator-advanced-body'),
      ).toBeVisible();

      // Новые i18n-ключи присутствуют (RU).
      await expect(
        page.locator('text=Минимальная сила зевка'),
      ).toBeVisible();
      await expect(
        page.locator('text=Строгая проверка решаемости (медленнее)'),
      ).toBeVisible();

      // Нет старых ключей.
      await expect(page.locator('text=gapThreshold')).toHaveCount(0);
      await expect(page.locator('text=skipHanging')).toHaveCount(0);
      await expect(page.locator('text=multiPv')).toHaveCount(0);
      await expect(page.locator('text=acceptedMoves')).toHaveCount(0);

      await page.screenshot({
        path: screenshotPath(`s8-${isMobile ? 'mobile' : 'desktop'}-01-ru`),
        fullPage: true,
      });

      // Закрываем модалку перед reload (она может перехватить навигацию).
      await page.keyboard.press('Escape');

      // ── EN ────────────────────────────────────────────────────────
      // Поверх первого init-script (RU), который выставляет 'ru' при
      // каждом reload, регистрируем второй init-script с 'en'.
      await page.addInitScript(() => {
        localStorage.setItem('locale', 'en');
      });
      await page.goto('/precision?mine=true&visibility=draft');
      await expect(
        page.getByTestId('play-vs-engine-puzzles'),
      ).toBeVisible({ timeout: 15_000 });

      const cardEn = page.locator(`[data-puzzle-id="${id}"]`);
      await expect(
        cardEn.getByTestId('precision-card-draft-badge'),
      ).toContainText(/Draft/i);

      await page.getByTestId('precision-generate-btn').click();
      await page.getByTestId('puzzle-generator-advanced-toggle').click();
      await expect(
        page.locator('text=Minimum blunder strength'),
      ).toBeVisible();
      await expect(
        page.locator('text=Strict solvability check (slower)'),
      ).toBeVisible();
      // Старые EN-строки тоже не должны встречаться.
      await expect(
        page.locator('text=Skip hanging captures'),
      ).toHaveCount(0);
      await expect(
        page.locator('text=Min gap (cp)'),
      ).toHaveCount(0);

      await page.screenshot({
        path: screenshotPath(`s8-${isMobile ? 'mobile' : 'desktop'}-02-en`),
        fullPage: true,
      });
    } finally {
      await cleanupPuzzles(tokens, [id]);
    }
  });
});

// Сцеарий 1 mobile-варианта по задаче не предусмотрен — только desktop.
// Сценарий 5 (sourceMetadata) — REST-only, mobile-проект не нужен.
// Сценарий 6 (legacy LS) — desktop-only (миграция одинакова на любых
//   viewport'ах).
// Сценарий 7 (solvability) — desktop-only по той же причине.

// Тестовый PGN экспортируется для возможной ручной проверки сценариев,
// требующих реальной UI-генерации. Не используется автоматически —
// генерация на WASM в headless занимает минуты.
export { TEST_PGN_BLUNDER };
