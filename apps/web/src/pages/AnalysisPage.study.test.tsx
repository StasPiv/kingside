import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-2877 (ADR-060 T1) — тесты AnalysisPage в study-контексте
 * (`ctx.kind='study'`, `studyMode='editor'|'public-readonly'`).
 *
 * Существующие AnalysisPage.test.tsx / .navigation / .suggestedArrow
 * покрывают review/analysis/puzzle сценарии (61/63 — 2 pre-existing
 * Copy PGN). Этот файл добавляет study-specific сценарии после
 * FR1..FR4 + FS1/FS2 + FM1.
 */

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'tester' },
    loading: false,
    token: 'tok',
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('../hooks/useStockfish', () => ({
  useStockfish: () => ({
    state: 'ready',
    lines: [],
    bestMove: null,
    evaluate: vi.fn(),
    stop: vi.fn(),
    init: vi.fn(),
    isReady: true,
  }),
}));

vi.mock('../hooks/useEngine', () => ({
  useEngine: () => ({
    state: 'ready',
    lines: [],
    analysisFen: null,
    bestMove: null,
    evaluate: vi.fn(),
    stop: vi.fn(),
    setOption: vi.fn(),
    init: vi.fn(),
    cleanup: vi.fn(),
    isReady: true,
    engineName: 'Stockfish',
    engineSource: 'wasm' as const,
    errorMessage: null,
  }),
  loadEngineConfigs: () => [],
  saveEngineConfigs: vi.fn(),
}));

vi.mock('../hooks/useEngineConfig', () => {
  const config = {
    engineSource: 'wasm' as const,
    setEngineSource: vi.fn(),
    externalConfig: null,
    setExternalConfig: vi.fn(),
    savedConfigs: [],
    showEngineSettings: false,
    setShowEngineSettings: vi.fn(),
    extUrlInput: '',
    setExtUrlInput: vi.fn(),
    extKeyInput: '',
    setExtKeyInput: vi.fn(),
    extNameInput: '',
    setExtNameInput: vi.fn(),
    uciThreads: '1',
    setUciThreads: vi.fn(),
    uciHash: '256',
    setUciHash: vi.fn(),
    multiPv: 3,
    setMultiPv: vi.fn(),
    showEngineModal: false,
    setShowEngineModal: vi.fn(),
    handleConnectExternal: vi.fn(),
    handleDeleteConfig: vi.fn(),
    handleSelectSavedConfig: vi.fn(),
    handleSwitchToWasm: vi.fn(),
  };
  return { useEngineConfig: () => config };
});

vi.mock('../hooks/useContainerSize', () => ({
  useContainerSize: () => ({ width: 400, height: 400 }),
}));

vi.mock('../hooks/useSavedAnalyses', () => {
  const api = {
    create: vi.fn().mockResolvedValue({ id: 'saved-1' }),
    update: vi.fn().mockResolvedValue({ id: 'saved-1' }),
    getById: vi.fn().mockResolvedValue(null),
    getPublicById: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return {
    useSavedAnalyses: () => api,
    getDefaultTitle: () => 'Untitled Analysis',
    parsePgnHeaders: () => ({}),
  };
});

vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options?: { position?: string } }) => (
    <div
      data-testid="chessboard"
      data-position={options?.position ?? ''}
    />
  ),
}));

vi.mock('../api', () => ({
  api: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

const getBySlugMock = vi.fn();
const getChapterMock = vi.fn();
const getPublicChapterMock = vi.fn();
const updateChapterMock = vi.fn();

vi.mock('../api/studiesApi', () => ({
  studiesApi: {
    getBySlug: (slug: string) => getBySlugMock(slug),
    getChapter: (slug: string, chId: string) => getChapterMock(slug, chId),
    getPublicChapter: (chId: string) => getPublicChapterMock(chId),
    updateChapter: (slug: string, chId: string, req: unknown) =>
      updateChapterMock(slug, chId, req),
  },
}));

// Mock useStudyChapterPersistence — мы не тестируем сам auto-save,
// только что AnalysisPage загружает данные.
vi.mock('../hooks/useStudyChapterPersistence', () => ({
  useStudyChapterPersistence: vi.fn(),
}));

let routeParams: Record<string, string | undefined> = {};
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => routeParams,
  };
});

import { AnalysisPage } from './AnalysisPage';

const STUDY = {
  id: 's1',
  ownerId: 'u1',
  slug: 'demo',
  name: 'Demo study',
  description: null,
  isPublic: false,
  visibility: 'private',
  topics: [],
  likes: 0,
  chaptersCount: 1,
  createdAt: '2026-05-12T10:00:00.000Z',
  updatedAt: '2026-05-12T10:00:00.000Z',
  // KS-3014/KS-3015: editor-route рендерится только для write-юзеров;
  // тесты на editor-режим mock'ают owner-роль.
  viewerRole: 'owner' as const,
};

const CHAPTER = {
  id: 'ch1',
  studyId: 's1',
  name: 'Chapter 1',
  orderIdx: 1,
  pgn: '1. e4 e5',
  startFen: null,
  orientation: 'white' as const,
  mode: 'analysis',
  concealPly: null,
  gamebook: null,
  createdAt: '2026-05-12T10:00:00.000Z',
  updatedAt: '2026-05-12T10:00:00.000Z',
};

beforeEach(() => {
  getBySlugMock.mockReset();
  getChapterMock.mockReset();
  getPublicChapterMock.mockReset();
  updateChapterMock.mockReset();
  routeParams = {};
  getBySlugMock.mockResolvedValue({ study: STUDY, chapters: [] });
  getChapterMock.mockResolvedValue(CHAPTER);
  getPublicChapterMock.mockResolvedValue({ study: STUDY, chapter: CHAPTER });
});

describe('AnalysisPage в study-контексте (KS-2877)', () => {
  describe('editor mode (/studies/:slug/:chapterId)', () => {
    beforeEach(() => {
      routeParams = { slug: 'demo', chapterId: 'ch1' };
    });

    it('загружает study + chapter через studiesApi.getBySlug+getChapter', async () => {
      renderWithProviders(<AnalysisPage studyMode="editor" />, {
        route: '/studies/demo/ch1',
      });
      await waitFor(() => {
        expect(getBySlugMock).toHaveBeenCalledWith('demo');
        expect(getChapterMock).toHaveBeenCalledWith('demo', 'ch1');
      });
      // ctx.kind='study' → AnalysisHeader виден (не review-режим без gameId).
      expect(screen.getByTestId('analysis-header-shortcut')).toBeInTheDocument();
    });

    it('breadcrumb: Studies → study.name → chapter.name', async () => {
      renderWithProviders(<AnalysisPage studyMode="editor" />, {
        route: '/studies/demo/ch1',
      });
      await waitFor(() => expect(getChapterMock).toHaveBeenCalled());
      // study.name отображается как breadcrumbSection
      await waitFor(() =>
        expect(screen.getAllByText('Demo study').length).toBeGreaterThan(0),
      );
      // chapter.name отображается как analysisTitle
      await waitFor(() =>
        expect(screen.getByTestId('analysis-header-title')).toHaveTextContent(
          'Chapter 1',
        ),
      );
    });

    it('mode-switcher (rightSlot) рендерится для study-editor', async () => {
      renderWithProviders(<AnalysisPage studyMode="editor" />, {
        route: '/studies/demo/ch1',
      });
      await waitFor(() => expect(getChapterMock).toHaveBeenCalled());
      await waitFor(() =>
        expect(
          screen.getByTestId('analysis-study-mode-switcher'),
        ).toBeInTheDocument(),
      );
    });

    it('chapter.mode=gamebook → extraPanel с AnalysisGamebookEditor', async () => {
      getChapterMock.mockResolvedValue({ ...CHAPTER, mode: 'gamebook' });
      renderWithProviders(<AnalysisPage studyMode="editor" />, {
        route: '/studies/demo/ch1',
      });
      await waitFor(() => expect(getChapterMock).toHaveBeenCalled());
      expect(screen.getByTestId('analysis-gamebook-editor')).toBeInTheDocument();
    });

    it('error при getChapter — показывается error state', async () => {
      getChapterMock.mockRejectedValue(new Error('boom'));
      renderWithProviders(<AnalysisPage studyMode="editor" />, {
        route: '/studies/demo/ch1',
      });
      await waitFor(() => expect(getChapterMock).toHaveBeenCalled());
      // error-state: i18n studies.error.notFound = «Study not found.»
      await waitFor(() => {
        expect(screen.getByText(/Study not found/i)).toBeInTheDocument();
      });
    });
  });

  describe('public-readonly mode (/studies/c/:chapterId)', () => {
    beforeEach(() => {
      routeParams = { chapterId: 'ch1' };
    });

    it('загружает через studiesApi.getPublicChapter (без slug)', async () => {
      renderWithProviders(<AnalysisPage studyMode="public-readonly" />, {
        route: '/studies/c/ch1',
      });
      await waitFor(() => {
        expect(getPublicChapterMock).toHaveBeenCalledWith('ch1');
      });
      // editor-роут НЕ должен был быть вызван
      expect(getBySlugMock).not.toHaveBeenCalled();
      expect(getChapterMock).not.toHaveBeenCalled();
    });

    it('breadcrumb: Studies → study.name → chapter.name', async () => {
      renderWithProviders(<AnalysisPage studyMode="public-readonly" />, {
        route: '/studies/c/ch1',
      });
      await waitFor(() => expect(getPublicChapterMock).toHaveBeenCalled());
      expect(screen.getByText('Demo study')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByTestId('analysis-header-title')).toHaveTextContent(
          'Chapter 1',
        ),
      );
    });

    it('title не редактируется (click не открывает input)', async () => {
      renderWithProviders(<AnalysisPage studyMode="public-readonly" />, {
        route: '/studies/c/ch1',
      });
      await waitFor(() => expect(getPublicChapterMock).toHaveBeenCalled());
      const title = screen.getByTestId('analysis-header-title');
      title.click();
      // input не должен появиться
      expect(screen.queryByTestId('analysis-header-title-input')).toBeNull();
    });

    it('mode-switcher (rightSlot) в public-readonly — select disabled', async () => {
      renderWithProviders(<AnalysisPage studyMode="public-readonly" />, {
        route: '/studies/c/ch1',
      });
      await waitFor(() => expect(getPublicChapterMock).toHaveBeenCalled());
      const select = screen.getByTestId(
        'analysis-study-mode-select',
      ) as HTMLSelectElement;
      expect(select.disabled).toBe(true);
    });
  });
});
