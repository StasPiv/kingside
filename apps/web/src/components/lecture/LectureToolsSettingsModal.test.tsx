/**
 * KS-3912 / ADR-117 B02. Тесты `LectureToolsSettingsModal`.
 *
 * Покрытие:
 *  - модальное окно открывается с предзаполненными чекбоксами по
 *    `initialDisabledTools`;
 *  - `PATCH /lectures/:id` уходит с правильным массивом
 *    `disabledTools` (инверсия от снятых галочек) и `onSaved` зовётся
 *    с тем же массивом;
 *  - ошибка PATCH откатывает локальное состояние галочек к
 *    `initialDisabledTools`, окно остаётся открытым, текст ошибки
 *    показан.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { ApiError } from '../../ApiError';

const apiPatch = vi.fn();
vi.mock('../../api', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: (path: string, body: unknown) => apiPatch(path, body),
    delete: vi.fn(async () => ({})),
  },
}));

import { LectureToolsSettingsModal } from './LectureToolsSettingsModal';

const LECTURE_ID = 'lec-1';

beforeEach(() => {
  apiPatch.mockReset();
});

describe('<LectureToolsSettingsModal> KS-3912', () => {
  it('рендерится с предзаполненными чекбоксами по initialDisabledTools (галочка = разрешено)', () => {
    renderWithProviders(
      <LectureToolsSettingsModal
        lectureId={LECTURE_ID}
        initialDisabledTools={['engine', 'book']}
        onClose={vi.fn()}
      />,
    );
    // engine, book — снятые галочки (запрещены тренером).
    const engine = screen.getByTestId(
      'lecture-tools-settings-engine',
    ) as HTMLInputElement;
    const book = screen.getByTestId(
      'lecture-tools-settings-book',
    ) as HTMLInputElement;
    expect(engine.checked).toBe(false);
    expect(book.checked).toBe(false);
    // Остальные — стоят (разрешены).
    expect(
      (
        screen.getByTestId(
          'lecture-tools-settings-ai_comment',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByTestId(
          'lecture-tools-settings-analyze_game',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByTestId(
          'lecture-tools-settings-generate_puzzle',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByTestId(
          'lecture-tools-settings-find_by_position',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('PATCH /lectures/:id уходит с правильным массивом disabledTools, onSaved вызван', async () => {
    apiPatch.mockResolvedValue({});
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <LectureToolsSettingsModal
        lectureId={LECTURE_ID}
        initialDisabledTools={[]}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    // Снимаем галочки с движка и AI-комментария — они должны попасть
    // в `disabledTools`.
    await user.click(screen.getByTestId('lecture-tools-settings-engine'));
    await user.click(screen.getByTestId('lecture-tools-settings-ai_comment'));
    await user.click(screen.getByTestId('lecture-tools-settings-save'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1));
    const [path, body] = apiPatch.mock.calls[0] as [
      string,
      { disabledTools: string[] },
    ];
    expect(path).toBe(`/lectures/${LECTURE_ID}`);
    expect(new Set(body.disabledTools)).toEqual(
      new Set(['engine', 'ai_comment']),
    );
    expect(body.disabledTools).toHaveLength(2);

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(body.disabledTools),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ошибка PATCH откатывает локальное состояние галочек и показывает текст ошибки', async () => {
    apiPatch.mockRejectedValue(new ApiError('Bad request', undefined, 400));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <LectureToolsSettingsModal
        lectureId={LECTURE_ID}
        initialDisabledTools={['engine']}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    // Стартовое состояние: engine снят (запрещён), остальные стоят.
    const book = screen.getByTestId(
      'lecture-tools-settings-book',
    ) as HTMLInputElement;
    expect(book.checked).toBe(true);

    // Снимаем галочку с book — pending-состояние «теперь запрещаем
    // и базу партий тоже».
    await user.click(book);
    expect(book.checked).toBe(false);

    await user.click(screen.getByTestId('lecture-tools-settings-save'));

    // PATCH провалился → локальный state модалки откатывается к
    // initialDisabledTools: book снова стоит, engine снова снят.
    await waitFor(() => {
      const bookAfter = screen.getByTestId(
        'lecture-tools-settings-book',
      ) as HTMLInputElement;
      expect(bookAfter.checked).toBe(true);
    });
    const engineAfter = screen.getByTestId(
      'lecture-tools-settings-engine',
    ) as HTMLInputElement;
    expect(engineAfter.checked).toBe(false);

    // Окно осталось открытым, ошибка отрендерена; onClose/onSaved
    // не вызывались.
    expect(screen.getByTestId('lecture-tools-settings-error')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
