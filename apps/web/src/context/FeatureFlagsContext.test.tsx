import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

import {
  DEFAULT_FLAGS,
  FeatureFlagsProvider,
  useFeatureFlag,
  useFeatureFlags,
} from './FeatureFlagsContext';

/**
 * KS-2105: тесты на FeatureFlagsContext.
 *
 * Покрытие:
 *  • Provider грузит `/config` на mount, обновляет state, отдаёт
 *    значение через `useFeatureFlag`.
 *  • До прихода ответа — рендерится с дефолтами / cached (без
 *    мигания).
 *  • Ошибка `/config` не падает приложение, остаются дефолты,
 *    `error` выставлен.
 *  • `useFeatureFlag` вне Provider — возвращает дефолт (safe
 *    fallback), без runtime-исключений.
 *  • `refresh()` тригерит повторный запрос.
 */

const mockApi = {
  getConfig: vi.fn(),
};

vi.mock('../api/configApi', () => ({
  configApi: {
    getConfig: (...args: unknown[]) => mockApi.getConfig(...args),
    updateFeatureFlag: vi.fn(),
  },
}));

beforeEach(() => {
  mockApi.getConfig.mockReset();
  // localStorage чистим, чтобы cached-флаги не подменяли начальный state.
  localStorage.removeItem('featureFlags:v1');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function FlagProbe({ flagKey }: { flagKey: 'lessonsEnabled' }) {
  const value = useFeatureFlag(flagKey);
  const { loading, error } = useFeatureFlags();
  return (
    <div>
      <div data-testid="flag-value">{value ? 'on' : 'off'}</div>
      <div data-testid="flag-loading">{loading ? 'loading' : 'ready'}</div>
      <div data-testid="flag-error">{error ?? ''}</div>
    </div>
  );
}

describe('FeatureFlagsContext (KS-2105)', () => {
  it('грузит /config на mount и проставляет значение в state', async () => {
    mockApi.getConfig.mockResolvedValueOnce({
      featureFlags: { lessonsEnabled: false },
    });

    render(
      <FeatureFlagsProvider disableRefresh>
        <FlagProbe flagKey="lessonsEnabled" />
      </FeatureFlagsProvider>,
    );

    // Стартовое значение — DEFAULT_FLAGS (true), пока запрос ещё идёт.
    expect(screen.getByTestId('flag-value').textContent).toBe('on');
    expect(screen.getByTestId('flag-loading').textContent).toBe('loading');

    // После ответа — значение из ответа (false).
    await waitFor(() =>
      expect(screen.getByTestId('flag-value').textContent).toBe('off'),
    );
    expect(screen.getByTestId('flag-loading').textContent).toBe('ready');
    expect(screen.getByTestId('flag-error').textContent).toBe('');
  });

  it('сохраняет ответ в localStorage и подхватывает его на следующем mount (без мигания)', async () => {
    // Первый mount — backend вернул `false`, сохранили в cache.
    mockApi.getConfig.mockResolvedValueOnce({
      featureFlags: { lessonsEnabled: false },
    });
    const { unmount } = render(
      <FeatureFlagsProvider disableRefresh>
        <FlagProbe flagKey="lessonsEnabled" />
      </FeatureFlagsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('flag-value').textContent).toBe('off'),
    );
    unmount();

    // Второй mount: запрос «висит» (Promise не резолвится). Стартовое
    // значение должно быть из cache — `false`, не дефолт `true`.
    mockApi.getConfig.mockReturnValueOnce(new Promise(() => {}));
    render(
      <FeatureFlagsProvider disableRefresh>
        <FlagProbe flagKey="lessonsEnabled" />
      </FeatureFlagsProvider>,
    );
    expect(screen.getByTestId('flag-value').textContent).toBe('off');
  });

  it('ошибка /config не валит приложение — остаются текущие флаги, error заполнен', async () => {
    mockApi.getConfig.mockRejectedValueOnce(new Error('network'));
    render(
      <FeatureFlagsProvider disableRefresh>
        <FlagProbe flagKey="lessonsEnabled" />
      </FeatureFlagsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('flag-loading').textContent).toBe('ready'),
    );
    // Дефолт остался (true), error выставлен.
    expect(screen.getByTestId('flag-value').textContent).toBe('on');
    expect(screen.getByTestId('flag-error').textContent).toMatch(/network/);
  });

  it('useFeatureFlag вне Provider → дефолт (safe fallback, без исключений)', () => {
    // Рендерим Probe БЕЗ Provider — это не должно падать.
    render(<FlagProbe flagKey="lessonsEnabled" />);
    expect(screen.getByTestId('flag-value').textContent).toBe(
      DEFAULT_FLAGS.lessonsEnabled ? 'on' : 'off',
    );
    expect(screen.getByTestId('flag-loading').textContent).toBe('ready');
  });

  it('refresh() триггерит повторный запрос /config с новым значением', async () => {
    mockApi.getConfig
      .mockResolvedValueOnce({ featureFlags: { lessonsEnabled: true } })
      .mockResolvedValueOnce({ featureFlags: { lessonsEnabled: false } });

    function Refresher() {
      const { refresh } = useFeatureFlags();
      return (
        <button data-testid="refresh-btn" onClick={() => void refresh()}>
          refresh
        </button>
      );
    }

    render(
      <FeatureFlagsProvider disableRefresh>
        <FlagProbe flagKey="lessonsEnabled" />
        <Refresher />
      </FeatureFlagsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('flag-value').textContent).toBe('on'),
    );

    await act(async () => {
      screen.getByTestId('refresh-btn').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('flag-value').textContent).toBe('off'),
    );
    expect(mockApi.getConfig).toHaveBeenCalledTimes(2);
  });
});
