import { test, expect, type Page } from '@playwright/test';

/**
 * KS-2898 (ADR-060 T5) — E2E save-to-study + invite flow.
 *
 * Сценарии:
 *  1. save new study: создаём analysis через API → открываем
 *     `/analysis/:id` → клик «Save to study» → диалог → новое имя →
 *     submit → success-state → «Open chapter» → URL новой главы.
 *  2. save to existing: уже есть пустая студия → диалог → existing-
 *     режим → select → submit → главa добавлена; через API проверяем
 *     `GET /studies/:slug` count++.
 *  3. invite accept: owner создаёт invite-link (через API) → другой
 *     юзер открывает `/studies/invites/<token>` → видит preview/
 *     fallback → Accept → редирект на `/studies/:slug` → membership
 *     подтверждён через API.
 *  4. invite invalid/expired: открыть страницу с фейковым токеном →
 *     click Accept → inline-error «not found» (backend B5 возвращает
 *     404 на неизвестный или истёкший token — текст одинаковый).
 *
 * Замечание: backend B9 `POST /studies/from-analysis` ТРЕБУЕТ
 * `analysisId` (UUID) — ad-hoc `/analysis` без сохранённого id
 * сейчас не поддерживается на стороне backend. Фронт умеет слать
 * `{pgn, fen}` (FC6, KS-2891), но backend пока не парсит — это
 * out-of-scope для T5. Сценарии save-* делаются на сохранённом
 * analysis (`POST /analyses` → analysisId).
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
  tokens: Tokens | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(tokens && { Authorization: `Bearer ${tokens.accessToken}` }),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function createAnalysis(
  tokens: Tokens,
  pgn: string,
  title: string,
): Promise<{ id: string }> {
  return api<{ id: string }>(tokens, 'POST', '/analyses', { title, pgn });
}

async function createStudy(
  tokens: Tokens,
  name: string,
): Promise<{ id: string; slug: string }> {
  const created = await api<{ id: string; slug: string }>(
    tokens,
    'POST',
    '/studies',
    { name, visibility: 'private' },
  );
  return created;
}

test.describe.configure({ mode: 'serial' });

test.describe('KS-2898 save-to-study + invite E2E', () => {
  // ── 1) save new study ────────────────────────────────────────────
  test('save new study: dialog → submit → редирект на главу новой студии', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks2898-savenew-${Date.now()}`);
    const an = await createAnalysis(owner, '1. e4 e5 *', 'E2E save-new');

    await seedAuth(page, owner);
    await page.goto(`/analysis/${an.id}`);

    // Дожидаемся header AnalysisPage.
    await expect(page.getByTestId('analysis-header-shortcut')).toBeVisible({
      timeout: 20_000,
    });

    // Trigger открывает диалог.
    await page.getByTestId('save-to-study-trigger').click();
    await expect(page.getByTestId('save-to-study-dialog')).toBeVisible();

    // По default — режим 'new'.
    const studyName = `E2E SaveNew ${Math.random().toString(36).slice(2, 8)}`;
    await page.getByTestId('save-to-study-new-name').fill(studyName);
    await page.getByTestId('save-to-study-submit').click();

    // Success-state с CTA «Open chapter».
    await expect(page.getByTestId('save-to-study-success')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('save-to-study-open-chapter').click();

    // Редирект на /studies/<slug>/<chapterId>.
    await expect(page).toHaveURL(/\/studies\/[^/]+\/[^/]+/, {
      timeout: 10_000,
    });
  });

  // ── 2) save to existing ─────────────────────────────────────────
  test('save to existing study: dialog → select → submit → главa добавлена', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks2898-saveexist-${Date.now()}`);
    const an = await createAnalysis(owner, '1. d4 d5 *', 'E2E save-existing');
    const target = await createStudy(
      owner,
      `E2E Target ${Math.random().toString(36).slice(2, 8)}`,
    );

    // До: считаем кол-во глав в target (0 при создании).
    const before = await api<{ chapters: unknown[] }>(
      owner,
      'GET',
      `/studies/${target.slug}`,
    );
    const beforeCount = before.chapters.length;

    await seedAuth(page, owner);
    await page.goto(`/analysis/${an.id}`);
    await expect(page.getByTestId('analysis-header-shortcut')).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId('save-to-study-trigger').click();
    await expect(page.getByTestId('save-to-study-dialog')).toBeVisible();

    // Переключаемся в existing-mode → list загружается.
    await page.getByTestId('save-to-study-mode-existing').click();
    const select = page.getByTestId('save-to-study-select');
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.selectOption(target.id);
    await page.getByTestId('save-to-study-submit').click();

    // Success → Open chapter → URL `/studies/<slug>/...`.
    await expect(page.getByTestId('save-to-study-success')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('save-to-study-open-chapter').click();
    await expect(page).toHaveURL(
      new RegExp(`/studies/${target.slug}/`),
      { timeout: 10_000 },
    );

    // Сверим через API: глав стало больше на 1.
    const after = await api<{ chapters: unknown[] }>(
      owner,
      'GET',
      `/studies/${target.slug}`,
    );
    expect(after.chapters.length).toBe(beforeCount + 1);
  });

  // ── 3) invite accept ────────────────────────────────────────────
  test('invite accept: другой юзер становится contributor', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks2898-ownerinv-${Date.now()}`);
    const guest = await devBypass(`ks2898-guestinv-${Date.now()}`);
    const study = await createStudy(
      owner,
      `E2E Invite ${Math.random().toString(36).slice(2, 8)}`,
    );

    // Owner генерирует invite-link.
    const invite = await api<{ token: string; url: string; expiresAt: string }>(
      owner,
      'POST',
      `/studies/${study.slug}/invite-link`,
      {},
    );

    // Guest заходит в свой контекст.
    const ctx = await browser.newContext();
    const guestPage = await ctx.newPage();
    await seedAuth(guestPage, guest);
    await guestPage.goto(`/studies/invites/${invite.token}`);

    // Header + Accept-кнопка появляются (preview либо ok, либо
    // fallback — в обоих случаях accept активна).
    await expect(guestPage.getByTestId('study-invite-title')).toBeVisible({
      timeout: 20_000,
    });
    await expect(guestPage.getByTestId('study-invite-accept')).toBeEnabled();
    await guestPage.getByTestId('study-invite-accept').click();

    // Редирект на /studies/<slug>.
    await expect(guestPage).toHaveURL(new RegExp(`/studies/${study.slug}`), {
      timeout: 10_000,
    });

    // Подтверждение через API: guest — в members студии.
    const members = await api<{
      members: Array<{ userId: string; role: string }>;
    }>(owner, 'GET', `/studies/${study.slug}/members`);
    const guestId = await api<{ id: string }>(
      guest,
      'GET',
      '/auth/me',
    ).then((u) => u.id);
    const found = members.members.find((m) => m.userId === guestId);
    expect(found).toBeTruthy();
    expect(found?.role).toBe('contributor');

    await ctx.close();
  });

  // ── 4) invite invalid/expired ────────────────────────────────────
  test('invite invalid token: Accept → inline-error «not found»', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const guest = await devBypass(`ks2898-guestbad-${Date.now()}`);

    await seedAuth(page, guest);
    // Заведомо несуществующий токен — backend B5 отдаёт 404 «Invite
    // not found» что для UX (FC8) идентично «expired» / «used».
    await page.goto('/studies/invites/ks2898-bogus-token-zzz');

    // Title виден, кнопка Accept всё-таки появляется (preview
    // graceful-fallback). Тыкаем Accept → ловим inline-error.
    await expect(page.getByTestId('study-invite-title')).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId('study-invite-accept').click();
    await expect(page.getByTestId('study-invite-accept-error')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId('study-invite-accept-error'),
    ).toContainText(/not found|deleted|expired/i);
    // Остались на странице приглашения, навигации не было.
    await expect(page).toHaveURL(/\/studies\/invites\//);
  });
});
