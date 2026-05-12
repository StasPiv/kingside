import { test, expect, type Page } from '@playwright/test';

/**
 * KS-2878 (ADR-060 T2) — E2E на режимы practice / conceal / gamebook.
 *
 * Сценарии:
 *  1. practice: создать главу с main-line → switch mode='practice' →
 *     правильный ход через mode-switcher → проверить practice-bar.
 *  2. conceal: создать главу с concealPly=1 → открыть public-readonly
 *     URL → проверить, что MoveList показывает `???` для ply>1.
 *  3. gamebook: создать главу с gamebook payload → открыть `/play` →
 *     intro → Start → playing-phase.
 *
 * Полные сценарии «двигать фигуры через Playwright» требуют точной
 * pointer-event симуляции (useFastDrag), что в этом проекте уже
 * было нетривиально (см. KS-2855). Здесь покрываем главное: что
 * UI-state соответствует режиму, и что страница не падает.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';

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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface CreatedFixtures {
  slug: string;
  chapterId: string;
}

async function createStudyWithChapter(
  tokens: Tokens,
  options: {
    studyName: string;
    chapterName: string;
    pgn: string;
    mode?: 'analysis' | 'practice' | 'conceal' | 'gamebook';
    concealPly?: number;
    gamebook?: { intro?: string; byUci?: Record<string, { hint?: string; success?: string; failure?: string }> };
    isPublic?: boolean;
  },
): Promise<CreatedFixtures> {
  const study = await api<{ slug: string }>(tokens, 'POST', '/studies', {
    name: options.studyName,
    visibility: options.isPublic ? 'public' : 'private',
  });
  if (options.isPublic) {
    await api(tokens, 'PATCH', `/studies/${study.slug}`, { isPublic: true });
  }
  const chapter = await api<{ id: string }>(
    tokens,
    'POST',
    `/studies/${study.slug}/chapters`,
    {
      name: options.chapterName,
      pgn: options.pgn,
      mode: options.mode ?? 'analysis',
      ...(options.concealPly != null && { concealPly: options.concealPly }),
      ...(options.gamebook != null && { gamebook: options.gamebook }),
    },
  );
  // KS-2878: некоторые backend-эндпоинты (B3 chapter-create) могут
  // не принимать concealPly/gamebook в момент создания. Гарантируем
  // через PATCH что эти поля сохранились.
  if (options.concealPly != null || options.gamebook != null) {
    await api(
      tokens,
      'PATCH',
      `/studies/${study.slug}/chapters/${chapter.id}`,
      {
        ...(options.concealPly != null && { concealPly: options.concealPly }),
        ...(options.gamebook != null && { gamebook: options.gamebook }),
      },
    );
  }
  return { slug: study.slug, chapterId: chapter.id };
}

test.describe.configure({ mode: 'serial' });

test.describe('KS-2878 Studies modes E2E', () => {
  test('practice: mode-switcher → practice-bar + persistence отключён', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Достаточно одного desktop-прогона.',
    );
    const tokens = await devBypass(`ks2878-practice-${Date.now()}`);
    const fix = await createStudyWithChapter(tokens, {
      studyName: `Practice ${Date.now()}`,
      chapterName: 'Lesson',
      pgn: '1. e4 e5 2. Nf3 Nc6 *',
      mode: 'practice',
    });

    await seedAuth(page, tokens);
    await page.goto(`/studies/${fix.slug}/${fix.chapterId}`);

    // AnalysisHeader виден.
    await expect(
      page.getByTestId('analysis-header-shortcut'),
    ).toBeVisible({ timeout: 20_000 });

    // Mode-switcher показывает 'practice'.
    const select = page.getByTestId('analysis-study-mode-select');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('practice');

    // Practice-bar отрисован.
    await expect(
      page.getByTestId('analysis-practice-bar'),
    ).toBeVisible();
    await expect(page.getByTestId('analysis-practice-bar')).toHaveAttribute(
      'data-mode',
      'practice',
    );
  });

  test('conceal: public-readonly → mode-switcher показывает Conceal selected', async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Достаточно одного desktop-прогона.',
    );
    // KS-2878: полная проверка `???`-рендера требует backend B3
    // (concealPly persistence). На данный момент B3 не подключён —
    // проверяем только что mode='conceal' доезжает до UI.
    // ToDo: когда B3 будет готов, расширить — assert на data-concealed='true'
    // элементы в [data-testid^=\"review-move-\"].
    const tokens = await devBypass(`ks2878-conceal-${Date.now()}`);
    const fix = await createStudyWithChapter(tokens, {
      studyName: `Conceal ${Date.now()}`,
      chapterName: 'Hidden',
      pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 *',
      mode: 'conceal',
      concealPly: 2,
      isPublic: true,
    });

    // Public-readonly доступ — без auth.
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`/studies/c/${fix.chapterId}`);

    await expect(
      anonPage.getByTestId('analysis-header-shortcut'),
    ).toBeVisible({ timeout: 20_000 });

    // Mode-switcher показывает Conceal (disabled в public-readonly).
    const select = anonPage.getByTestId('analysis-study-mode-select');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('conceal');
    await expect(select).toBeDisabled();

    await anonContext.close();
    void page;
  });

  test('gamebook: editor создаёт gamebook → /play показывает intro + Start', async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Достаточно одного desktop-прогона.',
    );
    const tokens = await devBypass(`ks2878-gamebook-${Date.now()}`);
    const fix = await createStudyWithChapter(tokens, {
      studyName: `Gamebook ${Date.now()}`,
      chapterName: 'Story',
      pgn: '1. e4 e5 *',
      mode: 'gamebook',
      gamebook: {
        intro: 'Welcome to my gamebook lesson.',
        byUci: {
          e2e4: { success: 'Excellent opening!' },
          e7e5: { success: 'Classical reply.' },
        },
      },
      isPublic: true,
    });

    // Editor: AnalysisGamebookEditor рендерится.
    await seedAuth(page, tokens);
    await page.goto(`/studies/${fix.slug}/${fix.chapterId}`);
    await expect(
      page.getByTestId('analysis-gamebook-editor'),
    ).toBeVisible({ timeout: 20_000 });

    // Reader (/play) — без auth. KS-2878: полная проверка intro-текста
    // требует backend B5 (gamebook payload persistence). Здесь — smoke:
    // страница рендерится, intro-секция и Start-кнопка появляются.
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`/studies/c/${fix.chapterId}/play`);
    await expect(
      anonPage.getByTestId('gamebook-reader-page'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      anonPage.getByTestId('gamebook-reader-intro'),
    ).toBeVisible();
    await expect(
      anonPage.getByTestId('gamebook-reader-start'),
    ).toBeVisible();

    // Клик Start → phase=playing.
    await anonPage.getByTestId('gamebook-reader-start').click();
    await expect(anonPage.getByTestId('gamebook-reader-page')).toHaveAttribute(
      'data-phase',
      'playing',
    );
    await expect(
      anonPage.getByTestId('gamebook-reader-feedback'),
    ).toBeVisible();
    await anonContext.close();
  });
});
