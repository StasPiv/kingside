import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * KS-1751: проверки поведения resolveArchiveUrl в dev / prod окружении.
 * Модуль вычисляет `ARCHIVE_URL` at module-load, поэтому каждый кейс
 * переопределяет `import.meta.env` через `vi.stubEnv` и затем
 * подгружает модуль через `vi.resetModules` + dynamic import.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  const mod = await import('./archiveUrl');
  return mod as typeof import('./archiveUrl');
}

describe('archiveUrl — VITE_ARCHIVE_URL resolution', () => {
  it('использует переменную, если задана (trailing slash обрезан)', async () => {
    vi.stubEnv('VITE_ARCHIVE_URL', 'https://archive.kingside.site/');
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);

    const { ARCHIVE_URL } = await loadModule();
    expect(ARCHIVE_URL).toBe('https://archive.kingside.site');
  });

  it('в dev fallback на http://localhost:3003 + console.warn при пустой переменной', async () => {
    vi.stubEnv('VITE_ARCHIVE_URL', '');
    vi.stubEnv('DEV', true);
    vi.stubEnv('PROD', false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { ARCHIVE_URL } = await loadModule();

    expect(ARCHIVE_URL).toBe('http://localhost:3003');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/VITE_ARCHIVE_URL is not set/);
  });

  it('в prod throw при отсутствии переменной (silent fallback запрещён)', async () => {
    vi.stubEnv('VITE_ARCHIVE_URL', '');
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);

    await expect(loadModule()).rejects.toThrow(/VITE_ARCHIVE_URL is not set/);
  });
});
