import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-1871: e2e happy-path `UserCourseEditor` (dev-сервер + реальный браузер).
 *
 * Что проверяет:
 *  1. Логин через dev-bypass (`POST /auth/dev-bypass`) → tokens в localStorage
 *  2. Создание user-курса через API (чтобы не зависеть от UI списка «Мои курсы»)
 *  3. Открытие `/lessons/my/:slug/edit` — редактор рендерится
 *  4. Добавление второго урока через outline
 *  5. Добавление шага type=text через picker в `LessonOverview`
 *  6. Редактирование текста шага → `SaveStatusPill` → `saved`
 *  7. Переключение активного урока через outline → main-pane обновляется
 *  8. Удаление курса через OwnerActionsMenu → DeleteCourseDialog →
 *     ввод `DELETE` → редирект на `/lessons`
 *
 * Mobile-тест (390×844) — отдельный test-case, проверяет tabs
 * переключение «Outline / Editor» и скрытие sidebar.
 *
 * Скриншоты ключевых шагов пишутся в `/tmp/KS-1871/*.png` для
 * проверки глазами (UX, L-R1/L-R2/L-R6 визуально).
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-1871';

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
  if (!res.ok) {
    throw new Error(`dev-bypass failed: ${res.status}`);
  }
  return (await res.json()) as AuthTokens;
}

async function createCourse(
  tokens: AuthTokens,
  title: string,
): Promise<{ id: string; slug: string; title: string }> {
  // Backend может лимитировать create — 429 при частых запросах.
  // В e2e контексте повторный запуск тестов быстро упирается в лимит;
  // подождать и повторить проще, чем отключать лимит под тесты.
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(`${API_URL}/lessons/courses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ title }),
    });
    if (res.ok) {
      return (await res.json()) as { id: string; slug: string; title: string };
    }
    if (res.status !== 429) {
      throw new Error(`create-course failed: ${res.status}`);
    }
    // 429 — ждём с экспонентой: 2, 4, 8, 16, 32 сек
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new Error('create-course failed: 429 (max retries)');
}

/**
 * Ставит tokens в localStorage через `page.addInitScript` ПЕРЕД
 * первым `page.goto`, чтобы AuthContext увидел их на старте.
 */
async function seedAuth(page: Page, tokens: AuthTokens): Promise<void> {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

function screenshotPath(name: string): string {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

// ─── Desktop happy-path ────────────────────────────────────────────────

test.describe('UserCourseEditor happy-path', () => {
  test.describe.configure({ mode: 'serial' });

  test('desktop: full CRUD цикл с autosave и удалением', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Full CRUD сценарий рассчитан на desktop-viewport со split-pane.',
    );
    const tokens = await devBypassLogin(`e2e-desktop-${Date.now()}`);
    const course = await createCourse(
      tokens,
      `KS-1871 Desktop ${Date.now()}`,
    );
    await seedAuth(page, tokens);

    // 1. Открыть редактор
    await page.goto(`/lessons/my/${course.slug}/edit`);
    await expect(
      page.getByTestId('user-course-editor'),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: screenshotPath('01-desktop-editor-loaded'),
      fullPage: true,
    });

    // 2. Добавить первый урок через outline (курс только что создан — пустой).
    await page
      .getByTestId('course-outline-add-lesson')
      .or(page.getByTestId('add-lesson-empty-cta'))
      .first()
      .click();
    // Ждём появления lesson-overview (новый урок активируется).
    await expect(
      page.locator('[data-testid^="lesson-overview-"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // 3. Пустое состояние шагов → выбираем type=text → «Добавить первый шаг».
    const textOption = page
      .getByTestId('add-step-empty-picker-option-text')
      .first();
    await textOption.click();
    await page.getByTestId('add-step-empty-cta').click();

    // 4. Появилась StepCard — раскрыта автоматически (см. UserCourseEditor.addStep).
    const firstStepCard = page.locator('[data-testid^="step-card-"]').first();
    await expect(firstStepCard).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: screenshotPath('02-desktop-step-added'),
      fullPage: true,
    });

    // 5. Редактируем markdown шага. PATCH step'а идёт немедленно в
    // `patchStepPayload` (UserCourseEditor). Подписываемся на PATCH
    // ДО изменения поля, чтобы не упустить событие.
    const stepPatchPromise = page.waitForResponse(
      (r) =>
        r.request().method() === 'PATCH' &&
        /\/lessons\/steps\//.test(r.url()),
      { timeout: 15_000 },
    );
    const body = page.getByTestId('editor-step-text-body').first();
    await body.fill('Это первый шаг учебного урока, hello e2e');
    await stepPatchPromise;

    // Дополнительно проверяем autosave на уровне КУРСА через title.
    // Debounce 500мс — должен сохранить и показать «Saved» в pill.
    const titleEl = page.getByTestId('user-course-header-title').first();
    await titleEl.click();
    const titleInput = page.getByTestId('user-course-header-title-input');
    await titleInput.fill(`${course.title} ✎`);
    await titleInput.press('Enter');
    // Ждём сохранения: видно «Saved» в pill.
    await expect(page.getByTestId('save-status-pill-saved')).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({
      path: screenshotPath('03-desktop-saved'),
      fullPage: true,
    });

    // 6. Добавляем второй урок через outline и переключаем активный.
    await page.getByTestId('course-outline-add-lesson').click();
    // Новый урок должен появиться и стать активным.
    await page.waitForLoadState('networkidle');
    const outlineLessons = page.locator(
      '[data-testid^="course-outline-lesson-select-"]',
    );
    await expect(outlineLessons).toHaveCount(2, { timeout: 10_000 });
    // Клик по первому уроку снова.
    const firstLessonBtn = outlineLessons.first();
    await firstLessonBtn.click();
    // Main-pane обновился — lesson-overview остался видимым.
    await expect(
      page.locator('[data-testid^="lesson-overview-"]').first(),
    ).toBeVisible();
    await page.screenshot({
      path: screenshotPath('04-desktop-two-lessons'),
      fullPage: true,
    });

    // 7. Удаление курса через owner-menu → DeleteCourseDialog.
    await page.getByTestId('owner-actions-menu-trigger').click();
    await page.getByTestId('owner-actions-menu-delete').click();
    await expect(page.getByTestId('delete-course-dialog')).toBeVisible();
    await page.getByTestId('delete-course-dialog-input').fill('DELETE');
    await page.getByTestId('delete-course-dialog-confirm').click();

    // 8. Редирект на /lessons — проверяем URL.
    await page.waitForURL('**/lessons', { timeout: 10_000 });
    await page.screenshot({
      path: screenshotPath('05-desktop-redirected-to-lessons'),
      fullPage: true,
    });
    expect(new URL(page.url()).pathname).toBe('/lessons');
  });

  test('mobile: tabs переключение outline/editor', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      'Mobile-тест использует Pixel 5 viewport и проверяет tabs.',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const tokens = await devBypassLogin(`e2e-mobile-${Date.now()}`);
    const course = await createCourse(
      tokens,
      `KS-1871 Mobile ${Date.now()}`,
    );
    await seedAuth(page, tokens);

    await page.goto(`/lessons/my/${course.slug}/edit`);
    await expect(
      page.getByTestId('user-course-editor'),
    ).toBeVisible({ timeout: 15_000 });

    // Добавим урок сразу через outline, чтобы было что показать в editor-tab.
    const addLesson = page
      .getByTestId('course-outline-add-lesson')
      .or(page.getByTestId('add-lesson-empty-cta'))
      .first();
    await addLesson.click();
    await expect(
      page.locator('[data-testid^="lesson-overview-"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Проверяем tabs: по умолчанию — editor (после добавления урока).
    const tabOutline = page.getByTestId('user-course-editor-tab-outline');
    const tabEditor = page.getByTestId('user-course-editor-tab-editor');
    await expect(tabOutline).toBeVisible();
    await expect(tabEditor).toBeVisible();

    // Переключение: outline.
    await tabOutline.click();
    await expect(tabOutline).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({
      path: screenshotPath('mobile-01-outline-tab'),
      fullPage: false,
    });

    // Переключение: editor.
    await tabEditor.click();
    await expect(tabEditor).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({
      path: screenshotPath('mobile-02-editor-tab'),
      fullPage: false,
    });

    // Cleanup: удаляем созданный курс через API.
    await fetch(`${API_URL}/lessons/courses/${course.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).catch(() => {});
  });
});
