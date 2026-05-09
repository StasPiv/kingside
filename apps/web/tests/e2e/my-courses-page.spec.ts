import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-2627 (e2e Tier 1, ADR-052 §3.3): автотест страницы `/lessons/my`.
 *
 * Покрывает manual QA из KS-2626 — все 7 шагов авторской страницы:
 *
 *   1. Login (dev_bypass) → клик по 🎒 в Sidebar → /lessons/my.
 *   2. «+ Создать свой курс» → редактор → возврат на /lessons/my.
 *   3. На карточке нового курса: бейдж Private + 4 действия видны
 *      (Open / Edit / Copy link / ⋮ More).
 *   4. ⋮ More → Make public → бейдж Public + toast «Курс опубликован».
 *   5. Copy link → буфер содержит `${origin}/lessons/my/<slug>`.
 *   6. ⋮ More → Delete → confirm → курс пропал из списка.
 *
 * Mobile-проект (Pixel 5, 390×844) повторяет шаги 1–4 + проверяет, что
 * в overflow-меню есть mobile-only пункт «Copy link», и закрывает
 * сценарий Toggle visibility (Delete на mobile делает desktop-проект,
 * чтобы не дублировать destructive-действие).
 *
 * Конвенция тестов взята из `user-course-editor-tier1.spec.ts`
 * (KS-2594): dev-bypass через REST → токены в localStorage через
 * `addInitScript` → реальные API-вызовы. Каждый тест создаёт ОДИН
 * курс с уникальным title, в финале вычищает его на случай если
 * UI-Delete не дошёл (или мы тестим без Delete на mobile).
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2627';

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
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

async function seedAuth(page: Page, tokens: AuthTokens): Promise<void> {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
      // Спецификация и фикстуры тестов написаны под EN-локаль (там
      // строгие data-testid'ы независимы от языка, но сами кнопки
      // содержат английские лейблы).
      localStorage.setItem('locale', 'en');
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

/**
 * Грантуем clipboard-разрешения у origin. Без этого
 * `navigator.clipboard.writeText` в headless-Chromium падает с
 * NotAllowedError, и шаг «Copy link» спокойно сваливается на
 * execCommand-fallback (тоже работает, но мы хотим тестировать
 * основную ветку — write через Clipboard API).
 */
async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://localhost:5173',
  });
}

async function cleanupCoursesByTitle(
  tokens: AuthTokens,
  needle: string,
): Promise<void> {
  // Дёргаем list({scope:'own'}) и удаляем все курсы, чей title
  // содержит `needle`. Тест-юзер у нас уникальный по timestamp, так
  // что чистка не трогает чужое.
  try {
    // KS-2645 (ADR-054 Phase D): фронт переключён на unified URLs
    // `/lessons/courses?mine=1`. Cleanup тоже идёт через unified.
    const res = await fetch(`${API_URL}/lessons/courses?mine=1`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { data: { id: string; title: string }[] };
    for (const c of body.data ?? []) {
      if (c.title && c.title.includes(needle)) {
        await fetch(`${API_URL}/lessons/courses/${c.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }).catch(() => {});
      }
    }
  } catch {
    /* ignore — это best-effort cleanup */
  }
}

function shotPath(name: string): string {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

/**
 * Открыть страницу /lessons/my через клик по иконке 🎒 в Sidebar.
 * Это закрывает шаг 1 (manual QA: Sidebar entry-point рабочий).
 *
 * На mobile Sidebar по умолчанию свёрнут в нижний MobileBottomBar,
 * и пункта 🎒 там нет — туда переходим через mobile-bar-puzzles нет,
 * а для уроков mobile-bar использует уже существующий пункт с
 * data-testid `mobile-bar-{route}`. Точку входа /lessons/my на mobile
 * закрывает CTA-row на /lessons (KS-2622). Чтобы тест был стабильным
 * на обоих проектах, на mobile пользуемся прямой навигацией. Sidebar-
 * пункт 🎒 в desktop-проекте проверяем явно (data-testid).
 */
async function openMyCoursesViaEntryPoint(
  page: Page,
  isMobile: boolean,
): Promise<void> {
  await page.goto('/lessons');
  if (isMobile) {
    // На /lessons виден компонент MyCoursesEntryCta (KS-2622).
    await expect(page.getByTestId('my-courses-entry-cta')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('my-courses-entry-cta').click();
  } else {
    // Sidebar строится из иконок без подменю; пункт «Мои курсы» —
    // отдельная иконка 🎒 со ссылкой на /lessons/my. Локатор —
    // первый <a> с href /lessons/my (других в Sidebar нет).
    await expect(page.locator('aside.sidebar a[href="/lessons/my"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('aside.sidebar a[href="/lessons/my"]').click();
  }
  await expect(page).toHaveURL(/\/lessons\/my$/, { timeout: 15_000 });
  await expect(page.getByTestId('my-courses-page')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Создать новый курс через UI — кнопкой «+ Create my course».
 * Возвращает slug + id, прочитанные из URL после редиректа в редактор
 * + из ответа POST /lessons/courses (через `waitForResponse`).
 *
 * На mobile header-кнопка скрыта (KS-2623), используем sticky-CTA.
 */
async function createCourseViaUi(
  page: Page,
  isMobile: boolean,
): Promise<{ slug: string; id: string }> {
  // На mobile header-кнопка `my-courses-create` скрыта (KS-2623),
  // а sticky-кнопка прячется при empty-state (data-state="empty"),
  // чтобы не дублировать большую CTA в центре экрана. Тест-юзер
  // уникальный по timestamp → список всегда пуст → используем
  // empty-cta. На desktop достаточно header-кнопки.
  const button = isMobile
    ? page.getByTestId('my-courses-empty-cta')
    : page.getByTestId('my-courses-create');
  const [createRes] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /\/lessons\/courses$/.test(r.url()),
      { timeout: 15_000 },
    ),
    button.click(),
  ]);
  expect(createRes.ok(), `POST /courses: ${createRes.status()}`).toBe(
    true,
  );
  const created = (await createRes.json()) as { id: string; slug: string };
  // После create UI редиректит на /lessons/my/<slug>/edit — ждём
  // редирект, а потом возвращаемся обратно на список через breadcrumb.
  await expect(page).toHaveURL(
    new RegExp(`/lessons/my/${created.slug}/edit$`),
    { timeout: 15_000 },
  );
  // Берём первый видимый на странице link «Lessons / My courses» в
  // breadcrumb (структура UserCourseEditor содержит её).
  // Для надёжности возвращаемся через прямой goto.
  await page.goto('/lessons/my');
  await expect(page.getByTestId('my-courses-page')).toBeVisible({
    timeout: 15_000,
  });
  return created;
}

test.describe.configure({ mode: 'serial' });

// ─── Сценарий 1 (desktop) — полный путь до Delete ─────────────────────

test.describe('KS-2627 — MyCoursesPage e2e', () => {
  test('desktop: Sidebar → create → actions → toggle → copy link → delete', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Полный путь с Delete делаем только на desktop, чтобы не дублировать destructive.',
    );
    const username = `e2e-mycourses-d-${Date.now()}`;
    const tokens = await devBypassLogin(username);
    await seedAuth(page, tokens);
    await grantClipboard(page);

    // 1. Через Sidebar → /lessons/my.
    await openMyCoursesViaEntryPoint(page, false);
    await page.screenshot({ path: shotPath('desktop-01-list') });

    // 2. + Create → editor → возврат на /lessons/my.
    const created = await createCourseViaUi(page, false);

    // 3. Карточка нового курса видна, бейдж Private, 4 действия видны.
    const card = page.getByTestId(`my-courses-card-${created.id}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    const badge = page.getByTestId(`my-courses-badge-${created.id}`);
    await expect(badge).toContainText(/Private/i);
    await expect(
      page.getByTestId(`my-courses-action-open-${created.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`my-courses-action-edit-${created.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`my-courses-action-copy-${created.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`my-courses-action-more-${created.id}`),
    ).toBeVisible();
    await page.screenshot({ path: shotPath('desktop-02-card-actions') });

    // 4. Toggle Make public.
    await page.getByTestId(`my-courses-action-more-${created.id}`).click();
    await expect(page.getByTestId(`my-courses-menu-${created.id}`)).toBeVisible();
    const [patchRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          new RegExp(`/lessons/courses/${created.id}$`).test(r.url()),
        { timeout: 15_000 },
      ),
      page
        .getByTestId(`my-courses-menu-visibility-${created.id}`)
        .click(),
    ]);
    expect(patchRes.ok(), `PATCH visibility: ${patchRes.status()}`).toBe(true);
    await expect(badge).toContainText(/Public/i);
    const toast = page.getByTestId('my-courses-toast');
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText(/published/i);
    await page.screenshot({ path: shotPath('desktop-03-public-toast') });

    // 5. Copy link → проверяем clipboard.
    await page.getByTestId(`my-courses-action-copy-${created.id}`).click();
    await expect(page.getByTestId('my-courses-toast')).toContainText(
      /Link copied/i,
    );
    const expectedUrl = `http://localhost:5173/lessons/my/${created.slug}`;
    const clipboardText = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });
    expect(clipboardText, 'clipboard contains course URL').toBe(expectedUrl);
    await page.screenshot({ path: shotPath('desktop-04-copy-link') });

    // 6. Delete через ⋮ More → confirm → курс пропал.
    page.once('dialog', (d) => {
      // Подтверждаем удаление.
      void d.accept();
    });
    await page.getByTestId(`my-courses-action-more-${created.id}`).click();
    const [deleteRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'DELETE' &&
          new RegExp(`/lessons/courses/${created.id}$`).test(r.url()),
        { timeout: 15_000 },
      ),
      page.getByTestId(`my-courses-menu-delete-${created.id}`).click(),
    ]);
    expect(deleteRes.ok(), `DELETE course: ${deleteRes.status()}`).toBe(true);
    await expect(card).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId('my-courses-toast')).toContainText(
      /deleted/i,
    );
    await page.screenshot({ path: shotPath('desktop-05-deleted') });

    // На всякий случай чистим всё что могло остаться (если test упал
    // в середине). При успешном Delete этот блок ничего не найдёт.
    await cleanupCoursesByTitle(tokens, '');
  });

  test('mobile: entry CTA → create → mobile-only Copy link in menu → toggle visibility', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      'Этот сценарий — про mobile UX (sticky CTA + mobile-only Copy link).',
    );
    const username = `e2e-mycourses-m-${Date.now()}`;
    const tokens = await devBypassLogin(username);
    await seedAuth(page, tokens);
    await grantClipboard(page);

    // 1. /lessons → CTA-row «Мои курсы (N)» → /lessons/my.
    await openMyCoursesViaEntryPoint(page, true);
    await page.screenshot({ path: shotPath('mobile-01-list-with-sticky') });

    // 2. + Create через STICKY-кнопку (header-кнопка на mobile скрыта).
    const created = await createCourseViaUi(page, true);
    const card = page.getByTestId(`my-courses-card-${created.id}`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // 3. Открываем overflow → должен быть mobile-only пункт «Copy link».
    await page.getByTestId(`my-courses-action-more-${created.id}`).click();
    const menu = page.getByTestId(`my-courses-menu-${created.id}`);
    await expect(menu).toBeVisible();
    const copyInMenu = page.getByTestId(`my-courses-menu-copy-${created.id}`);
    await expect(copyInMenu).toBeVisible({ timeout: 5_000 });

    // Проверяем, что primary-кнопка Copy link в строке actions СКРЫТА
    // на mobile (display:none) — чтобы не путала пользователя.
    const copyPrimary = page.getByTestId(
      `my-courses-action-copy-${created.id}`,
    );
    // Кнопка остаётся в DOM, но не visible через media-query.
    await expect(copyPrimary).toBeHidden();

    await page.screenshot({ path: shotPath('mobile-02-overflow-menu') });

    // Кликаем «Copy link» из меню — буфер должен заполниться.
    await copyInMenu.click();
    await expect(page.getByTestId('my-courses-toast')).toContainText(
      /Link copied/i,
    );
    const clipboardText = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });
    expect(clipboardText).toBe(
      `http://localhost:5173/lessons/my/${created.slug}`,
    );

    // 4. Toggle visibility (Make public). Открываем меню заново — оно
    // закрылось после клика «Copy link».
    await page.getByTestId(`my-courses-action-more-${created.id}`).click();
    const [patchRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          new RegExp(`/lessons/courses/${created.id}$`).test(r.url()),
        { timeout: 15_000 },
      ),
      page
        .getByTestId(`my-courses-menu-visibility-${created.id}`)
        .click(),
    ]);
    expect(patchRes.ok(), `PATCH visibility: ${patchRes.status()}`).toBe(true);
    await expect(
      page.getByTestId(`my-courses-badge-${created.id}`),
    ).toContainText(/Public/i);
    await expect(page.getByTestId('my-courses-toast')).toContainText(
      /published/i,
    );
    await page.screenshot({ path: shotPath('mobile-03-public-toast') });

    // Чистим за собой (mobile-сценарий не делает Delete через UI —
    // destructive проверка покрыта desktop'ом выше).
    await cleanupCoursesByTitle(tokens, '');
  });
});
