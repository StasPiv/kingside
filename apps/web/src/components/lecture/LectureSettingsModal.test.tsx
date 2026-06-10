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

    const checkbox = (await screen.findByTestId(
      'lecture-settings-hide-metrics-tab',
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // Выключаем флажок и сохраняем.
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByTestId('lecture-settings-save'));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const [url, body] = patchMock.mock.calls[0];
    expect(url).toBe('/lectures/lec-1');
    expect(body).toMatchObject({ hideMetricsTab: false });
  });

  it('default `false` отправляется в PATCH когда чекбокс не трогали', async () => {
    useLectureDetailMock.mockReturnValue({
      loading: false,
      lecture: makeLecture(),
      error: null,
      refetch: vi.fn(),
    });
    patchMock.mockResolvedValue(makeLecture());

    renderWithProviders(
      <LectureSettingsModal lectureId="lec-1" onClose={() => {}} initialTab="tools" />,
    );

    const checkbox = (await screen.findByTestId(
      'lecture-settings-hide-metrics-tab',
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByTestId('lecture-settings-save'));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    expect(patchMock.mock.calls[0][1]).toMatchObject({
      hideMetricsTab: false,
    });
  });
});
