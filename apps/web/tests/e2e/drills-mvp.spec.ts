import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * KS-2239 (ADR-035 §11, Drills E3 QA) — e2e Drill mode MVP.
 *
 * Покрывает:
 *  • feature-flag off → /drills редирект на /lobby; on → лобби открывается
 *  • лобби: 7 карточек (KS-2394 — find-mate-in-one-square удалён),
 *    3 секции по слою методики
 *  • happy-path для всех 7 drill-типов × 4 answer-shape
 *  • feedback overlay correct/incorrect + state='feedback'
 *  • mobile portrait flow (hasTouch, viewport 390×844)
 *  • DrillStatsPanel в профиле — обновляется после прохождения
 *
 * # Workaround на проде drillsEnabled=false
 *
 * `/config` подменяется через `page.route('**\/config', …)` —
 * выставляем `drillsEnabled=true`, остальные флаги как на проде.
 * `/tactic-drill/*` тоже мокается фикстурными данными — иначе
 * "no drills available" (БД пуста, KS-DRILL-INDEX ещё не запущен в
 * этом окружении).
 *
 * После раскатки реального индекса в БД admin может оставить только
 * `/config` мок (включить флаг через PATCH /admin/feature-flags), и
 * тесты прогонят с настоящими drill'ами — assertion'ы не привязаны к
 * конкретным FEN'ам, проверяют только UI-flow.
 */

import type {
  TacticDrillType,
  AnswerShape,
  TacticDrillDto,
  TacticDrillAttemptResponse,
  TacticDrillStatsResponse,
} from '@kingside/shared';

// ── Фикстуры под все 8 drill-типов и их answer-shape ──────────────────

interface DrillFixture {
  type: TacticDrillType;
  answerShape: AnswerShape;
  drill: TacticDrillDto;
  /** Что вернёт /attempt (правильный ответ для feedback). */
  correctAnswer: TacticDrillAttemptResponse['correctAnswer'];
}

const FIXTURES: Record<TacticDrillType, DrillFixture> = {
  'count-attackers': {
    type: 'count-attackers',
    answerShape: 'number',
    drill: {
      id: 'd-count',
      drillType: 'count-attackers',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1',
      sideToMove: null,
      answerShape: 'number',
      difficulty: 1,
      meta: { highlightedSquare: 'e5' },
    },
    correctAnswer: { shape: 'number', value: 2 },
  },
  'find-loose-piece': {
    type: 'find-loose-piece',
    answerShape: 'square',
    drill: {
      id: 'd-loose',
      drillType: 'find-loose-piece',
      fen: 'r3k2r/ppp2ppp/2n2n2/2bqp3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 1',
      sideToMove: null,
      answerShape: 'square',
      difficulty: 1,
    },
    correctAnswer: { shape: 'square', square: 'e4' },
  },
  'find-hanging-piece': {
    type: 'find-hanging-piece',
    answerShape: 'square',
    drill: {
      id: 'd-hanging',
      drillType: 'find-hanging-piece',
      fen: 'r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2',
      sideToMove: 'w',
      answerShape: 'square',
      difficulty: 2,
    },
    correctAnswer: { shape: 'square', square: 'c6' },
  },
  'find-all-checks': {
    type: 'find-all-checks',
    answerShape: 'squares',
    drill: {
      id: 'd-checks',
      drillType: 'find-all-checks',
      fen: 'r3k2r/ppp2ppp/2n2n2/2bqp3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 1',
      sideToMove: 'w',
      answerShape: 'squares',
      difficulty: 3,
      meta: { expectedCount: 2 },
    },
    correctAnswer: { shape: 'squares', squares: ['e4', 'e5'] },
  },
  'find-pin': {
    type: 'find-pin',
    answerShape: 'square',
    drill: {
      id: 'd-pin',
      drillType: 'find-pin',
      fen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
      sideToMove: 'w',
      answerShape: 'square',
      difficulty: 2,
    },
    correctAnswer: { shape: 'square', square: 'c5' },
  },
  'find-fork': {
    type: 'find-fork',
    answerShape: 'square',
    drill: {
      id: 'd-fork',
      drillType: 'find-fork',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 0 1',
      sideToMove: 'w',
      answerShape: 'square',
      difficulty: 3,
    },
    correctAnswer: { shape: 'square', square: 'd5' },
  },
  // KS-2394: тип `find-mate-in-one-square` удалён из v1, фикстура снята.
  'find-undefended-attack': {
    type: 'find-undefended-attack',
    answerShape: 'move',
    drill: {
      id: 'd-undef',
      drillType: 'find-undefended-attack',
      fen: 'r2qkb1r/ppp2ppp/2n2n2/3pp3/3PP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq - 0 1',
      sideToMove: 'w',
      answerShape: 'move',
      difficulty: 4,
    },
    correctAnswer: { shape: 'move', from: 'd4', to: 'e5' },
  },
};

// KS-2394: `find-mate-in-one-square` удалён из v1 — список 7-элементный.
const TYPES = [
  'count-attackers',
  'find-loose-piece',
  'find-hanging-piece',
  'find-all-checks',
  'find-pin',
  'find-fork',
  'find-undefended-attack',
] as const;

// ── Mock-helpers для context ───────────────────────────────────────────

interface SetupOptions {
  drillsEnabled: boolean;
  /**
   * Стартовая статистика, отдаваемая `/stats/me`. После каждого attempt
   * счётчики растут — это эмулируем переменной shared между route
   * handlers.
   */
  initialStats?: TacticDrillStatsResponse;
}

interface MockState {
  stats: TacticDrillStatsResponse;
  attempts: number;
  lastSubmittedType: TacticDrillType | null;
  lastSolved: boolean;
}

function emptyStats(): TacticDrillStatsResponse {
  return {
    total: { attempts: 0, solved: 0, accuracy: 0 },
    byType: TYPES.map((type) => ({
      drillType: type,
      attempts: 0,
      solved: 0,
      accuracy: 0,
      avgTimeMs: 0,
    })),
    unlocked: [],
  };
}

async function setupContextMocks(
  ctx: BrowserContext,
  opts: SetupOptions,
): Promise<MockState> {
  const state: MockState = {
    stats: opts.initialStats ?? emptyStats(),
    attempts: 0,
    lastSubmittedType: null,
    lastSolved: false,
  };
  // /config — feature-flag drillsEnabled.
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
          drillsEnabled: opts.drillsEnabled,
        },
      }),
    });
  });

  // /tactic-drill/types — каталог типов (для лобби).
  await ctx.route('**/tactic-drill/types', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        types: TYPES.map((id) => ({
          id,
          layer:
            id === 'find-all-checks' ||
            id === 'find-pin' ||
            id === 'find-fork'
              ? 'pattern'
              : id === 'find-undefended-attack'
                ? 'calculation'
                : 'overview',
          answerShape: FIXTURES[id].answerShape,
          promptKey: `review.drill.prompt.${id}`,
          unlocked: true,
        })),
      }),
    });
  });

  // /tactic-drill/next?type=… — отдаём фикстуру для запрошенного типа.
  await ctx.route('**/tactic-drill/next**', async (route) => {
    const url = new URL(route.request().url());
    const t = url.searchParams.get('type') as TacticDrillType | null;
    const fixture = t && FIXTURES[t];
    if (!fixture) {
      await route.fulfill({ status: 404, body: '{"message":"not found"}' });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixture.drill),
    });
  });

  // /tactic-drill/attempt — возвращаем correctAnswer и обновляем stats.
  await ctx.route('**/tactic-drill/attempt', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    const drillId: string = body.drillId ?? '';
    // Найдём фикстуру по drillId.
    const fixture = Object.values(FIXTURES).find((f) => f.drill.id === drillId);
    const userAnswer = body.userAnswer;
    const correct = fixture?.correctAnswer;
    // Чистая (без метрик) проверка solved — для assertion в тестах
    // достаточно, чтобы фикстура определяла «правильный» ответ.
    const solved = correct ? answerEquals(userAnswer, correct) : false;
    state.attempts += 1;
    state.lastSubmittedType = fixture?.type ?? null;
    state.lastSolved = solved;
    if (fixture) {
      const row = state.stats.byType.find(
        (r) => r.drillType === fixture.type,
      );
      if (row) {
        row.attempts += 1;
        if (solved) row.solved += 1;
        row.accuracy = row.attempts > 0 ? row.solved / row.attempts : 0;
        row.avgTimeMs = body.timeMs ?? row.avgTimeMs;
      }
      state.stats.total.attempts += 1;
      if (solved) state.stats.total.solved += 1;
      state.stats.total.accuracy =
        state.stats.total.attempts > 0
          ? state.stats.total.solved / state.stats.total.attempts
          : 0;
      // unlocked после первого attempt этого типа.
      if (!state.stats.unlocked.includes(fixture.type)) {
        state.stats.unlocked.push(fixture.type);
      }
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: `att-${state.attempts}`,
        solved,
        correctAnswer: correct ?? userAnswer,
      }),
    });
  });

  // /tactic-drill/stats/me — возвращаем актуальный state.
  await ctx.route('**/tactic-drill/stats/me', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.stats),
    });
  });

  return state;
}

function answerEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aa = a as Record<string, unknown>;
  const bb = b as Record<string, unknown>;
  if (aa.shape !== bb.shape) return false;
  if (aa.shape === 'square') return aa.square === bb.square;
  if (aa.shape === 'number') return aa.value === bb.value;
  if (aa.shape === 'move') return aa.from === bb.from && aa.to === bb.to;
  if (aa.shape === 'squares') {
    const A = (aa.squares as string[]).slice().sort();
    const B = (bb.squares as string[]).slice().sort();
    return A.length === B.length && A.every((v, i) => v === B[i]);
  }
  return false;
}

// ── Fire square click: react-chessboard рендерит клетки без удобного
//    selector, поэтому в e2e работаем через DrillBoard.onSquareClick →
//    дёргаем нужную клетку через JS API доски. Внутри контейнера
//    [data-testid="drill-board"] клетка имеет класс .square-{file}{rank}
//    в react-chessboard v5. Используем page.evaluate чтобы найти и
//    кликнуть.
async function clickSquare(page: Page, square: string) {
  await page.evaluate((sq: string) => {
    // react-chessboard v5 рендерит клетки с aria-label="<file><rank>"
    // или data-square=… — пробуем оба.
    const el =
      document.querySelector(`[data-square="${sq}"]`) ??
      document.querySelector(`[aria-label="${sq}"]`);
    if (el && el instanceof HTMLElement) el.click();
  }, square);
}

async function gotoDrills(page: Page, type?: string) {
  const path = type ? `/drills/${type}` : '/drills';
  await page.goto(`${path}?dev_bypass=kingside-dev-bypass-2026`);
}

// ─────────────────────────────────────────────────────────────────────
// 1) Feature-flag off/on
// ─────────────────────────────────────────────────────────────────────

test.describe('KS-2239 / KS-2231 — feature-flag drillsEnabled', () => {
  test('off → /drills редиректит на /lobby', async ({ context, page }) => {
    await setupContextMocks(context, { drillsEnabled: false });
    await gotoDrills(page);
    await expect(page).toHaveURL(/\/lobby/);
  });

  test('on → /drills открывается, лобби рендерит 7 карточек в 3 секциях', async ({
    context,
    page,
  }) => {
    await setupContextMocks(context, { drillsEnabled: true });
    await gotoDrills(page);
    await expect(page.getByTestId('drills-lobby')).toBeVisible();
    await expect(page.getByTestId('drills-lobby-layer-overview')).toBeVisible();
    await expect(page.getByTestId('drills-lobby-layer-pattern')).toBeVisible();
    await expect(page.getByTestId('drills-lobby-layer-calculation')).toBeVisible();
    // KS-2394: было 8, стало 7 после удаления find-mate-in-one-square.
    await expect(page.getByTestId('drill-type-card')).toHaveCount(7);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2) 8 happy-path × тип
// ─────────────────────────────────────────────────────────────────────

for (const type of TYPES) {
  test(`KS-2239 — happy-path для ${type}`, async ({ context, page }) => {
    await setupContextMocks(context, { drillsEnabled: true });
    await gotoDrills(page, type);
    await expect(
      page.locator('[data-testid="drill-page"][data-state="idle"]'),
    ).toBeVisible({ timeout: 10_000 });
    const fixture = FIXTURES[type];

    // Submit правильного ответа в зависимости от answer-shape.
    switch (fixture.answerShape) {
      case 'square': {
        const correct = fixture.correctAnswer as { square: string };
        await clickSquare(page, correct.square);
        break;
      }
      case 'number': {
        const correct = fixture.correctAnswer as { value: number };
        await page
          .getByTestId(`drill-count-attackers-btn-${correct.value}`)
          .click();
        break;
      }
      case 'squares': {
        const correct = fixture.correctAnswer as { squares: string[] };
        for (const sq of correct.squares) await clickSquare(page, sq);
        await page.getByTestId('drill-page-submit').click();
        break;
      }
      case 'move': {
        const correct = fixture.correctAnswer as { from: string; to: string };
        await clickSquare(page, correct.from);
        await clickSquare(page, correct.to);
        break;
      }
    }

    // После submit'а — feedback с зелёной подсветкой (correct=true).
    await expect(
      page.locator('[data-testid="drill-page"][data-state="feedback"]'),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('drill-feedback')).toHaveAttribute(
      'data-result',
      'correct',
    );
    await expect(page.getByTestId('drill-page-next')).toBeVisible();
  });
}

// ─────────────────────────────────────────────────────────────────────
// 3) Feedback — зелёная и красная подсветка
// ─────────────────────────────────────────────────────────────────────

test('KS-2239 — feedback overlay correct (зелёная)', async ({
  context,
  page,
}) => {
  await setupContextMocks(context, { drillsEnabled: true });
  await gotoDrills(page, 'count-attackers');
  await expect(
    page.locator('[data-testid="drill-page"][data-state="idle"]'),
  ).toBeVisible({ timeout: 10_000 });
  // Правильный ответ для count-attackers фикстуры — value=2.
  await page.getByTestId('drill-count-attackers-btn-2').click();
  await expect(page.getByTestId('drill-feedback')).toHaveAttribute(
    'data-result',
    'correct',
  );
});

test('KS-2239 — feedback overlay incorrect (красная)', async ({
  context,
  page,
}) => {
  await setupContextMocks(context, { drillsEnabled: true });
  await gotoDrills(page, 'count-attackers');
  await expect(
    page.locator('[data-testid="drill-page"][data-state="idle"]'),
  ).toBeVisible({ timeout: 10_000 });
  // Намеренно неправильный — 4 (correct=2).
  await page.getByTestId('drill-count-attackers-btn-4').click();
  await expect(page.getByTestId('drill-feedback')).toHaveAttribute(
    'data-result',
    'incorrect',
  );
});

// ─────────────────────────────────────────────────────────────────────
// 4) Mobile portrait flow
// ─────────────────────────────────────────────────────────────────────

test.describe('KS-2239 — mobile portrait', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('count-attackers happy-path на mobile (touch)', async ({
    context,
    page,
  }) => {
    await setupContextMocks(context, { drillsEnabled: true });
    await gotoDrills(page, 'count-attackers');
    await expect(
      page.locator('[data-testid="drill-page"][data-state="idle"]'),
    ).toBeVisible({ timeout: 10_000 });
    // Цифровая кнопка 2 — touch tap.
    await page.getByTestId('drill-count-attackers-btn-2').tap();
    await expect(page.getByTestId('drill-feedback')).toHaveAttribute(
      'data-result',
      'correct',
    );
  });

  test('Next-кнопка на mobile открывает следующий drill', async ({
    context,
    page,
  }) => {
    await setupContextMocks(context, { drillsEnabled: true });
    await gotoDrills(page, 'count-attackers');
    await expect(
      page.locator('[data-testid="drill-page"][data-state="idle"]'),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('drill-count-attackers-btn-2').tap();
    await expect(page.getByTestId('drill-page-next')).toBeVisible();
    await page.getByTestId('drill-page-next').tap();
    await expect(
      page.locator('[data-testid="drill-page"][data-state="idle"]'),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5) Stats panel в профиле — обновляется после прохождения
// ─────────────────────────────────────────────────────────────────────

test('KS-2239 — DrillStatsPanel обновляется после прохождения drill', async ({
  context,
  page,
}) => {
  await setupContextMocks(context, {
    drillsEnabled: true,
    initialStats: {
      total: { attempts: 0, solved: 0, accuracy: 0 },
      byType: TYPES.map((type) => ({
        drillType: type,
        attempts: 0,
        solved: 0,
        accuracy: 0,
        avgTimeMs: 0,
      })),
      unlocked: [],
    },
  });

  // Пройдём count-attackers (правильно).
  await gotoDrills(page, 'count-attackers');
  await expect(
    page.locator('[data-testid="drill-page"][data-state="idle"]'),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('drill-count-attackers-btn-2').click();
  await expect(page.getByTestId('drill-feedback')).toBeVisible();

  // Перейдём в свой профиль и проверим, что panel показывает 1/1.
  await page.goto('/player/DEV');
  await expect(
    page.locator('[data-testid="drill-stats-panel"][data-state="loaded"]'),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByTestId('drill-stats-panel-total-attempts'),
  ).toHaveText('1');
  await expect(
    page.getByTestId('drill-stats-panel-total-solved'),
  ).toHaveText('1');
  // Accuracy 100% (или 100 %).
  await expect(
    page.getByTestId('drill-stats-panel-total-accuracy'),
  ).toHaveText(/100\s*%/);
  // count-attackers разблокирован.
  await expect(
    page.getByTestId('drill-stats-panel-badge-count-attackers'),
  ).toHaveText(/Открыт|Unlocked/);
});
