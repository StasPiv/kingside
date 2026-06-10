/**
 * KS-4040. Тесты на флажок «Скрыть метрики у учеников».
 *
 * Заглушаем `useLectureDetail` и `api.patch`, чтобы не тащить REST и
 * не делать сложный setup со всем компонентом `LectureAccessPanel`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/test-utils';
import type { LectureDetail } from '@kingside/shared';

// ── моки ───────────────────────────────────────────────────────────────
const patchMock = vi.fn();
vi.mock('../../api', () => ({
  api: {
    patch: (...args: unknown[]) => patchMock(...args),
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

const useLectureDetailMock = vi.fn();
vi.mock('../../hooks/useLectureDetail', () => ({
  useLectureDetail: (id: string | null | undefined) =>
    useLectureDetailMock(id),
}));

// `LectureAccessPanel` тянет за собой много REST — заглушаем визуально.
vi.mock('./LectureAccessPanel', () => ({
  LectureAccessPanel: () => null,
}));

import { LectureSettingsModal } from './LectureSettingsModal';

function makeLecture(over: Partial<LectureDetail> = {}): LectureDetail {
  return {
    id: 'lec-1',
    title: 'Lecture title',
    description: null,
    visibility: 'public',
    status: 'scheduled',
    disabledTools: [],
    hideMetricsTab: false,
    ...over,
  } as unknown as LectureDetail;
}

describe('<LectureSettingsModal> KS-4040', () => {
  beforeEach(() => {
    patchMock.mockReset();
    useLectureDetailMock.mockReset();
  });

  it('флажок hideMetricsTab гидратируется из lecture и шлёт PATCH', async () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({ hideMetricsTab: true }),
      error: null,
      refetch: vi.fn(),
    });
    patchMock.mockResolvedValue(makeLecture({ hideMetricsTab: true }));

    renderWithProviders(
      <LectureSettingsModal lectureId="lec-1" onClose={() => {}} initialTab="tools" />,
    );

    // KS-4047: новая семантика — галочка «Метрики» стоит = блок виден.
    // У лекции `hideMetricsTab=true` → галочка НЕ стоит.
    const checkbox = (await screen.findByTestId(
      'lecture-settings-visibility-metrics',
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    // Включаем галочку → `hideMetricsTab=false` в PATCH.
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByTestId('lecture-settings-save'));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const [url, body] = patchMock.mock.calls[0];
    expect(url).toBe('/lectures/lec-1');
    expect(body).toMatchObject({ hideMetricsTab: false });
  });

  it('KS-4053: пользователь ничего не менял → PATCH не вызывается, модалка закрывается', async () => {
    const onClose = vi.fn();
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture(),
      error: null,
      refetch: vi.fn(),
    });

    renderWithProviders(
      <LectureSettingsModal
        lectureId="lec-1"
        onClose={onClose}
        initialTab="tools"
      />,
    );

    // Дождёмся гидратации.
    await screen.findByTestId('lecture-settings-visibility-metrics');

    fireEvent.click(screen.getByTestId('lecture-settings-save'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe('<LectureSettingsModal> KS-4053 diff-payload', () => {
  beforeEach(() => {
    patchMock.mockReset();
    useLectureDetailMock.mockReset();
  });

  it('recorded-лекция, переключение «ИИ» → PATCH содержит только disabledTools, без title/description', async () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({
        status: 'recorded',
        disabledTools: [],
        title: 'Original recorded title',
        description: 'Original description',
      }),
      error: null,
      refetch: vi.fn(),
    });
    patchMock.mockResolvedValue(makeLecture({ disabledTools: ['ai_comment'] }));

    renderWithProviders(
      <LectureSettingsModal
        lectureId="lec-1"
        onClose={() => {}}
        initialTab="tools"
      />,
    );

    // Снимаем галочку «ИИ» → disabledTools.includes('ai_comment').
    const ai = (await screen.findByTestId(
      'lecture-settings-visibility-ai',
    )) as HTMLInputElement;
    expect(ai.checked).toBe(true);
    fireEvent.click(ai);

    fireEvent.click(screen.getByTestId('lecture-settings-save'));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const [url, body] = patchMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe('/lectures/lec-1');
    expect(body).toEqual({ disabledTools: ['ai_comment'] });
    // Главное: ни title, ни description в PATCH не уехали.
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('description');
  });

  it('scheduled-лекция, изменение title → PATCH содержит ровно `title`', async () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture({
        status: 'scheduled',
        title: 'Old',
      }),
      error: null,
      refetch: vi.fn(),
    });
    patchMock.mockResolvedValue(makeLecture({ title: 'New' }));

    renderWithProviders(
      <LectureSettingsModal
        lectureId="lec-1"
        onClose={() => {}}
        initialTab="main"
      />,
    );

    const input = (await screen.findByTestId(
      'lecture-settings-title-input',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New' } });

    fireEvent.click(screen.getByTestId('lecture-settings-save'));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const [, body] = patchMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body).toEqual({ title: 'New' });
  });
});
