import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2585 / KS-3137: тесты `PuzzleGeneratorModal` после переезда на
 * WDL-алгоритм (KS-2584) и ADR-068 `evaluateBlunder`.
 *
 * Что проверяем:
 *  - advanced settings: nodes + ΔW + ΔD (KS-3364 заменил depth на nodes);
 *  - **отсутствие** legacy-controls (multiPv/gapThreshold/maxSecondCp/
 *    acceptedMoves/skipHanging/skipAttacked/skipUndefended/blunderDelta);
 *  - localStorage migration: старые ключи в LS (включая `blunderDelta`)
 *    игнорируются;
 *  - ΔW/ΔD слайдеры в %, store в долях [0..1];
 *  - draft/publish flow: после save видим «N saved as drafts», 2 кнопки;
 *  - «My drafts» → /precision?mine=true&visibility=draft;
 *  - «Publish all» → PATCH /puzzles/publish-all → /precision.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const apiPost = vi.fn();
const apiPatch = vi.fn();
vi.mock('../api', () => ({
  api: {
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

vi.mock('../hooks/useEngine', () => ({
  loadEngineConfigs: () => [],
}));

const generatePuzzles = vi.fn();
vi.mock('../utils/puzzleGenerator', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../utils/puzzleGenerator')
  >();
  return {
    ...actual,
    generatePuzzlesFromPgn: (...args: unknown[]) => generatePuzzles(...args),
  };
});

import { PuzzleGeneratorModal } from './PuzzleGeneratorModal';

// KS-3143: поле `gap` (legacy cp-алгоритма) убрано из payload — фикстура
// больше не содержит его, чтобы не возвращать удалённый ключ.
const SAMPLE_PUZZLE = {
  fen: '8/8/8/8/4k3/8/4K3/8 w - - 0 1',
  moves: '',
  rating: 1500,
  themes: 'playVsEngine advantage',
  sourceType: 'pgn_import',
  sourceId: null,
  sourceMoveNum: 21,
  sourceMetadata: { blunderMove: 'd2d4' },
  solutionMode: 'play-vs-engine' as const,
  isPublic: false as const,
};

beforeEach(() => {
  mockNavigate.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  generatePuzzles.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<PuzzleGeneratorModal> KS-2585 / KS-3137 — advanced settings', () => {
  it('по умолчанию advanced скрыт; toggle показывает блок с nodes/ΔW/ΔD', () => {
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    expect(
      screen.queryByTestId('puzzle-generator-advanced-body'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    expect(
      screen.getByTestId('puzzle-generator-advanced-body'),
    ).toBeInTheDocument();
    // KS-3364: «Глубина» заменена на «Узлы».
    expect(screen.getByTestId('puzzle-generator-nodes')).toBeInTheDocument();
    expect(
      screen.queryByTestId('puzzle-generator-depth'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('puzzle-generator-delta-w'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('puzzle-generator-delta-d'),
    ).toBeInTheDocument();
    // KS-3160: solvability-toggle снят (shared pipeline без такого этапа).
    expect(
      screen.queryByTestId('puzzle-generator-solvability'),
    ).not.toBeInTheDocument();
  });

  it('KS-3364: слайдер «Узлы» — диапазон 1M..40M, шаг 1M, дефолт 10M', () => {
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    const slider = screen.getByTestId(
      'puzzle-generator-nodes',
    ) as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('1000000');
    expect(slider.max).toBe('40000000');
    expect(slider.step).toBe('1000000');
    expect(slider.value).toBe('10000000');
  });

  it('KS-3364: изменение nodes сохраняется в localStorage', () => {
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    const slider = screen.getByTestId(
      'puzzle-generator-nodes',
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '20000000' } });
    const stored = JSON.parse(localStorage.getItem('puzzleGenSettings') ?? '{}');
    expect(stored.nodes).toBe(20000000);
  });

  it('legacy controls удалены — нет multiPv/gap/maxSecond/acceptedMoves/skip*/единого blunder-delta', () => {
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    // Заголовки CP-эры:
    expect(screen.queryByText(/^Lines$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Min gap/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Max 2nd eval/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Accepted moves/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Skip hanging captures/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Skip attacked by lesser/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Skip undefended after move/i),
    ).not.toBeInTheDocument();
    // KS-3137: одиночный «Minimum blunder strength» / `puzzle-generator-blunder-delta` снят.
    expect(
      screen.queryByTestId('puzzle-generator-blunder-delta'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Minimum blunder strength/i),
    ).not.toBeInTheDocument();
  });

  it('ΔW slider 30..90, шаг 5, дефолт 60', () => {
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    const slider = screen.getByTestId(
      'puzzle-generator-delta-w',
    ) as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('30');
    expect(slider.max).toBe('90');
    expect(slider.step).toBe('5');
    expect(slider.value).toBe('60');
  });

  it('ΔD slider 30..90, шаг 5, дефолт 60', () => {
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    const slider = screen.getByTestId(
      'puzzle-generator-delta-d',
    ) as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('30');
    expect(slider.max).toBe('90');
    expect(slider.step).toBe('5');
    expect(slider.value).toBe('60');
  });

  it('изменение ΔW/ΔD сохраняется в localStorage в долях [0..1] и независимо', () => {
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    const w = screen.getByTestId(
      'puzzle-generator-delta-w',
    ) as HTMLInputElement;
    const d = screen.getByTestId(
      'puzzle-generator-delta-d',
    ) as HTMLInputElement;
    fireEvent.change(w, { target: { value: '75' } });
    fireEvent.change(d, { target: { value: '45' } });
    const stored = JSON.parse(localStorage.getItem('puzzleGenSettings') ?? '{}');
    expect(stored.deltaWThreshold).toBeCloseTo(0.75, 5);
    expect(stored.deltaDThreshold).toBeCloseTo(0.45, 5);
  });

  it('reload модалки восстанавливает ΔW/ΔD/nodes из localStorage', () => {
    localStorage.setItem(
      'puzzleGenSettings',
      JSON.stringify({
        // KS-3364: depth в LS больше не читается, мы пишем `nodes`.
        nodes: 16_000_000,
        deltaWThreshold: 0.45,
        deltaDThreshold: 0.7,
        // KS-3160: legacy `solvabilityCheck` молча игнорируется
        // loadSettings'ом — поле в новой схеме отсутствует.
        solvabilityCheck: true,
      }),
    );
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    const w = screen.getByTestId(
      'puzzle-generator-delta-w',
    ) as HTMLInputElement;
    expect(w.value).toBe('45');
    const d = screen.getByTestId(
      'puzzle-generator-delta-d',
    ) as HTMLInputElement;
    expect(d.value).toBe('70');
    const nodes = screen.getByTestId(
      'puzzle-generator-nodes',
    ) as HTMLInputElement;
    expect(nodes.value).toBe('16000000');
    expect(
      screen.queryByTestId('puzzle-generator-solvability'),
    ).not.toBeInTheDocument();
  });

  it('KS-3364: legacy `depth` в localStorage игнорируется, nodes остаётся 10M', () => {
    localStorage.setItem(
      'puzzleGenSettings',
      JSON.stringify({
        depth: 18, // legacy ключ — фронт его больше не читает.
        multiPv: 5,
        gapThreshold: 100,
        skipHangingCapture: true,
        acceptedMoves: 2,
        blunderDelta: 0.8, // KS-3137 legacy.
      }),
    );
    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('puzzle-generator-advanced-toggle'));
    // KS-3364: legacy `depth` игнорируется; nodes — дефолт 10M.
    const nodes = screen.getByTestId(
      'puzzle-generator-nodes',
    ) as HTMLInputElement;
    expect(nodes.value).toBe('10000000');
    // ΔW и ΔD — дефолт 60% (старый `blunderDelta: 0.8` проигнорирован).
    const w = screen.getByTestId(
      'puzzle-generator-delta-w',
    ) as HTMLInputElement;
    expect(w.value).toBe('60');
    const d = screen.getByTestId(
      'puzzle-generator-delta-d',
    ) as HTMLInputElement;
    expect(d.value).toBe('60');
    expect(
      screen.queryByTestId('puzzle-generator-solvability'),
    ).not.toBeInTheDocument();
  });
});

describe('<PuzzleGeneratorModal> KS-2585 — draft/publish flow', () => {
  async function generateAndSave() {
    generatePuzzles.mockResolvedValue([SAMPLE_PUZZLE, SAMPLE_PUZZLE]);
    apiPost.mockResolvedValue({ ok: true });

    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    const textarea = screen.getByTestId(
      'puzzle-generator-textarea',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '[Event "Test"]\n1. e4' } });
    fireEvent.click(screen.getByTestId('puzzle-generator-start'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-save')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('puzzle-generator-save'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-saved')).toBeInTheDocument(),
    );
  }

  it('после сохранения показывает «N saved as drafts» + кнопки My drafts / Publish all', async () => {
    await generateAndSave();
    const saved = screen.getByTestId('puzzle-generator-saved');
    expect(saved.textContent).toMatch(/2 saved as drafts/i);
    expect(saved.textContent).toMatch(/Drafts are visible only to you/i);
    expect(
      screen.getByTestId('puzzle-generator-my-drafts'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('puzzle-generator-publish-all'),
    ).toBeInTheDocument();
  });

  it('старые кнопки Solve now / My puzzles удалены', async () => {
    await generateAndSave();
    expect(screen.queryByText(/Solve now/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^My puzzles$/i)).not.toBeInTheDocument();
  });

  it('My drafts → navigate(/precision?mine=true&visibility=draft) + onClose', async () => {
    const onClose = vi.fn();
    generatePuzzles.mockResolvedValue([SAMPLE_PUZZLE]);
    apiPost.mockResolvedValue({ ok: true });

    renderWithProviders(<PuzzleGeneratorModal onClose={onClose} />);
    fireEvent.change(screen.getByTestId('puzzle-generator-textarea'), {
      target: { value: '[Event "T"]\n1. e4' },
    });
    fireEvent.click(screen.getByTestId('puzzle-generator-start'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-save')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('puzzle-generator-save'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-saved')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('puzzle-generator-my-drafts'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(
      '/precision?mine=true&visibility=draft',
    );
  });

  it('Publish all → PATCH /puzzles/publish-all → navigate(/precision)', async () => {
    const onClose = vi.fn();
    generatePuzzles.mockResolvedValue([SAMPLE_PUZZLE]);
    apiPost.mockResolvedValue({ ok: true });
    apiPatch.mockResolvedValue({ ok: true });

    renderWithProviders(<PuzzleGeneratorModal onClose={onClose} />);
    fireEvent.change(screen.getByTestId('puzzle-generator-textarea'), {
      target: { value: '[Event "T"]\n1. e4' },
    });
    fireEvent.click(screen.getByTestId('puzzle-generator-start'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-save')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('puzzle-generator-save'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-saved')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('puzzle-generator-publish-all'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith('/puzzles/publish-all', {}),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/precision');
  });

  it('Publish all ошибка → показывает error, не навигирует', async () => {
    generatePuzzles.mockResolvedValue([SAMPLE_PUZZLE]);
    apiPost.mockResolvedValue({ ok: true });
    apiPatch.mockRejectedValueOnce(new Error('publish boom'));

    renderWithProviders(<PuzzleGeneratorModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('puzzle-generator-textarea'), {
      target: { value: '[Event "T"]\n1. e4' },
    });
    fireEvent.click(screen.getByTestId('puzzle-generator-start'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-save')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('puzzle-generator-save'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-saved')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('puzzle-generator-publish-all'));
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-generator-error').textContent).toMatch(
        /publish boom/,
      ),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
