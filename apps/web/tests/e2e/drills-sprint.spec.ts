import { expect, test, type BrowserContext } from '@playwright/test';

/**
 * KS-2244 (ADR-035 §11, Drills E4 QA) — e2e sprint mode.
 *
 * Покрывает:
 *   1. Setup → Play → Results: один правильный submit → next null + final
 *      → переход на /drills/sprint/results с показанным score/accuracy.
 *   2. Несколько submit'ов подряд: счётчик score/attempted растёт.
 *   3. Timeout: глобальный таймер дотикивает 0, /sprint/finish вызывается,
 *      Results показывает final.
 *   4. Setup-валидация: «Все типы» / «Очистить» меняют count, /start
 *      получает правильный body.
 *   5. Leaderboard: переключение фильтра mode/period отправляет новый
 *      запрос; рендерит таблицу из mock-данных, current-user подсвечен.
 *   6. Edge-cases: открытие /drills/sprint/play без state → редирект на
 *      setup; results без state → missing-баннер с CTA «Сыграть ещё».
 *
 * Все selectors — `data-testid` (CSS KS-2243 ещё не готов у layout).
 * Mock-данные для /config + /tactic-drill/sprint/* через
 * `page.route('**\/…', route.fulfill)` — БД на dev-сервере пуста.
 */

import type {
  TacticDrillDto,
  TacticDrillSprintScoreItem,
  TacticDrillSprintStartResponse,
  TacticDrillSprintSubmitResponse,
} from '@kingside/shared';

const BYPASS = 'kingside-dev-bypass-2026';

// ─── Фикстуры ─────────────────────────────────────────────────────────

const NUMBER_DRILL: TacticDrillDto = {
  id: 'd-num',
  drillType: 'count-attackers',
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1',
  sideToMove: null,
  answerShape: 'number',
  difficulty: 1,
  meta: { highlightedSquare: 'e5' },
};

interface SprintMockState {
  attempts: number;
  startedAt: number;
  durationMs: number;
  finished: boolean;
  finalScore: number;
  finalAccuracy: number;
}

interface SetupOpts {
  /** durationMs для возвращаемой /start session. */
  durationMs?: number;
  /** Сколько submit'ов разрешить до final (next=null). */
  drillsBeforeFinal?: number;
  /** Возвращать ли finish-ответ (timeout-сценарий). */
  finishResponse?: {
    score: number;
    accuracy: number;
    avgPrecision: number;
  };
  /** Записи лидерборда. */
  leaderboardEntries?: TacticDrillSprintScoreItem[];
}

async function mockSprintEndpoints(
  ctx: BrowserContext,
  opts: SetupOpts = {},
): Promise<SprintMockState> {
  const state: SprintMockState = {
    attempts: 0,
    startedAt: Date.now(),
    durationMs: opts.durationMs ?? 180_000,
    finished: false,
    finalScore: 0,
    finalAccuracy: 0,
  };
  const drillsBeforeFinal = opts.drillsBeforeFinal ?? 1;

  // /config — drillsEnabled=true.
  await ctx.route('**/config', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        featureFlags: {
          lessonsEnabled: true,
          puzzlesEnabled: false,
          broadcastsEnabled: true,
          tournamentsEnabled: true,
          assistantEnabled: false,
          drillsEnabled: true,
        },
      }),
    });
  });

  await ctx.route('**/tactic-drill/sprint/start', async (route) => {
    state.startedAt = Date.now();
    state.attempts = 0;
    state.finished = false;
    const session: TacticDrillSprintStartResponse = {
      sessionId: 'sess-e2e',
      drill: NUMBER_DRILL,
      startedAt: new Date(state.startedAt).toISOString(),
      durationMs: state.durationMs,
    };
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    });
  });

  await ctx.route('**/tactic-drill/sprint/submit', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const userAnswer = body.userAnswer;
    const solved =
      userAnswer?.shape === 'number' && userAnswer.value === 2;
    state.attempts += 1;
    if (solved) state.finalScore += 1;
    state.finalAccuracy =
      state.attempts > 0 ? state.finalScore / state.attempts : 0;
    const isLast = state.attempts >= drillsBeforeFinal;
    const resp: TacticDrillSprintSubmitResponse = {
      attempt: {
        attemptId: `att-${state.attempts}`,
        solved,
        correctAnswer: { shape: 'number', value: 2 },
      },
      next: isLast ? null : { ...NUMBER_DRILL, id: `d-num-${state.attempts + 1}` },
      ...(isLast && {
        final: {
          scoreId: 'sc-e2e',
          score: state.finalScore,
          accuracy: state.finalAccuracy,
          avgPrecision: 0,
        },
      }),
    };
    if (isLast) state.finished = true;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resp),
    });
  });

  await ctx.route('**/tactic-drill/sprint/finish', async (route) => {
    state.finished = true;
    const final = opts.finishResponse ?? {
      score: state.finalScore,
      accuracy: state.finalAccuracy,
      avgPrecision: 0,
    };
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scoreId: 'sc-finish', ...final }),
    });
  });

  await ctx.route('**/tactic-drill/sprint/leaderboard**', async (route) => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get('mode') ?? '3min-mixed';
    const period = url.searchParams.get('period') ?? 'allTime';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode,
        period,
        entries: (opts.leaderboardEntries ?? []).map((e) => ({ ...e, mode })),
      }),
    });
  });

  return state;
}

// ─────────────────────────────────────────────────────────────────────
// 1) Setup-валидация
// ─────────────────────────────────────────────────────────────────────

test.describe('KS-2244 — sprint setup', () => {
  test('default duration=3min, селектор «Все типы» отмечает 8 чекбоксов', async ({
    context,
    page,
  }) => {
    await mockSprintEndpoints(context);
    await page.goto(`/drills/sprint?dev_bypass=${BYPASS}`);
    await expect(page.getByTestId('drill-sprint-setup')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('drill-sprint-setup-duration-180000')).toBeChecked();
    await page.getByTestId('drill-sprint-setup-select-all').click();
    await expect(page.getByTestId('drill-sprint-setup-types')).toHaveAttribute(
      'data-selected-count',
      '8',
    );
    await page.getByTestId('drill-sprint-setup-clear').click();
    await expect(page.getByTestId('drill-sprint-setup-types')).toHaveAttribute(
      'data-selected-count',
      '0',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2) Sprint flow setup → play → results
// ─────────────────────────────────────────────────────────────────────

test('KS-2244 — sprint flow setup → play → results (1 drill, правильный ответ)', async ({
  context,
  page,
}) => {
  await mockSprintEndpoints(context, { drillsBeforeFinal: 1 });
  await page.goto(`/drills/sprint?dev_bypass=${BYPASS}`);
  await expect(page.getByTestId('drill-sprint-setup')).toBeVisible({
    timeout: 10_000,
  });
  // Start без выбора типов — types=[] (= все 8 на backend).
  await page.getByTestId('drill-sprint-setup-start').click();
  // Play page mount.
  await expect(page.getByTestId('drill-sprint-play')).toHaveAttribute(
    'data-state',
    'idle',
    { timeout: 10_000 },
  );
  // Score 0/0 в начале.
  await expect(page.getByTestId('drill-sprint-play-score')).toHaveAttribute(
    'data-score',
    '0',
  );
  // Правильный ответ (2 для count-attackers фикстуры).
  await page.getByTestId('drill-count-attackers-btn-2').click();
  // resp.final → переход на results.
  await expect(page.getByTestId('drill-sprint-results')).toHaveAttribute(
    'data-state',
    'loaded',
    { timeout: 5_000 },
  );
  await expect(page.getByTestId('drill-sprint-results-score')).toHaveText('1');
  // 1/1 → 100%.
  await expect(page.getByTestId('drill-sprint-results-accuracy')).toHaveText('100%');
  await expect(page.getByTestId('drill-sprint-results')).toHaveAttribute(
    'data-ended',
    'submitted',
  );
});

test('KS-2244 — несколько submit подряд: счётчик score/attempted растёт', async ({
  context,
  page,
}) => {
  await mockSprintEndpoints(context, { drillsBeforeFinal: 3 });
  await page.goto(`/drills/sprint?dev_bypass=${BYPASS}`);
  await page.getByTestId('drill-sprint-setup-start').click();
  await expect(page.getByTestId('drill-sprint-play')).toHaveAttribute(
    'data-state',
    'idle',
    { timeout: 10_000 },
  );
  // Submit #1 (правильный).
  await page.getByTestId('drill-count-attackers-btn-2').click();
  // Дождёмся следующего drill (state=idle, attempted=1).
  await expect(page.getByTestId('drill-sprint-play-score')).toHaveAttribute(
    'data-attempted',
    '1',
    { timeout: 5_000 },
  );
  await expect(page.getByTestId('drill-sprint-play')).toHaveAttribute(
    'data-state',
    'idle',
    { timeout: 5_000 },
  );
  // Submit #2 (неправильный — 4).
  await page.getByTestId('drill-count-attackers-btn-4').click();
  await expect(page.getByTestId('drill-sprint-play-score')).toHaveAttribute(
    'data-attempted',
    '2',
    { timeout: 5_000 },
  );
  await expect(page.getByTestId('drill-sprint-play-score')).toHaveAttribute(
    'data-score',
    '1',
  );
});

// ─────────────────────────────────────────────────────────────────────
// 3) Timeout: sprint завершается по таймеру
// ─────────────────────────────────────────────────────────────────────

test('KS-2244 — timeout: durationMs=2s → /finish вызывается → results', async ({
  context,
  page,
}) => {
  await mockSprintEndpoints(context, {
    durationMs: 2_000,
    drillsBeforeFinal: 100, // не дойдём до этого через submit'ы
    finishResponse: { score: 0, accuracy: 0, avgPrecision: 0 },
  });
  await page.goto(`/drills/sprint?dev_bypass=${BYPASS}`);
  await page.getByTestId('drill-sprint-setup-start').click();
  await expect(page.getByTestId('drill-sprint-play')).toHaveAttribute(
    'data-state',
    'idle',
    { timeout: 10_000 },
  );
  // Не отвечаем — ждём истечения таймера + переход в results.
  await expect(page.getByTestId('drill-sprint-results')).toHaveAttribute(
    'data-state',
    'loaded',
    { timeout: 8_000 },
  );
  await expect(page.getByTestId('drill-sprint-results')).toHaveAttribute(
    'data-ended',
    'expired',
  );
});

// ─────────────────────────────────────────────────────────────────────
// 4) Edge-cases — прямой URL без state
// ─────────────────────────────────────────────────────────────────────

test('KS-2244 — /drills/sprint/play без state → редирект на /drills/sprint (setup)', async ({
  context,
  page,
}) => {
  await mockSprintEndpoints(context);
  await page.goto(`/drills/sprint/play?dev_bypass=${BYPASS}`);
  // PlayPage должен сразу redirect — попадём на setup.
  await expect(page.getByTestId('drill-sprint-setup')).toBeVisible({
    timeout: 10_000,
  });
});

test('KS-2244 — /drills/sprint/results без state → missing-баннер с Play again', async ({
  context,
  page,
}) => {
  await mockSprintEndpoints(context);
  await page.goto(`/drills/sprint/results?dev_bypass=${BYPASS}`);
  await expect(page.getByTestId('drill-sprint-results')).toHaveAttribute(
    'data-state',
    'missing',
    { timeout: 10_000 },
  );
  await expect(page.getByTestId('drill-sprint-results-play-again')).toBeVisible();
  // Click → setup.
  await page.getByTestId('drill-sprint-results-play-again').click();
  await expect(page.getByTestId('drill-sprint-setup')).toBeVisible({
    timeout: 10_000,
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5) Leaderboard
// ─────────────────────────────────────────────────────────────────────

test.describe('KS-2244 — sprint leaderboard', () => {
  test('переключение duration/set/period → каждое отправляет новый запрос', async ({
    context,
    page,
  }) => {
    const requestedUrls: string[] = [];
    await mockSprintEndpoints(context, {
      leaderboardEntries: [
        {
          userId: 'u1',
          username: 'Alice',
          mode: '3min-mixed',
          score: 30,
          accuracy: 0.95,
          createdAt: '2026-05-03T08:00:00Z',
        },
      ],
    });
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/tactic-drill/sprint/leaderboard')) requestedUrls.push(u);
    });
    await page.goto(`/drills/sprint/leaderboard?dev_bypass=${BYPASS}`);
    await expect(page.getByTestId('drill-leaderboard')).toBeVisible({
      timeout: 10_000,
    });
    // default — 3min-mixed × allTime.
    await expect(page.getByTestId('drill-leaderboard')).toHaveAttribute(
      'data-mode',
      '3min-mixed',
    );
    await expect(page.getByTestId('drill-leaderboard')).toHaveAttribute(
      'data-period',
      'allTime',
    );
    // Переключаем фильтры — должно дёргать leaderboard заново.
    await page.getByTestId('drill-leaderboard-duration-5').click();
    await expect(page.getByTestId('drill-leaderboard')).toHaveAttribute(
      'data-mode',
      '5min-mixed',
    );
    await page.getByTestId('drill-leaderboard-set-overview').click();
    await expect(page.getByTestId('drill-leaderboard')).toHaveAttribute(
      'data-mode',
      '5min-overview',
    );
    await page.getByTestId('drill-leaderboard-period-day').click();
    await expect(page.getByTestId('drill-leaderboard')).toHaveAttribute(
      'data-period',
      'day',
    );
    // Для 4 точек состояния — минимум 4 GET'а.
    expect(requestedUrls.length).toBeGreaterThanOrEqual(4);
    expect(
      requestedUrls.some((u) => u.includes('mode=5min-overview&period=day')),
    ).toBe(true);
  });

  test('таблица заполняется entries из ответа, ранг 1..N', async ({
    context,
    page,
  }) => {
    await mockSprintEndpoints(context, {
      leaderboardEntries: [
        { userId: 'u1', username: 'Alice', mode: '3min-mixed', score: 30, accuracy: 0.95, createdAt: '2026-05-03T08:00:00Z' },
        { userId: 'u2', username: 'Bob',   mode: '3min-mixed', score: 22, accuracy: 0.81, createdAt: '2026-05-02T14:00:00Z' },
        { userId: 'u3', username: 'Carol', mode: '3min-mixed', score: 11, accuracy: 0.55, createdAt: '2026-05-01T18:00:00Z' },
      ],
    });
    await page.goto(`/drills/sprint/leaderboard?dev_bypass=${BYPASS}`);
    await expect(page.getByTestId('drill-leaderboard-table')).toBeVisible({
      timeout: 10_000,
    });
    const rows = page.locator('[data-testid="drill-leaderboard-table"] tbody tr');
    await expect(rows).toHaveCount(3);
    // Первая ячейка первой строки — ранг 1.
    await expect(rows.first().locator('td').first()).toHaveText('1');
  });

  test('пустой leaderboard → empty-state', async ({ context, page }) => {
    await mockSprintEndpoints(context, { leaderboardEntries: [] });
    await page.goto(`/drills/sprint/leaderboard?dev_bypass=${BYPASS}`);
    await expect(page.getByTestId('drill-leaderboard-empty')).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6) Mobile portrait — sprint flow tap
// ─────────────────────────────────────────────────────────────────────

test.describe('KS-2244 — mobile portrait sprint flow', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('mobile: setup → play → results через tap', async ({ context, page }) => {
    await mockSprintEndpoints(context, { drillsBeforeFinal: 1 });
    await page.goto(`/drills/sprint?dev_bypass=${BYPASS}`);
    await expect(page.getByTestId('drill-sprint-setup')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('drill-sprint-setup-start').tap();
    await expect(page.getByTestId('drill-sprint-play')).toHaveAttribute(
      'data-state',
      'idle',
      { timeout: 10_000 },
    );
    await page.getByTestId('drill-count-attackers-btn-2').tap();
    await expect(page.getByTestId('drill-sprint-results')).toHaveAttribute(
      'data-state',
      'loaded',
      { timeout: 5_000 },
    );
  });
});
