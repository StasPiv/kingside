import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2657 — регрессия: пазл из `/precision` рендерит
 * `PlayVsEngineRunner` с eval-bar, даже если backend в DTO отдал
 * `solutionMode: 'forced-line'`. Защитный override на фронте по
 * `?source=precision` (см. PuzzlePage.tsx).
 *
 * Тест берёт первый lichess-пазл из `/puzzles/browse?limit=1` (на dev
 * generated-пазлов нет, но lichess есть) и открывает его с
 * `?source=precision`. Backend для этого пазла отдаёт
 * `solutionMode: 'forced-line'`, но на фронте URL-сигнал перекрывает
 * выбор — рендерится `puzzle-engine-runner`.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2657';

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

async function pickAnyPuzzleId(tokens: Tokens): Promise<string> {
  const res = await fetch(`${API_URL}/puzzles/browse?limit=1`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!res.ok) throw new Error(`browse ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const id = body.data?.[0]?.id;
  if (!id) throw new Error('no puzzles available on dev to probe');
  return id;
}

test('KS-2657: /puzzle/:id?source=precision → PlayVsEngineRunner (override)', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного desktop-прогона.',
  );
  const tokens = await devBypass(`ks2657-${Date.now()}`);
  const id = await pickAnyPuzzleId(tokens);
  await seedAuth(page, tokens);

  await page.goto(`/puzzle/${id}?source=precision`);
  // Контейнер `puzzle-engine-runner` — главный признак PVE-режима.
  await expect(page.getByTestId('puzzle-engine-runner')).toBeVisible({
    timeout: 20_000,
  });
  // Header страницы с testid `puzzle-page-play-vs-engine`.
  await expect(
    page.getByTestId('puzzle-page-play-vs-engine'),
  ).toBeVisible();

  await page.screenshot({
    path: `${DIR}/desktop-precision-pve-runner.png`,
    fullPage: true,
  });
});
