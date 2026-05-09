import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-2605 (ADR-051 §4 B3): скрин-сверка для acceptance.
 *
 * Что проверяем:
 *  - Клик по партии в списке PGN-файла → POST /analyses {pgn} →
 *    navigate('/analysis/<id>') с уникальным id.
 *  - PGN не передаётся через router state (acceptance ADR-051).
 *  - На странице анализа подгружаются ходы партии.
 *  - Скрин «после» — `/tmp/KS-2605/02-analysis-after-click.png`.
 *
 * Сценарий «до» (контекст):
 *  - `handleOpenGame` делал `navigate('/analysis', { state: { pgn, ... } })`
 *    без id. PGN ехал через state, AnalysisPage делал ad-hoc auto-create.
 *    Симптом: «прошлая партия в Мастерской», см. KS-2403.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2605';

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const SAMPLE_PGN = `[Event "Test"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;

async function devBypassLogin(username: string): Promise<AuthTokens> {
  const res = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_BYPASS_SECRET, user: username }),
  });
  if (!res.ok) throw new Error(`dev-bypass: ${res.status}`);
  return (await res.json()) as AuthTokens;
}

async function uploadPgnFile(
  tokens: AuthTokens,
  fileName: string,
  pgn: string,
): Promise<{ id: string; gameIds: string[] }> {
  // POST /workshop/pgn-files принимает multipart/form-data с файлом.
  const formData = new FormData();
  formData.set(
    'file',
    new Blob([pgn], { type: 'application/x-chess-pgn' }),
    fileName,
  );
  const res = await fetch(`${API_URL}/workshop/pgn-files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    body: formData as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`upload pgn: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { id: string };
  return { id: data.id, gameIds: [] };
}

async function seedAuth(page: Page, tokens: AuthTokens): Promise<void> {
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
    },
    [tokens.accessToken, tokens.refreshToken] as [string, string],
  );
}

async function cleanupPgnFile(
  tokens: AuthTokens,
  fileId: string,
): Promise<void> {
  await fetch(`${API_URL}/workshop/pgn-files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
}

test.describe.configure({ mode: 'serial' });

test('KS-2605 «Открыть партию» из PGN-файла → /analysis/<id> без pgn в state', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного скрин-проекта; mobile-вариант идёт по тому же коду.',
  );
  const tokens = await devBypassLogin(`e2e-ks2605-${Date.now()}`);
  const file = await uploadPgnFile(tokens, `KS-2605-${Date.now()}.pgn`, SAMPLE_PGN);
  await seedAuth(page, tokens);

  await page.goto(`/workshop/pgn-files/${file.id}`);
  // Дожидаемся, что список партий внутри файла отрисован.
  const gameRow = page.locator('.workshop-pgn-game-item').first();
  await expect(gameRow).toBeVisible({ timeout: 15_000 });

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '01-pgn-list-before-click.png'),
    fullPage: true,
  });

  // Перехватываем POST /analyses, чтобы убедиться что helper его делает
  // (а не navigate'ит на /analysis без id с pgn в state).
  const postPromise = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && /\/analyses$/.test(r.url()),
    { timeout: 10_000 },
  );
  await gameRow.click();
  const postRes = await postPromise;
  expect(postRes.ok()).toBe(true);
  const created = (await postRes.json()) as { id: string };
  expect(created.id).toBeTruthy();

  // URL — `/analysis/<id>`, не голый `/analysis`.
  await page.waitForURL(new RegExp(`/analysis/${created.id}$`), {
    timeout: 10_000,
  });

  // Проверяем, что pgn не пришёл через router state — `history.state`
  // не должен содержать `pgn` ключа (acceptance ADR-051 §4 B3).
  const stateHasPgn = await page.evaluate(() => {
    const s = (window.history.state as { usr?: Record<string, unknown> } | null)?.usr;
    return s !== undefined && Object.prototype.hasOwnProperty.call(s, 'pgn');
  });
  expect(stateHasPgn).toBe(false);

  // Дожидаемся, что AnalysisPage загрузил ходы (PGN получен через GET).
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, '02-analysis-after-click.png'),
    fullPage: true,
  });

  await cleanupPgnFile(tokens, file.id);
});
