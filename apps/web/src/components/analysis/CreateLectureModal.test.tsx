/**
 * KS-3911 / ADR-117 B01. Тесты секции «Доступ учеников к инструментам»
 * в `CreateLectureModal`:
 *  - дефолт — все галочки стоят, в POST уходит пустой `disabledTools`;
 *  - снятие двух галочек — массив из двух соответствующих значений
 *    `LectureDisabledTool`, остальные остаются разрешены.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { ALL_LECTURE_DISABLED_TOOLS } from '@kingside/shared';

const apiPost = vi.fn();
vi.mock('../../api', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: (path: string, body: unknown) => apiPost(path, body),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

import { CreateLectureModal } from './CreateLectureModal';

const ANALYSIS_ID = 'analysis-123';

function defaultResponse() {
  return {
    lecture: { id: 'lec-1', title: 'Test lecture' },
    liveAnalysis: { id: 'live-1', slug: 'slug-1', url: '/live/slug-1' },
  };
}

beforeEach(() => {
  apiPost.mockReset();
  apiPost.mockResolvedValue(defaultResponse());
});

describe('<CreateLectureModal> KS-3911', () => {
  it('по умолчанию все чекбоксы инструментов отмечены', () => {
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    for (const tool of ALL_LECTURE_DISABLED_TOOLS) {
      const cb = screen.getByTestId(
        `create-lecture-tool-${tool}`,
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    }
  });

  it('submit без снятых галочек → disabledTools: []', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Caro-Kann basics"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    // Заголовок уже подставлен через defaultTitle, можно сразу сабмитить.
    await user.click(screen.getByRole('button', { name: /Start lecture/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [path, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/lectures');
    expect(body.analysisId).toBe(ANALYSIS_ID);
    expect(body.title).toBe('Caro-Kann basics');
    expect(body.disabledTools).toEqual([]);
  });

  it('снятие двух галочек → disabledTools содержит ровно эти два значения', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    // Снимаем галочки с движка и AI-комментария — ученикам они должны
    // прийти в `disabledTools` как запрет.
    await user.click(screen.getByTestId('create-lecture-tool-engine'));
    await user.click(screen.getByTestId('create-lecture-tool-ai_comment'));

    await user.click(screen.getByRole('button', { name: /Start lecture/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    const disabled = body.disabledTools as string[];

    // Сравнение через множества — порядок в массиве не специфицирован
    // контрактом (`ALL_LECTURE_DISABLED_TOOLS.filter` сохраняет порядок
    // whitelist'а, но тест не должен зависеть от внутренней реализации).
    expect(new Set(disabled)).toEqual(new Set(['engine', 'ai_comment']));
    expect(disabled).toHaveLength(2);
  });

  it('повторный клик по чекбоксу возвращает инструмент в разрешённые', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreateLectureModal
        analysisId={ANALYSIS_ID}
        defaultTitle="Lecture"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('create-lecture-tool-book'));
    await user.click(screen.getByTestId('create-lecture-tool-book'));

    await user.click(screen.getByRole('button', { name: /Start lecture/i }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [, body] = apiPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.disabledTools).toEqual([]);
  });
});
