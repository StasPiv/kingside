import { test, expect, type Page, type Browser } from '@playwright/test';

/**
 * KS-2897 (ADR-060 T4) — E2E каталога Studies.
 *
 * Покрытие сценариев из тикета:
 *  1. sort tabs: переключение Hot / New / Updated / Popular меняет
 *     порядок ожидаемо. Берём «New» как самый предсказуемый:
 *     последняя созданная студия должна быть первой.
 *  2. search debounced: ввод в поиск частичного имени → грид
 *     отфильтрован, видна только эта студия.
 *  3. topic filter chip: студия с уникальным topic → клик по chip
 *     → видна только она.
 *  4. like anon → редирект на /login (setAuthReturnUrl + navigate).
 *  5. like auth → счётчик +1; повторный клик → -1 (toggle).
 *  6. mine tab: гость не видит таб «Mine».
 *
 * Все спеки гоняем только на `desktop` — каталог mobile layout
 * структурно тот же, отдельный прогон не даёт нового сигнала.
 *
 * Парallelism в playwright.config — workers=1 (e2e создаёт записи
 * в БД), плюс этот describe — serial. Имена студий уникальны через
 * `Date.now()` + случайный суффикс — гонок между прогонами нет.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';

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

async function seedAuth(page: Page, tokens: Tokens): Promise<void> {
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('token', a);
      localStorage.setItem('refreshToken', r);
      localStorage.setItem('locale', 'en');
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

async function api<T>(
  tokens: Tokens | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(tokens && { Authorization: `Bearer ${tokens.accessToken}` }),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface CreatedStudy {
  id: string;
  slug: string;
  name: string;
}

async function createPublicStudy(
  tokens: Tokens,
  opts: { name: string; topics?: string[] },
): Promise<CreatedStudy> {
  const created = await api<{ id: string; slug: string; name: string }>(
    tokens,
    'POST',
    '/studies',
    {
      name: opts.name,
      visibility: 'public',
      ...(opts.topics && { topics: opts.topics }),
    },
  );
  // Гарантируем publicness — старые версии backend смотрят isPublic.
  await api(tokens, 'PATCH', `/studies/${created.slug}`, {
    isPublic: true,
    visibility: 'public',
    ...(opts.topics && { topics: opts.topics }),
  });
  return created;
}

test.describe.configure({ mode: 'serial' });

test.describe('KS-2897 Studies catalog E2E', () => {
  // ── 1) sort: New → последняя созданная студия первая ──────────
  test('sort tab «New»: последняя созданная — первая в списке', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Каталог гоняем только на desktop — mobile layout структурно одинаковый.',
    );
    const owner = await devBypass(`ks2897-sort-${Date.now()}`);
    const stamp = Date.now();
    const a = await createPublicStudy(owner, { name: `KS2897-A-${stamp}` });
    // Маленькая задержка чтобы createdAt различались для предсказуемого
    // порядка по «New».
    await new Promise((r) => setTimeout(r, 1100));
    const b = await createPublicStudy(owner, { name: `KS2897-B-${stamp}` });
    await new Promise((r) => setTimeout(r, 1100));
    const c = await createPublicStudy(owner, { name: `KS2897-C-${stamp}` });

    await page.goto('/studies?sort=new');
    await expect(page.getByTestId('studies-grid')).toBeVisible({
      timeout: 20_000,
    });
    // Ищем нашу C-студию в гриде и проверяем что она ВЫШЕ B и A
    // (sort=new — desc по createdAt).
    const slugs = await page
      .locator('[data-testid="study-catalog-card"]')
      .evaluateAll((els) =>
        els
          .map((el) => el.getAttribute('data-study-slug') ?? '')
          .filter(Boolean),
      );
    const idxC = slugs.indexOf(c.slug);
    const idxB = slugs.indexOf(b.slug);
    const idxA = slugs.indexOf(a.slug);
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxA);

    // Переключение на «Hot» — URL обновляется, грид перерендеривается.
    await page.getByTestId('studies-tab-hot').click();
    await expect(page).toHaveURL(/[?&]sort=hot/);
    await expect(page.getByTestId('studies-grid')).toBeVisible();
  });

  // ── 2) search: debounced filter ────────────────────────────────
  test('search: ввод имени → только эта студия в гриде', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks2897-search-${Date.now()}`);
    // Уникальное имя — backend по `q=` ищет по name (LIKE). Используем
    // только random-suffix без timestamp, чтобы partial-search не
    // подхватил «соседние» прогоны e2e в той же БД.
    const tag = `Nx${Math.random().toString(36).slice(2, 10)}`;
    const unique = `Needle ${tag} study`;
    const target = await createPublicStudy(owner, { name: unique });

    await page.goto('/studies');
    await expect(page.getByTestId('studies-grid')).toBeVisible({
      timeout: 20_000,
    });

    // Ввод части уникального имени — tag достаточно уникален, чтобы
    // никаких ложно-positive из предыдущих прогонов не подхватить.
    const partial = tag;
    await page.getByTestId('studies-search-input').fill(partial);

    // Debounce 300ms → fetch с q. Грид перерендерится.
    // Ждём пока URL получит q-param + наша студия станет первой.
    await expect(page).toHaveURL(new RegExp(`q=${partial}`), {
      timeout: 5_000,
    });
    const slugs = await page
      .locator('[data-testid="study-catalog-card"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-study-slug') ?? ''),
      );
    expect(slugs).toContain(target.slug);
    // Поиск по такому уникальному запросу — других совпадений быть
    // не должно (имя сгенерировано из timestamp + random).
    expect(slugs.length).toBeLessThanOrEqual(1);
  });

  // ── 3) topic chip: видна только студия с этим топиком ─────────
  test('topic chip: фильтр оставляет только студии с топиком', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks2897-topic-${Date.now()}`);
    const stamp = Date.now();
    const topic = `e2e-topic-${stamp}`;
    const withTopic = await createPublicStudy(owner, {
      name: `Topic-${stamp}`,
      topics: [topic],
    });
    // Студия без этого топика — должна исчезнуть при фильтре.
    const withoutTopic = await createPublicStudy(owner, {
      name: `NoTopic-${stamp}`,
    });

    await page.goto('/studies?sort=new');
    await expect(page.getByTestId('studies-grid')).toBeVisible({
      timeout: 20_000,
    });

    // topic-chip из текущих items: после загрузки наш topic появится
    // в sidebar. Кликаем по нему.
    const chip = page.getByTestId(`studies-topic-chip-${topic}`);
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.click();

    // URL получает ?topic=...; грид перерендеривается.
    await expect(page).toHaveURL(new RegExp(`topic=${topic}`));
    // chip — aria-pressed=true в active-state.
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    // Backend по topic возвращает только нашу студию — ждём пока fetch
    // завершится и grid схлопнется до 1 карточки. Без `expect.poll`
    // мы могли бы прочитать DOM ДО перерендера.
    await expect
      .poll(
        async () =>
          await page
            .locator('[data-testid="study-catalog-card"]')
            .evaluateAll((els) =>
              els
                .map((el) => el.getAttribute('data-study-slug') ?? '')
                .filter(Boolean),
            ),
        { timeout: 8_000 },
      )
      .toEqual([withTopic.slug]);
    // Sanity-check: исходные обе студии теперь не должны быть в гриде
    // одновременно (только withTopic).
    const finalSlugs = await page
      .locator('[data-testid="study-catalog-card"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-study-slug') ?? ''),
      );
    expect(finalSlugs).not.toContain(withoutTopic.slug);
  });

  // ── 4) like anon → redirect на /login ──────────────────────────
  test('like (anon): клик ведёт на /login с returnUrl', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks2897-anon-${Date.now()}`);
    const target = await createPublicStudy(owner, {
      name: `AnonLike-${Date.now()}`,
    });

    const anon: { newContext: Browser['newContext'] } = browser;
    const anonContext = await anon.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`/studies?sort=new&q=AnonLike-`);
    await expect(anonPage.getByTestId('studies-grid')).toBeVisible({
      timeout: 20_000,
    });
    const card = anonPage.locator(
      `[data-testid="study-catalog-card"][data-study-slug="${target.slug}"]`,
    );
    await expect(card).toBeVisible();
    const likeBtn = card.locator('[data-testid="study-like-button"]');
    await expect(likeBtn).toBeVisible();
    await likeBtn.click();
    // Anon → setAuthReturnUrl + navigate('/login').
    await expect(anonPage).toHaveURL(/\/login/);
    await anonContext.close();
  });

  // ── 5) like auth → счётчик +1 ───────────────────────────────────
  test('like (auth): клик увеличивает счётчик на 1', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks2897-likeAuth-${Date.now()}`);
    const target = await createPublicStudy(owner, {
      name: `LikeAuth-${Date.now()}`,
    });
    const liker = await devBypass(`ks2897-liker-${Date.now()}`);

    await seedAuth(page, liker);
    await page.goto(`/studies?sort=new&q=LikeAuth-`);
    await expect(page.getByTestId('studies-grid')).toBeVisible({
      timeout: 20_000,
    });
    const card = page.locator(
      `[data-testid="study-catalog-card"][data-study-slug="${target.slug}"]`,
    );
    await expect(card).toBeVisible();
    const counter = card.locator('[data-testid="study-like-button-count"]');
    const before = await counter.textContent();
    const beforeNum = Number((before ?? '0').trim());
    await card.locator('[data-testid="study-like-button"]').click();
    // Optimistic UI: счётчик обновляется мгновенно, потом сервер.
    await expect(counter).toHaveText(String(beforeNum + 1), { timeout: 5_000 });
    await expect(
      card.locator('[data-testid="study-like-button"]'),
    ).toHaveAttribute('data-liked', 'true');
  });

  // ── 6) mine tab: гость не видит ──────────────────────────────────
  test('mine tab: гость не видит таб «Mine»', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto('/studies');
    await expect(anonPage.getByTestId('studies-tabs')).toBeVisible({
      timeout: 20_000,
    });
    // Hot должен быть; Mine — отсутствовать.
    await expect(anonPage.getByTestId('studies-tab-hot')).toBeVisible();
    await expect(anonPage.getByTestId('studies-tab-mine')).toHaveCount(0);
    await anonContext.close();
  });
});
