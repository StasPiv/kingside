import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import {
  SaveToStudyDialog,
  SaveToStudyTrigger,
  type SaveToStudySource,
} from './SaveToStudyDialog';

/**
 * KS-2891 / ADR-060 §3.6 (FC6). Юнит-тесты SaveToStudyDialog.
 *
 * Покрытие:
 *  • Trigger не рендерит кнопку для null-source (review-режим);
 *  • new study: name → submit → POST createFromAnalysis с newStudyName +
 *    success-state c CTA «Open chapter»;
 *  • existing study: list загружается, выбор → submit с studyId;
 *  • валидация: пустое имя при new → error без вызова API;
 *  • analysis-source шлёт `analysisId`, pgn-source шлёт `pgn`+`fen`;
 *  • Open chapter навигирует на `/studies/<slug>/<chapterId>`.
 */

const listMock = vi.fn();
const createFromAnalysisMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('../../api/studiesApi', () => ({
  studiesApi: {
    list: (opts: unknown) => listMock(opts),
    createFromAnalysis: (req: unknown) => createFromAnalysisMock(req),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const ANALYSIS_SOURCE: SaveToStudySource = {
  kind: 'analysis',
  analysisId: 'a-uuid-1',
};
const PGN_SOURCE: SaveToStudySource = {
  kind: 'pgn',
  pgn: '1. e4 e5',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
};

const SAMPLE_STUDIES = [
  {
    id: 'study-a',
    ownerId: 'u1',
    slug: 'alpha',
    name: 'Alpha',
    description: null,
    isPublic: true,
    visibility: 'public',
    topics: [],
    likes: 0,
    fromKind: 'scratch',
    fromRefId: null,
    chaptersCount: 1,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'study-b',
    ownerId: 'u1',
    slug: 'beta',
    name: 'Beta',
    description: null,
    isPublic: false,
    visibility: 'private',
    topics: [],
    likes: 0,
    fromKind: 'scratch',
    fromRefId: null,
    chaptersCount: 2,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  listMock.mockReset();
  createFromAnalysisMock.mockReset();
  navigateMock.mockReset();
  listMock.mockResolvedValue({ data: SAMPLE_STUDIES });
  // KS-2898: backend B9 отдаёт плоский ответ — `{studyId, slug, chapterId}`.
  createFromAnalysisMock.mockResolvedValue({
    studyId: SAMPLE_STUDIES[0].id,
    slug: SAMPLE_STUDIES[0].slug,
    chapterId: 'chap-1',
  });
});

describe('SaveToStudyTrigger (KS-2891 FC6)', () => {
  it('source=null → кнопка не рендерится (review)', () => {
    renderWithProviders(<SaveToStudyTrigger source={null} />);
    expect(screen.queryByTestId('save-to-study-trigger')).toBeNull();
  });

  it('source присутствует → кнопка видна; клик открывает диалог', () => {
    renderWithProviders(<SaveToStudyTrigger source={ANALYSIS_SOURCE} />);
    const btn = screen.getByTestId('save-to-study-trigger');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.getByTestId('save-to-study-dialog')).toBeInTheDocument();
  });
});

describe('SaveToStudyDialog (KS-2891 FC6)', () => {
  it('new study: name + submit → API получает newStudyName + analysisId', async () => {
    renderWithProviders(
      <SaveToStudyDialog source={ANALYSIS_SOURCE} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('save-to-study-new-name'), {
      target: { value: 'My new study' },
    });
    fireEvent.click(screen.getByTestId('save-to-study-submit'));
    await waitFor(() =>
      expect(createFromAnalysisMock).toHaveBeenCalledTimes(1),
    );
    expect(createFromAnalysisMock).toHaveBeenCalledWith(
      expect.objectContaining({
        newStudyName: 'My new study',
        analysisId: 'a-uuid-1',
      }),
    );
    expect(createFromAnalysisMock.mock.calls[0][0].studyId).toBeUndefined();
    // Успех → success-state с CTA «Open chapter».
    await waitFor(() =>
      expect(screen.getByTestId('save-to-study-success')).toBeInTheDocument(),
    );
  });

  it('new study: пустое имя → error, API НЕ вызывается', () => {
    renderWithProviders(
      <SaveToStudyDialog source={ANALYSIS_SOURCE} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('save-to-study-submit'));
    expect(screen.getByTestId('save-to-study-error').textContent).toMatch(
      /Study name is required/i,
    );
    expect(createFromAnalysisMock).not.toHaveBeenCalled();
  });

  it('existing study: переключение → list загружается → submit с studyId', async () => {
    renderWithProviders(
      <SaveToStudyDialog source={ANALYSIS_SOURCE} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('save-to-study-mode-existing'));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ mine: true }));
    const select = (await screen.findByTestId(
      'save-to-study-select',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'study-b' } });
    fireEvent.click(screen.getByTestId('save-to-study-submit'));
    await waitFor(() =>
      expect(createFromAnalysisMock).toHaveBeenCalledTimes(1),
    );
    expect(createFromAnalysisMock).toHaveBeenCalledWith(
      expect.objectContaining({ studyId: 'study-b' }),
    );
    expect(createFromAnalysisMock.mock.calls[0][0].newStudyName).toBeUndefined();
  });

  it('pgn-source: API получает pgn+fen, без analysisId', async () => {
    renderWithProviders(
      <SaveToStudyDialog source={PGN_SOURCE} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('save-to-study-new-name'), {
      target: { value: 'From puzzle' },
    });
    fireEvent.click(screen.getByTestId('save-to-study-submit'));
    await waitFor(() =>
      expect(createFromAnalysisMock).toHaveBeenCalledTimes(1),
    );
    const payload = createFromAnalysisMock.mock.calls[0][0];
    expect(payload.pgn).toBe('1. e4 e5');
    expect(payload.fen).toBe(PGN_SOURCE.kind === 'pgn' ? PGN_SOURCE.fen : '');
    expect(payload.analysisId).toBeUndefined();
  });

  it('Open chapter → navigate(`/studies/<slug>/<chapterId>`)', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <SaveToStudyDialog source={ANALYSIS_SOURCE} onClose={onClose} />,
    );
    fireEvent.change(screen.getByTestId('save-to-study-new-name'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByTestId('save-to-study-submit'));
    const openBtn = await screen.findByTestId('save-to-study-open-chapter');
    fireEvent.click(openBtn);
    expect(navigateMock).toHaveBeenCalledWith('/studies/alpha/chap-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('chapterName проставляется в payload, если введён', async () => {
    renderWithProviders(
      <SaveToStudyDialog
        source={ANALYSIS_SOURCE}
        defaultChapterName="Default name"
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('save-to-study-new-name'), {
      target: { value: 's' },
    });
    fireEvent.change(screen.getByTestId('save-to-study-chapter-name'), {
      target: { value: 'Custom chapter' },
    });
    fireEvent.click(screen.getByTestId('save-to-study-submit'));
    await waitFor(() =>
      expect(createFromAnalysisMock).toHaveBeenCalledTimes(1),
    );
    expect(createFromAnalysisMock.mock.calls[0][0].chapterName).toBe(
      'Custom chapter',
    );
  });

  it('error API → показывает error, success НЕ появляется', async () => {
    createFromAnalysisMock.mockRejectedValueOnce(new Error('Server boom'));
    renderWithProviders(
      <SaveToStudyDialog source={ANALYSIS_SOURCE} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId('save-to-study-new-name'), {
      target: { value: 's' },
    });
    fireEvent.click(screen.getByTestId('save-to-study-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('save-to-study-error').textContent).toMatch(
        /Server boom/,
      ),
    );
    expect(screen.queryByTestId('save-to-study-success')).toBeNull();
  });
});
