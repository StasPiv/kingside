import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-2596: одноразовый spec для скриншотов RU desktop+mobile (acceptance —
 * приложить в комментарий). Гоняется руками: `playwright test ks-2596-screenshots`.
 *
 * Покрывает 3 строки задачи:
 *  - `Needs attention` badge → «Требует внимания» (на quiz-question с
 *    отсутствующим correct option).
 *  - `Answer text…` placeholder → «Текст ответа…» (в новом пустом option'е).
 *  - Сообщение об ошибке валидации → локализованное «Отметьте хотя бы один
 *    правильный вариант» вместо сырого `payload.questions.0.correctOptionIds
 *    should not be empty`. Триггерим вручную через `page.evaluate`, эмулируя
 *    тот же путь, что использует patchStepPayload, — тестируем только UI-
 *    локализацию, не backend.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2596';

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

async function createCourseWithLesson(
  tokens: AuthTokens,
  title: string,
): Promise<{ courseId: string; slug: string; lessonId: string }> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens.accessToken}`,
  };
  let course: { id: string; slug: string } | null = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await fetch(`${API_URL}/lessons/user-courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title }),
    });
    if (r.ok) {
      course = (await r.json()) as { id: string; slug: string };
      break;
    }
    if (r.status !== 429) throw new Error(`create-course: ${r.status}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
  }
  if (!course) throw new Error('create-course failed');
  const lessonRes = await fetch(
    `${API_URL}/lessons/user-courses/${course.id}/lessons`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'KS-2596 lesson' }),
    },
  );
  if (!lessonRes.ok) throw new Error(`create-lesson: ${lessonRes.status}`);
  const lesson = (await lessonRes.json()) as { id: string };
  return { courseId: course.id, slug: course.slug, lessonId: lesson.id };
}

async function seedAuthRu(page: Page, tokens: AuthTokens): Promise<void> {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
      localStorage.setItem('locale', 'ru');
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

async function cleanupCourse(
  tokens: AuthTokens,
  courseId: string,
): Promise<void> {
  await fetch(`${API_URL}/lessons/user-courses/${courseId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
}

test.describe.configure({ mode: 'serial' });

test('KS-2596 RU скриншоты: badge + placeholder + ошибка валидации', async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name === 'mobile' ? 'mobile' : 'desktop';
  const tokens = await devBypassLogin(`e2e-ks2596-${tag}-${Date.now()}`);
  const fixture = await createCourseWithLesson(
    tokens,
    `KS-2596 ${tag} ${Date.now()}`,
  );

  // Сидим quiz-шаг с валидным correctOptionIds=['a'] — backend bool-валидатор
  // не пропустит пустой массив. Невалидное состояние получим в UI через
  // uncheck (см. ниже) — тогда визуально сработает красная рамка + badge,
  // а попытка autosave спровоцирует 400 от backend, и красная плашка
  // ошибки покажет локализованный текст.
  const quizSeed = await fetch(
    `${API_URL}/lessons/user-lessons/${fixture.lessonId}/steps`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        type: 'quiz',
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q-1',
              prompt: 'Какой ход в позиции лучший?',
              options: [
                { id: 'a', label: 'e2-e4' },
                { id: 'b', label: 'd2-d4' },
              ],
              correctOptionIds: ['a'],
            },
          ],
        },
      }),
    },
  );
  if (!quizSeed.ok) throw new Error(`seed: ${quizSeed.status}`);
  const quizStepId = ((await quizSeed.json()) as { id: string }).id;

  await seedAuthRu(page, tokens);
  await page.goto(
    `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
  );
  await expect(page.getByTestId('user-course-editor')).toBeVisible({
    timeout: 15_000,
  });
  if (tag === 'mobile') {
    await page.getByTestId('user-course-editor-tab-editor').click();
  }

  const card = page.getByTestId(`step-card-${quizStepId}`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  if ((await card.getAttribute('data-expanded')) !== 'true') {
    await page.getByTestId(`step-card-chevron-${quizStepId}`).click();
  }
  await expect(page.getByTestId('quiz-step-editor')).toBeVisible();
  await expect(page.getByTestId('quiz-question-0')).toBeVisible();

  // Делаем quiz невалидным — снимаем единственный correct option.
  await page.getByTestId('quiz-option-correct-0-0').uncheck();

  // 1. RU `Требует внимания` badge виден (correctOptionIds=[] после uncheck).
  await expect(page.getByTestId('quiz-question-invalid-0')).toContainText(
    'Требует внимания',
  );

  // 2. RU placeholder «Текст ответа…» виден на новой опции.
  // Кликаем «Добавить вариант» — добавится третья опция с пустым label
  // и виден placeholder.
  await page.getByTestId('quiz-add-option-0').click();
  // Третья опция (индекс 2) — placeholder ровно «Текст ответа…».
  const optionInput = page.getByTestId('quiz-option-label-0-2');
  await expect(optionInput).toHaveAttribute('placeholder', 'Текст ответа…');

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, `${tag}-01-badge-and-placeholder.png`),
    fullPage: true,
  });

  // 3. RU локализованное сообщение об ошибке валидации.
  // Перехватываем PATCH user-lesson-steps и эмулируем 400 с реальным
  // class-validator-сообщением, какое отдаёт backend для quiz без correct.
  await page.route(
    /\/lessons\/user-lesson-steps\/[^/]+$/,
    async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            statusCode: 400,
            message: [
              'payload.questions.0.correctOptionIds should not be empty',
            ],
            error: 'Bad Request',
          }),
        });
        return;
      }
      await route.continue();
    },
  );
  // Триггерим PATCH (toggle multi) — это вызовет patchStepPayload и при
  // catch'е покажет локализованное сообщение.
  await page.getByTestId('quiz-question-multi-0').click();

  // Видим красную плашку с локализованным текстом.
  await expect(
    page.getByTestId('user-course-editor-step-save-error'),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByTestId('user-course-editor-step-save-error'),
  ).toContainText('Отметьте хотя бы один правильный вариант');
  await expect(
    page.getByTestId('user-course-editor-step-save-error'),
  ).not.toContainText('correctOptionIds');

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, `${tag}-02-validation-error.png`),
    fullPage: true,
  });

  await page.unroute(/\/lessons\/user-lesson-steps\/[^/]+$/);
  await cleanupCourse(tokens, fixture.courseId);
});
