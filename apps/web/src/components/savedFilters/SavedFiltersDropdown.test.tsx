/**
 * KS-2924 / KS-2932 (Phase B2) — unit-тесты SavedFiltersDropdown.
 *
 * Тесты опираются на мок `api` (см. `vi.mock('../../api')`), чтобы
 * исключить useSavedFilters из набора деталей: важна сама верстка
 * dropdown'а, его обработчики и a11y-каркас (Esc/Tab/возврат фокуса).
 *
 * Покрытие (см. Acceptance KS-2932):
 *   - тогл: «Save filter» при N=0, «Saved filters (N) ▾» при N>0,
 *     aria-expanded синхронизирован;
 *   - открытие popover → авто-фокус на search; click-outside закрывает;
 *   - поиск фильтрует список;
 *   - apply: клик по строке вызывает onApply(params) и закрывает popover;
 *   - активный пресет отрисован галочкой;
 *   - save: 409 → inline-ошибка «duplicate_name»; 400 → toast про лимит;
 *     успех → форма закрывается;
 *   - kebab: открытие меню по ⋮, Rename / Update from current / Delete;
 *   - rename: 409 → inline-ошибка; успех закрывает форму;
 *   - delete: window.confirm = true → remove, false → no-op;
 *   - update from current: вызывает update с currentParams + success toast;
 *   - keyboard: Esc каскадно (rename → save → kebab → popover);
 *   - keyboard: Tab/Shift+Tab циклит фокус внутри popover'а;
 *   - закрытие → фокус возвращается на тогл.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  SavedFilterDto,
  SavedFilterParams,
} from '@kingside/shared';

import { ApiError } from '../../ApiError';
import { renderWithProviders, screen } from '../../test/test-utils';
import { SavedFiltersDropdown } from './SavedFiltersDropdown';

vi.mock('../../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../../api';

const mockedApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function workshopParams(
  overrides: Partial<Extract<SavedFilterParams, { section: 'workshop' }>> = {},
): SavedFilterParams {
  return {
    section: 'workshop',
    category: null,
    tags: [],
    search: null,
    sortOrder: null,
    ...overrides,
  };
}

function workshopDto(
  id: string,
  overrides: Partial<SavedFilterDto> = {},
): SavedFilterDto {
  return {
    id,
    section: 'workshop',
    name: `filter-${id}`,
    params: workshopParams(),
    createdAt: '2026-05-13T08:00:00.000Z',
    updatedAt: '2026-05-13T08:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

async function renderWithFilters(initial: SavedFilterDto[]) {
  mockedApi.get.mockResolvedValueOnce(initial);
  const onApply = vi.fn();
  const utils = renderWithProviders(
    <SavedFiltersDropdown<SavedFilterParams>
      section="workshop"
      currentParams={workshopParams({ search: 'current-snapshot' })}
      onApply={onApply}
    />,
  );
  // Ждём, пока useSavedFilters догрузит initial — тогл получит N.
  await waitFor(() =>
    expect(mockedApi.get).toHaveBeenCalledWith(
      '/user/saved-filters?section=workshop',
    ),
  );
  // Дожидаемся, что компонент перерендерился с filters (тогл с числом).
  if (initial.length > 0) {
    await waitFor(() =>
      expect(screen.getByTestId('saved-filters-toggle').textContent).toContain(
        String(initial.length),
      ),
    );
  } else {
    await waitFor(() =>
      expect(screen.getByTestId('saved-filters-toggle').textContent).toBe(
        'Save filter',
      ),
    );
  }
  return { ...utils, onApply };
}

describe('SavedFiltersDropdown — KS-2932', () => {
  describe('toggle label', () => {
    it('N=0 → «Save filter»', async () => {
      await renderWithFilters([]);
      expect(screen.getByTestId('saved-filters-toggle').textContent).toBe(
        'Save filter',
      );
    });

    it('N>0 → «Saved filters (N) ▾»', async () => {
      await renderWithFilters([workshopDto('a'), workshopDto('b')]);
      expect(
        screen.getByTestId('saved-filters-toggle').textContent,
      ).toContain('Saved filters (2)');
    });
  });

  describe('open / close', () => {
    it('click тогла открывает popover, search получает фокус', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'Italian' })]);
      const toggle = screen.getByTestId('saved-filters-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      await user.click(toggle);
      expect(screen.getByTestId('saved-filters-popover')).toBeInTheDocument();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId('saved-filters-search'),
        ),
      );
    });

    it('click вне popover закрывает его', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a')]);
      await user.click(screen.getByTestId('saved-filters-toggle'));
      expect(screen.getByTestId('saved-filters-popover')).toBeInTheDocument();
      // Симулируем mousedown по document.body (вне root).
      await act(async () => {
        document.body.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      await waitFor(() =>
        expect(
          screen.queryByTestId('saved-filters-popover'),
        ).not.toBeInTheDocument(),
      );
    });

    it('N=0: click тогла открывает popover И автоматически входит в save-mode', async () => {
      const user = userEvent.setup();
      await renderWithFilters([]);
      await user.click(screen.getByTestId('saved-filters-toggle'));
      expect(
        screen.getByTestId('saved-filters-save-form'),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId('saved-filters-save-input'),
        ),
      );
    });
  });

  describe('search + apply', () => {
    it('фильтрует список по name (case-insensitive)', async () => {
      const user = userEvent.setup();
      await renderWithFilters([
        workshopDto('a', { name: 'Italian' }),
        workshopDto('b', { name: 'Spanish' }),
        workshopDto('c', { name: 'King’s Indian' }),
      ]);
      await user.click(screen.getByTestId('saved-filters-toggle'));
      const search = screen.getByTestId('saved-filters-search');
      await user.type(search, 'span');
      expect(screen.getByTestId('saved-filters-apply-b')).toBeInTheDocument();
      expect(
        screen.queryByTestId('saved-filters-apply-a'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('saved-filters-apply-c'),
      ).not.toBeInTheDocument();
    });

    it('apply: клик по строке вызывает onApply(params, presetId) и закрывает popover', async () => {
      const user = userEvent.setup();
      const dto = workshopDto('a', {
        name: 'Italian',
        params: workshopParams({ category: 'opening', search: 'e4' }),
      });
      const { onApply } = await renderWithFilters([dto]);
      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-apply-a'));
      expect(onApply).toHaveBeenCalledTimes(1);
      // KS-2942: вторым аргументом передаётся id пресета — родитель
      // использует его для записи `?savedFilter=<id>` в URL.
      expect(onApply).toHaveBeenCalledWith(dto.params, 'a');
      await waitFor(() =>
        expect(
          screen.queryByTestId('saved-filters-popover'),
        ).not.toBeInTheDocument(),
      );
    });

    it('KS-2942 modified: точка-индикатор на тогле + ● на строке + kebab пункт «Reset to saved»', async () => {
      const user = userEvent.setup();
      const dto = workshopDto('m-1', { name: 'Was-applied' });
      mockedApi.get.mockResolvedValueOnce([dto]);
      const onApply = vi.fn();
      renderWithProviders(
        <SavedFiltersDropdown<SavedFilterParams>
          section="workshop"
          currentParams={workshopParams({ search: 'edited' })}
          onApply={onApply}
          activeFilter={{ id: 'm-1', state: 'modified' }}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('saved-filters-toggle').textContent,
        ).toContain('Saved filters (1)'),
      );
      // На тогле появилась точка-индикатор.
      expect(
        screen.getByTestId('saved-filters-toggle-modified'),
      ).toBeInTheDocument();
      // data-active-state=modified на root.
      expect(
        screen.getByTestId('saved-filters-dropdown').getAttribute(
          'data-active-state',
        ),
      ).toBe('modified');

      await user.click(screen.getByTestId('saved-filters-toggle'));
      // На строке — ● вместо ✓.
      const row = screen.getByTestId('saved-filters-item-m-1');
      expect(row.className).toContain('saved-filters-dropdown__item--modified');
      expect(row.getAttribute('data-item-state')).toBe('modified');
      expect(
        row.querySelector('.saved-filters-dropdown__item-check'),
      ).toBeNull();
      expect(
        screen.getByTestId('saved-filters-item-modified-m-1'),
      ).toBeInTheDocument();

      // Kebab → есть пункт «Reset to saved».
      await user.click(screen.getByTestId('saved-filters-kebab-m-1'));
      const resetBtn = screen.getByTestId('saved-filters-kebab-reset-m-1');
      expect(resetBtn).toHaveTextContent('Reset to saved');

      // Клик по Reset to saved → onApply(params пресета, id пресета).
      await user.click(resetBtn);
      expect(onApply).toHaveBeenCalledWith(dto.params, 'm-1');
    });

    it('KS-2942: kebab «Reset to saved» НЕ показывается при state=active', async () => {
      const user = userEvent.setup();
      const dto = workshopDto('a-1', { name: 'Currently applied' });
      mockedApi.get.mockResolvedValueOnce([dto]);
      renderWithProviders(
        <SavedFiltersDropdown<SavedFilterParams>
          section="workshop"
          currentParams={workshopParams()}
          onApply={vi.fn()}
          activeFilter={{ id: 'a-1', state: 'active' }}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('saved-filters-toggle').textContent,
        ).toContain('Saved filters (1)'),
      );
      // Точки-индикатора нет.
      expect(
        screen.queryByTestId('saved-filters-toggle-modified'),
      ).not.toBeInTheDocument();
      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-kebab-a-1'));
      expect(
        screen.queryByTestId('saved-filters-kebab-reset-a-1'),
      ).not.toBeInTheDocument();
    });

    it('активный пресет рендерится с чекмарком (activeFilter state=active)', async () => {
      const user = userEvent.setup();
      const dto = workshopDto('active-1', { name: 'Pinned' });
      mockedApi.get.mockResolvedValueOnce([dto]);
      renderWithProviders(
        <SavedFiltersDropdown<SavedFilterParams>
          section="workshop"
          currentParams={workshopParams()}
          onApply={vi.fn()}
          activeFilter={{ id: 'active-1', state: 'active' }}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('saved-filters-toggle').textContent,
        ).toContain('Saved filters (1)'),
      );
      await user.click(screen.getByTestId('saved-filters-toggle'));
      const row = screen.getByTestId('saved-filters-item-active-1');
      expect(
        row.querySelector('.saved-filters-dropdown__item-check'),
      ).not.toBeNull();
      expect(row.className).toContain('saved-filters-dropdown__item--active');
      expect(row.getAttribute('data-item-state')).toBe('active');
    });
  });

  describe('save current', () => {
    it('успех: POST вызван с currentParams, форма закрылась', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a')]);
      mockedApi.post.mockResolvedValueOnce(
        workshopDto('new', { name: 'My filter' }),
      );

      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-save-btn'));
      const input = screen.getByTestId('saved-filters-save-input');
      await user.type(input, 'My filter');
      await user.click(screen.getByTestId('saved-filters-save-confirm'));

      await waitFor(() =>
        expect(mockedApi.post).toHaveBeenCalledWith(
          '/user/saved-filters',
          expect.objectContaining({
            section: 'workshop',
            name: 'My filter',
            params: workshopParams({ search: 'current-snapshot' }),
          }),
        ),
      );
      await waitFor(() =>
        expect(
          screen.queryByTestId('saved-filters-save-form'),
        ).not.toBeInTheDocument(),
      );
      // KS-2935 §3: новый пресет виден в списке dropdown (real id заменил
      // optimistic). Тогл показывает увеличенный счётчик (1 → 2).
      await waitFor(() =>
        expect(
          screen.getByTestId('saved-filters-item-new'),
        ).toBeInTheDocument(),
      );
      expect(screen.getByTestId('saved-filters-toggle').textContent).toContain(
        '(2)',
      );
    });

    it('409 → inline-подсказка «Name already in use», форма остаётся открытой', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a')]);
      mockedApi.post.mockRejectedValueOnce(
        new ApiError('Имя уже используется', undefined, 409),
      );

      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-save-btn'));
      await user.type(
        screen.getByTestId('saved-filters-save-input'),
        'Dup name',
      );
      await user.click(screen.getByTestId('saved-filters-save-confirm'));

      await waitFor(() =>
        expect(
          screen.getByTestId('saved-filters-save-error'),
        ).toHaveTextContent('Name is already in use'),
      );
      expect(
        screen.getByTestId('saved-filters-save-form'),
      ).toBeInTheDocument();
      // KS-2935 §4: повторного POST'а быть не должно, пока пользователь не
      // починит имя и не нажмёт Save снова — текущий API-вызов был ровно один.
      expect(mockedApi.post).toHaveBeenCalledTimes(1);
    });

    it('400 → toast про лимит', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a')]);
      mockedApi.post.mockRejectedValueOnce(
        new ApiError('limit', undefined, 400),
      );

      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-save-btn'));
      await user.type(
        screen.getByTestId('saved-filters-save-input'),
        'Twenty-first',
      );
      await user.click(screen.getByTestId('saved-filters-save-confirm'));

      const toast = await screen.findByTestId('saved-filters-toast');
      expect(toast).toHaveAttribute('data-tone', 'error');
      expect(toast.textContent).toContain('20');
    });
  });

  describe('kebab menu', () => {
    it('⋮ открывает меню с Rename / Update / Delete', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'Italian' })]);
      await user.click(screen.getByTestId('saved-filters-toggle'));
      const kebab = screen.getByTestId('saved-filters-kebab-a');
      expect(kebab.getAttribute('aria-expanded')).toBe('false');
      await user.click(kebab);
      expect(
        screen.getByTestId('saved-filters-kebab-menu-a'),
      ).toBeInTheDocument();
      expect(kebab.getAttribute('aria-expanded')).toBe('true');
      expect(
        screen.getByTestId('saved-filters-kebab-rename-a'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('saved-filters-kebab-update-a'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('saved-filters-kebab-delete-a'),
      ).toBeInTheDocument();
    });

    it('Rename: успех закрывает форму', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'Old' })]);
      mockedApi.patch.mockResolvedValueOnce(
        workshopDto('a', { name: 'New' }),
      );
      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-kebab-a'));
      await user.click(screen.getByTestId('saved-filters-kebab-rename-a'));
      const input = screen.getByTestId('saved-filters-rename-input-a');
      expect(document.activeElement).toBe(input);
      // Стираем preset и вводим новое имя.
      await user.clear(input);
      await user.type(input, 'New');
      await user.click(screen.getByTestId('saved-filters-rename-confirm-a'));
      await waitFor(() =>
        expect(mockedApi.patch).toHaveBeenCalledWith(
          '/user/saved-filters/a',
          { name: 'New' },
        ),
      );
      await waitFor(() =>
        expect(
          screen.queryByTestId('saved-filters-rename-form-a'),
        ).not.toBeInTheDocument(),
      );
      // KS-2935 §5: имя обновилось в DOM-списке.
      expect(
        screen.getByTestId('saved-filters-item-a'),
      ).toHaveTextContent('New');
    });

    it('Rename 409 → inline-ошибка, форма открыта', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'Old' })]);
      mockedApi.patch.mockRejectedValueOnce(
        new ApiError('dup', undefined, 409),
      );
      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-kebab-a'));
      await user.click(screen.getByTestId('saved-filters-kebab-rename-a'));
      const input = screen.getByTestId('saved-filters-rename-input-a');
      await user.clear(input);
      await user.type(input, 'Conflict');
      await user.click(screen.getByTestId('saved-filters-rename-confirm-a'));
      const err = await screen.findByTestId('saved-filters-rename-error-a');
      expect(err.textContent).toBe('Name is already in use');
      expect(
        screen.getByTestId('saved-filters-rename-form-a'),
      ).toBeInTheDocument();
    });

    it('Update from current → PATCH params, success toast, имя пресета не меняется', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'Original-A' })]);
      mockedApi.patch.mockResolvedValueOnce(
        workshopDto('a', {
          name: 'Original-A',
          params: workshopParams({ search: 'current-snapshot' }),
        }),
      );
      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-kebab-a'));
      await user.click(screen.getByTestId('saved-filters-kebab-update-a'));
      await waitFor(() =>
        expect(mockedApi.patch).toHaveBeenCalledWith(
          '/user/saved-filters/a',
          {
            params: workshopParams({ search: 'current-snapshot' }),
          },
        ),
      );
      const toast = await screen.findByTestId('saved-filters-toast');
      expect(toast).toHaveAttribute('data-tone', 'success');
      // KS-2935 §7: имя не меняется при update-from-current.
      expect(
        screen.getByTestId('saved-filters-item-a'),
      ).toHaveTextContent('Original-A');
    });

    it('Delete: confirm=true → DELETE; confirm=false → no-op', async () => {
      const user = userEvent.setup();
      await renderWithFilters([
        workshopDto('keep'),
        workshopDto('drop'),
      ]);
      mockedApi.delete.mockResolvedValueOnce({ deleted: true });
      // happy-dom не реализует window.confirm — стабим явно (vi.spyOn
      // отказывается шпионить за undefined).
      const confirmFn = vi.fn().mockReturnValueOnce(true);
      const originalConfirm = (window as unknown as { confirm?: unknown })
        .confirm;
      Object.defineProperty(window, 'confirm', {
        value: confirmFn,
        configurable: true,
        writable: true,
      });

      try {
        await user.click(screen.getByTestId('saved-filters-toggle'));
        await user.click(screen.getByTestId('saved-filters-kebab-drop'));
        await user.click(
          screen.getByTestId('saved-filters-kebab-delete-drop'),
        );
        expect(confirmFn).toHaveBeenCalledTimes(1);
        await waitFor(() =>
          expect(mockedApi.delete).toHaveBeenCalledWith(
            '/user/saved-filters/drop',
          ),
        );
        // KS-2935 §6: пресет исчез из списка, в тогле счётчик уменьшен.
        await waitFor(() =>
          expect(
            screen.queryByTestId('saved-filters-item-drop'),
          ).not.toBeInTheDocument(),
        );
        expect(
          screen.getByTestId('saved-filters-toggle').textContent,
        ).toContain('(1)');

        // Второй вызов — confirm=false: запроса быть не должно.
        confirmFn.mockReturnValueOnce(false);
        mockedApi.delete.mockClear();
        await user.click(screen.getByTestId('saved-filters-kebab-keep'));
        await user.click(
          screen.getByTestId('saved-filters-kebab-delete-keep'),
        );
        expect(mockedApi.delete).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(window, 'confirm', {
          value: originalConfirm,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  describe('error and load states (KS-2935 branch coverage)', () => {
    it('load error → отображается load-error-блок', async () => {
      mockedApi.get.mockRejectedValueOnce(
        new ApiError('boom', 'NETWORK_ERROR', 0),
      );
      const user = userEvent.setup();
      renderWithProviders(
        <SavedFiltersDropdown<SavedFilterParams>
          section="workshop"
          currentParams={workshopParams()}
          onApply={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('saved-filters-toggle'),
        ).toBeInTheDocument(),
      );
      // Открываем popover — внутри блок ошибки.
      await user.click(screen.getByTestId('saved-filters-toggle'));
      expect(
        screen.getByTestId('saved-filters-load-error'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('saved-filters-load-error'),
      ).toHaveTextContent('Failed to load filters');
    });

    it('rename generic error (500) → toast про rename, форма остаётся открытой', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'Old' })]);
      mockedApi.patch.mockRejectedValueOnce(
        new ApiError('boom', undefined, 500),
      );
      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-kebab-a'));
      await user.click(screen.getByTestId('saved-filters-kebab-rename-a'));
      const input = screen.getByTestId('saved-filters-rename-input-a');
      await user.clear(input);
      await user.type(input, 'New');
      await user.click(screen.getByTestId('saved-filters-rename-confirm-a'));
      const toast = await screen.findByTestId('saved-filters-toast');
      expect(toast).toHaveAttribute('data-tone', 'error');
      expect(toast.textContent).toContain('Failed to rename');
      // Форма остаётся (это не 409, inline-error не показывается, но и
      // форма пользователя не закрыта).
      expect(
        screen.getByTestId('saved-filters-rename-form-a'),
      ).toBeInTheDocument();
    });

    it('update generic error → toast про update', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a')]);
      mockedApi.patch.mockRejectedValueOnce(
        new ApiError('boom', undefined, 500),
      );
      await user.click(screen.getByTestId('saved-filters-toggle'));
      await user.click(screen.getByTestId('saved-filters-kebab-a'));
      await user.click(screen.getByTestId('saved-filters-kebab-update-a'));
      const toast = await screen.findByTestId('saved-filters-toast');
      expect(toast).toHaveAttribute('data-tone', 'error');
      expect(toast.textContent).toContain('Failed to update');
    });

    it('delete generic error → toast про delete + пресет восстанавливается в списке (rollback из хука)', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'A' })]);
      mockedApi.delete.mockRejectedValueOnce(
        new ApiError('boom', undefined, 500),
      );
      const confirmFn = vi.fn().mockReturnValueOnce(true);
      const original = (window as unknown as { confirm?: unknown }).confirm;
      Object.defineProperty(window, 'confirm', {
        value: confirmFn,
        configurable: true,
        writable: true,
      });
      try {
        await user.click(screen.getByTestId('saved-filters-toggle'));
        await user.click(screen.getByTestId('saved-filters-kebab-a'));
        await user.click(screen.getByTestId('saved-filters-kebab-delete-a'));
        const toast = await screen.findByTestId('saved-filters-toast');
        expect(toast).toHaveAttribute('data-tone', 'error');
        expect(toast.textContent).toContain('Failed to delete');
        // Запись восстановлена useSavedFilters'ом при ошибке.
        expect(
          screen.getByTestId('saved-filters-item-a'),
        ).toBeInTheDocument();
      } finally {
        Object.defineProperty(window, 'confirm', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  describe('keyboard / a11y', () => {
    it('Esc каскад: rename → save → kebab → popover', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a')]);
      const toggle = screen.getByTestId('saved-filters-toggle');
      await user.click(toggle);

      // 1) Откроем kebab → Esc закрывает только его.
      await user.click(screen.getByTestId('saved-filters-kebab-a'));
      expect(
        screen.getByTestId('saved-filters-kebab-menu-a'),
      ).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(
        screen.queryByTestId('saved-filters-kebab-menu-a'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId('saved-filters-popover'),
      ).toBeInTheDocument();

      // 2) Откроем save-form → Esc закрывает только её.
      await user.click(screen.getByTestId('saved-filters-save-btn'));
      expect(
        screen.getByTestId('saved-filters-save-form'),
      ).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(
        screen.queryByTestId('saved-filters-save-form'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId('saved-filters-popover'),
      ).toBeInTheDocument();

      // 3) Откроем rename → Esc закрывает только её.
      await user.click(screen.getByTestId('saved-filters-kebab-a'));
      await user.click(screen.getByTestId('saved-filters-kebab-rename-a'));
      expect(
        screen.getByTestId('saved-filters-rename-form-a'),
      ).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(
        screen.queryByTestId('saved-filters-rename-form-a'),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId('saved-filters-popover'),
      ).toBeInTheDocument();

      // 4) Последний Esc → закрывает popover, фокус возвращается на тогл.
      await user.keyboard('{Escape}');
      await waitFor(() =>
        expect(
          screen.queryByTestId('saved-filters-popover'),
        ).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(document.activeElement).toBe(toggle));
    });

    it('Tab циклит фокус внутри popover (focus-trap)', async () => {
      const user = userEvent.setup();
      await renderWithFilters([workshopDto('a', { name: 'Italian' })]);
      const toggle = screen.getByTestId('saved-filters-toggle');
      await user.click(toggle);
      const popover = screen.getByTestId('saved-filters-popover');

      // Изначально фокус на search.
      expect(document.activeElement).toBe(
        screen.getByTestId('saved-filters-search'),
      );

      // Считаем фокусируемые в popover'е и Tab'ом доходим до последнего.
      const focusables = popover.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      );
      expect(focusables.length).toBeGreaterThan(1);
      const last = focusables[focusables.length - 1];
      // Жмём Tab N-1 раз — должны оказаться на последнем фокусируемом.
      for (let i = 0; i < focusables.length - 1; i++) {
        await user.tab();
      }
      expect(document.activeElement).toBe(last);
      // Ещё один Tab — должен циклически перейти на первый (focus-trap).
      await user.tab();
      expect(document.activeElement).toBe(focusables[0]);
      // Shift+Tab с первого — на последний.
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(last);
    });
  });
});
