import { test, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2653 — скриншоты унифицированного шаблона CoursePage:
 * системный курс vs пользовательский курс должны выглядеть одинаково
 * по структуре (breadcrumb + title + progress-bar + hero + lesson-list).
 *
 * Для системного курса — берём `dvoretsky-endgame-manual` (всегда есть
 * в seed'е). Для пользовательского — создаём через REST.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2653';

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

test('KS-2653: unified CoursePage — system + user одинаковый шаблон', async ({
  page,
}, testInfo) => {
  const proj = testInfo.project.name;
  const studentTokens = await devBypass(`ks2653-student-${proj}-${Date.now()}`);
  const authorTokens = await devBypass(`ks2653-author-${proj}-${Date.now()}`);

  // Создаём публичный пользовательский курс с одним уроком и шагом.
  const course = await api<{ id: string; slug: string }>(
    authorTokens,
    'POST',
    '/lessons/courses',
    { title: `KS-2653 user ${proj} ${Date.now()}` },
  );
  await api(authorTokens, 'PATCH', `/lessons/courses/${course.id}`, {
    isPublic: true,
  });
  const lesson = await api<{ id: string }>(
    authorTokens,
    'POST',
    `/lessons/courses/${course.id}/lessons`,
    { title: 'Lesson 1' },
  );
  await api(authorTokens, 'POST', `/lessons/lessons/${lesson.id}/steps`, {
    type: 'text',
    payload: {
      type: 'text',
      bodyMarkdown: '# Step 1',
      diagrams: [],
    },
  });

  // 1) Студент (НЕ owner) открывает пользовательский курс.
  await seedAuth(page, studentTokens);
  await page.goto(`/lessons/${course.slug}`);
  await page.getByTestId('course-page').waitFor({ timeout: 15_000 });
  await page.getByTestId('course-back-link').waitFor();
  await page.getByTestId('course-title').waitFor();
  await page.getByTestId('course-progress').waitFor();
  await page.getByTestId('course-active-hero').waitFor();
  await page.getByTestId('course-lesson-list').waitFor();
  await page.screenshot({
    path: `${DIR}/${proj}-user-course-as-student.png`,
    fullPage: true,
  });

  // 2) Системный курс — Dvoretsky.
  await page.goto('/lessons/dvoretsky-endgame-manual');
  await page.getByTestId('course-page').waitFor({ timeout: 15_000 });
  await page.getByTestId('course-back-link').waitFor();
  await page.getByTestId('course-title').waitFor();
  await page.getByTestId('course-progress').waitFor();
  await page.screenshot({
    path: `${DIR}/${proj}-system-course.png`,
    fullPage: true,
  });

  // Cleanup user-курса.
  await fetch(`${API_URL}/lessons/courses/${course.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authorTokens.accessToken}` },
  }).catch(() => {});
});
