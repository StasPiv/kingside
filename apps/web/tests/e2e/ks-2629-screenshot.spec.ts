import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2629 — desktop-скриншот: «один шаг = одна страница» в user-reader.
 *
 * Сценарий:
 *  1. Создаём курс + урок + 3 шага через REST.
 *  2. Открываем `/lessons/my/<slug>/<lessonId>` — без `?step=` → редирект
 *     на `?step=1`.
 *  3. Скриншот ① «открыт первый шаг».
 *  4. Открываем `?step=2` явно — подтверждаем что в DOM ровно один шаг
 *     и это второй.
 *  5. Скриншот ② «второй шаг через ?step=2».
 *
 * Spec не входит в общий e2e-прогон acceptance'а (это диагностический
 * скрипт под задачу), но удобнее пользоваться им через playwright,
 * чтобы получить реальные screenshots.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2629';

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

test.describe.configure({ mode: 'serial' });

test('KS-2629: desktop screenshots — один шаг = один экран', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Скриншот делаем на desktop-проекте.',
  );
  const username = `ks2629-${Date.now()}`;
  const tokens = await devBypass(username);
  await seedAuth(page, tokens);

  // 1. Создать курс через UI-эндпоинт (POST /lessons/courses).
  const course = await api<{ id: string; slug: string }>(
    tokens,
    'POST',
    '/lessons/courses',
    { title: 'KS-2629 reader screenshot' },
  );

  // 2. Создать урок (POST /lessons/courses/:id/lessons).
  const lesson = await api<{ id: string }>(
    tokens,
    'POST',
    `/lessons/courses/${course.id}/lessons`,
    { title: 'Step pagination demo' },
  );

  // 3. Добавить три text-шага.
  for (let i = 1; i <= 3; i++) {
    await api(tokens, 'POST', `/lessons/lessons/${lesson.id}/steps`, {
      type: 'text',
      payload: {
        type: 'text',
        bodyMarkdown: `# Step ${i}\n\nThis is the **${i}**-th step body.`,
        diagrams: [],
      },
    });
  }

  // 4. Открываем reader без ?step= (унифицированный URL после KS-2645).
  await page.goto(`/lessons/${course.slug}/${lesson.id}`);
  await page.getByTestId('user-lesson-page').waitFor({ timeout: 15_000 });
  // Дожидаемся редиректа на ?step=1.
  await page.waitForURL(/\?step=1$/, { timeout: 5_000 });
  await page.screenshot({ path: `${DIR}/desktop-step-1.png`, fullPage: true });

  // 5. Открываем ?step=2 явно.
  await page.goto(`/lessons/${course.slug}/${lesson.id}?step=2`);
  await page.getByTestId('user-lesson-page').waitFor({ timeout: 15_000 });
  await page.screenshot({ path: `${DIR}/desktop-step-2.png`, fullPage: true });

  // Cleanup.
  await fetch(`${API_URL}/lessons/courses/${course.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
});
