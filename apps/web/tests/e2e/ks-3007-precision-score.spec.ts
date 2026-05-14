import { test, expect, type Page } from '@playwright/test';

/**
 * KS-3007 (ADR-065 §4.3, Этап 4 Q1) — E2E precision-score.
 *
 * Проверяет, что итоговая 5-балльная оценка precision-попытки совпадает
 * с контрольными кейсами ADR-065 §4.3 на реальном backend'е (формула
 * `computePrecisionScore`, бэкенд KS-2999/KS-3000) и корректно
 * рендерится `PrecisionScoreBlock` на странице `/precision/attempts/:id`.
 *
 * Маршрут на API:
 *   `POST /precision/attempts/_test_fixture` (dev-only, KS-3029) с
 *   `{ moves: PrecisionMoveSnapshot[] }` → response `{attemptId, score, scorePct}`.
 *
 * Контрольные WDL-значения берём ровно из `precision-score.test.ts`
 * (`perfectWdl`, `wdlMoveWithLoss`), чтобы e2e падал при любом
 * расхождении frontend↔backend↔shared.
 *
 * Сценарии §4.3:
 *   1. 5 best → 5★.
 *   2. 5 best + 1 inaccuracy (loss=14%) → 3-4★ по §4.3 #3.
 *   3. 5 best + 1 mistake (loss=30%) → 2-3★.
 *   4. 5 best + 1 blunder (loss=60%) → 2★ (cap=60 §3.3).
 *   5. 10 best (длинная) → 5★.
 *
 * Кейс №4 — самый стабильный для cap-проверки, остальные — для
 * формулы композита. Точное число звёзд может отличаться на ±1 в
 * зависимости от того, как WDL→accuracy через Lichess-формулу
 * совпадёт с classification (см. ADR §2.1-§2.4). Тест принимает
 * допустимый диапазон через `oneOf` (например, [3, 4] для inaccuracy).
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface Wdl {
  w: number;
  d: number;
  l: number;
}

interface MoveSnapshot {
  ply: number;
  fenBefore: string;
  playedUci: string;
  bestUci: string;
  wdlBefore: Wdl;
  wdlAfter: Wdl;
}

interface FixtureResponse {
  attemptId: string;
  score: number;
  scorePct: number;
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

async function createFixture(
  tokens: Tokens,
  moves: MoveSnapshot[],
): Promise<FixtureResponse> {
  const res = await fetch(
    `${API_URL}/precision/attempts/_test_fixture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ moves }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `_test_fixture → ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as FixtureResponse;
}

/**
 * Mirror of `perfectWdl()` из `packages/shared/src/utils/precision-score.test.ts`.
 * WDL не меняется → accuracy ≈ 100.
 */
function perfectMove(ply: number): MoveSnapshot {
  return {
    ply,
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4',
    bestUci: 'e2e4',
    wdlBefore: { w: 1000, d: 0, l: 0 },
    wdlAfter: { w: 1000, d: 0, l: 0 },
  };
}

/**
 * Mirror of `wdlMoveWithLoss()` из `packages/shared/src/utils/precision-score.test.ts`.
 * Падение E на `lossPct` процентных пунктов из 1.0 → (1 - lossPct/100).
 *
 * lossPct=14 — соответствует ходу-«inaccuracy» (accuracy ≈ 55-60).
 * lossPct=30 — «mistake» (accuracy ≈ 25-30).
 * lossPct=60 — «blunder» (accuracy ≈ 5, cap=60).
 */
function lossyMove(ply: number, lossPct: number): MoveSnapshot {
  const lossPerMille = Math.max(0, Math.min(1000, Math.round(lossPct * 10)));
  return {
    ply,
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    playedUci: 'e2e4',
    bestUci: 'd2d4',
    wdlBefore: { w: 1000, d: 0, l: 0 },
    wdlAfter: {
      w: 1000 - lossPerMille,
      d: 0,
      l: lossPerMille,
    },
  };
}

async function openAttempt(page: Page, attemptId: string): Promise<void> {
  await page.goto(`/precision/attempts/${attemptId}`);
  await expect(page.getByTestId('precision-attempt-page')).toHaveAttribute(
    'data-state',
    'ready',
    { timeout: 20_000 },
  );
}

test.describe.configure({ mode: 'serial' });

test.describe('KS-3007 precision-score E2E (ADR-065 §4.3)', () => {
  // ── #1 — 5 best → score=5 ──────────────────────────────────────
  test('5 best → score=5 (★★★★★)', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'e2e гоняем только на desktop — UI structurally идентичен.',
    );
    const tokens = await devBypass(`ks3007-c1-${Date.now()}`);
    const moves: MoveSnapshot[] = Array.from({ length: 5 }, (_, i) =>
      perfectMove(i + 1),
    );
    const resp = await createFixture(tokens, moves);
    expect(resp.score).toBe(5);

    await seedAuth(page, tokens);
    await openAttempt(page, resp.attemptId);
    const block = page.getByTestId('precision-score-block');
    await expect(block).toHaveAttribute('data-score', '5');
    await expect(block).toHaveAttribute('data-tone', 'emerald');
  });

  // ── #2 — 5 best + 1 inaccuracy (loss=14%) → 3-4★ ───────────────
  test('5 best + 1 inaccuracy → score ∈ {3,4}', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const tokens = await devBypass(`ks3007-c2-${Date.now()}`);
    const moves: MoveSnapshot[] = [
      ...Array.from({ length: 5 }, (_, i) => perfectMove(i + 1)),
      lossyMove(6, 14),
    ];
    const resp = await createFixture(tokens, moves);
    expect([3, 4]).toContain(resp.score);

    await seedAuth(page, tokens);
    await openAttempt(page, resp.attemptId);
    const block = page.getByTestId('precision-score-block');
    const renderedScore = await block.getAttribute('data-score');
    expect(renderedScore).toBe(String(resp.score));
  });

  // ── #3 — 5 best + 1 mistake (loss=30%) → 2-3★ ──────────────────
  test('5 best + 1 mistake → score ∈ {2,3}', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const tokens = await devBypass(`ks3007-c3-${Date.now()}`);
    const moves: MoveSnapshot[] = [
      ...Array.from({ length: 5 }, (_, i) => perfectMove(i + 1)),
      lossyMove(6, 30),
    ];
    const resp = await createFixture(tokens, moves);
    expect([2, 3]).toContain(resp.score);

    await seedAuth(page, tokens);
    await openAttempt(page, resp.attemptId);
    const block = page.getByTestId('precision-score-block');
    await expect(block).toHaveAttribute('data-score', String(resp.score));
  });

  // ── #4 — 5 best + 1 blunder (loss=60%) → 2★ (cap=60 §3.3) ──────
  test('5 best + 1 blunder → score=2, cap=60 §3.3', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const tokens = await devBypass(`ks3007-c4-${Date.now()}`);
    const moves: MoveSnapshot[] = [
      ...Array.from({ length: 5 }, (_, i) => perfectMove(i + 1)),
      lossyMove(6, 60),
    ];
    const resp = await createFixture(tokens, moves);
    expect(resp.score).toBe(2);
    // cap §3.3: blunder → scorePct ≤ 60.
    expect(resp.scorePct).toBeLessThanOrEqual(60);

    await seedAuth(page, tokens);
    await openAttempt(page, resp.attemptId);
    const block = page.getByTestId('precision-score-block');
    await expect(block).toHaveAttribute('data-score', '2');
    await expect(block).toHaveAttribute('data-tone', 'orange');
  });

  // ── #5 — 10 best (длинная идеальная) → score=5 ─────────────────
  test('10 best → score=5 (длинная идеальная)', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const tokens = await devBypass(`ks3007-c5-${Date.now()}`);
    const moves: MoveSnapshot[] = Array.from({ length: 10 }, (_, i) =>
      perfectMove(i + 1),
    );
    const resp = await createFixture(tokens, moves);
    expect(resp.score).toBe(5);

    await seedAuth(page, tokens);
    await openAttempt(page, resp.attemptId);
    const block = page.getByTestId('precision-score-block');
    await expect(block).toHaveAttribute('data-score', '5');
    await expect(block).toHaveAttribute('data-tone', 'emerald');
  });
});
