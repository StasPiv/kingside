import { test, expect, type Page } from '@playwright/test';

/**
 * KS-3014 (hotfix) — role-based gating Studies.
 *
 * Backend KS-3015 отдаёт `study.viewerRole` в DTO `/studies/:slug`.
 * Фронт по нему скрывает owner-actions / редиректит editor-route на
 * public-readonly для viewer/anon.
 *
 * Покрытие:
 *  1. anon (без auth) → видит read-only UI: НЕТ owner-actions,
 *     НЕТ role-badge. Бейдж public/private + Like — есть.
 *  2. viewer (другой auth-юзер, не member) → owner-actions
 *     отсутствуют; виден role-badge «Read-only».
 *  3. contributor (приглашённый owner'ом) → видит «+ New chapter»,
 *     НЕ видит share/import/members/delete; role-badge «Contributor».
 *  4. owner → полный UI: все owner-actions + role-badge «Owner».
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

test.describe.configure({ mode: 'serial' });

test.describe('KS-3014 Studies role gating', () => {
  test('anon: read-only UI без owner-actions и без role-badge', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks3014-owner-${Date.now()}`);
    const study = await api<{ slug: string }>(owner, 'POST', '/studies', {
      name: `KS3014 anon ${Date.now()}`,
      visibility: 'public',
    });

    const ctx = await browser.newContext();
    const anonPage = await ctx.newPage();
    await anonPage.goto(`/studies/${study.slug}`);
    await expect(anonPage.getByTestId('study-page-name')).toBeVisible({
      timeout: 20_000,
    });
    expect(
      await anonPage.locator('[data-testid="study-owner-actions"]').count(),
    ).toBe(0);
    expect(
      await anonPage.locator('[data-testid="study-page-role-badge"]').count(),
    ).toBe(0);
    await ctx.close();
  });

  test('viewer (auth не-member): owner-actions скрыты, видна метка «Read-only»', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks3014-owner-v-${Date.now()}`);
    const viewer = await devBypass(`ks3014-viewer-${Date.now()}`);
    const study = await api<{ slug: string }>(owner, 'POST', '/studies', {
      name: `KS3014 viewer ${Date.now()}`,
      visibility: 'public',
    });

    const ctx = await browser.newContext();
    const viewerPage = await ctx.newPage();
    await seedAuth(viewerPage, viewer);
    await viewerPage.goto(`/studies/${study.slug}`);
    await expect(viewerPage.getByTestId('study-page-name')).toBeVisible({
      timeout: 20_000,
    });
    expect(
      await viewerPage.locator('[data-testid="study-owner-actions"]').count(),
    ).toBe(0);
    const badge = viewerPage.getByTestId('study-page-role-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-viewer-role', 'viewer');
    await ctx.close();
  });

  test('contributor: «+ New chapter» виден, остальные owner-actions скрыты', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks3014-owner-c-${Date.now()}`);
    const guestName = `ks3014-contrib-${Date.now()}`;
    const guest = await devBypass(guestName);
    const study = await api<{ slug: string }>(owner, 'POST', '/studies', {
      name: `KS3014 contrib ${Date.now()}`,
      visibility: 'public',
    });
    await api(owner, 'POST', `/studies/${study.slug}/members`, {
      userIdOrUsername: guestName,
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await seedAuth(page, guest);
    await page.goto(`/studies/${study.slug}`);
    await expect(page.getByTestId('study-page-name')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('study-owner-actions')).toBeVisible();
    await expect(
      page.getByTestId('study-action-create-chapter'),
    ).toBeVisible();
    // owner-only кнопки отсутствуют.
    for (const id of [
      'study-action-share',
      'study-action-import-pgn',
      'study-action-members',
      'study-action-delete',
    ]) {
      expect(await page.locator(`[data-testid="${id}"]`).count()).toBe(0);
    }
    await expect(
      page.getByTestId('study-page-role-badge'),
    ).toHaveAttribute('data-viewer-role', 'contributor');
    await ctx.close();
  });

  test('owner: полный набор owner-actions + role-badge', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const owner = await devBypass(`ks3014-owner-o-${Date.now()}`);
    const study = await api<{ slug: string }>(owner, 'POST', '/studies', {
      name: `KS3014 owner ${Date.now()}`,
      visibility: 'public',
    });
    await seedAuth(page, owner);
    await page.goto(`/studies/${study.slug}`);
    await expect(page.getByTestId('study-owner-actions')).toBeVisible({
      timeout: 20_000,
    });
    for (const id of [
      'study-action-share',
      'study-action-create-chapter',
      'study-action-import-pgn',
      'study-action-members',
      'study-action-delete',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(
      page.getByTestId('study-page-role-badge'),
    ).toHaveAttribute('data-viewer-role', 'owner');
  });
});
