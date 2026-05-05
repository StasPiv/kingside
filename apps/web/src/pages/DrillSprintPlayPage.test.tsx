import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en/translation.json';

const apiPost = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: (path: string, body: unknown) => apiPost(path, body),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

// KS-2425: мокаем useDrillSounds, чтобы проверить факт вызова play()
// без запуска реального AudioContext.
const mockPlay = vi.fn();
vi.mock('../hooks/useDrillSounds', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useDrillSounds')>(
    '../hooks/useDrillSounds',
  );
  return {
    ...actual,
    useDrillSounds: () => ({
      play: mockPlay,
      drillMuted: false,
      globalMuted: false,
      toggleDrillMuted: vi.fn(),
    }),
  };
});

// Мокаем DrillBoard целиком — он тянет useBoardTheme/useBoardSettingsContext,
// которые требуют Provider. Нам в этих тестах достаточно проверить
// onSquareClick проксирование.
vi.mock('../components/drills', async () => {
  const actual = await vi.importActual<typeof import('../components/drills')>(
    '../components/drills',
  );
  return {
    ...actual,
    DrillBoard: ({
      onSquareClick,
      position,
    }: {
      position: string;
      onSquareClick?: (sq: string) => void;
      overlay?: unknown;
      highlightedSquares?: string[];
    }) => {
      const SQUARES = ['e4', 'e5', 'd4', 'd5'];
      return (
        <div data-testid="mock-board" data-position={position}>
          {SQUARES.map((sq) => (
            <button
              key={sq}
              type="button"
              data-testid={`fire-square-${sq}`}
              onClick={() => onSquareClick?.(sq)}
            >
              {sq}
            </button>
          ))}
        </div>
      );
    },
  };
});

import { DrillSprintPlayPage } from './DrillSprintPlayPage';

const testI18n = i18n.createInstance();
testI18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

const SESSION = {
  sessionId: 'sess-1',
  drill: {
    id: 'd-num',
    drillType: 'count-attackers',
    fen: '8/8/8/8/4P3/8/8/8 w - - 0 1',
    sideToMove: null,
    answerShape: 'number',
    difficulty: 1,
    meta: { highlightedSquare: 'e5' },
  },
  startedAt: new Date().toISOString(),
  durationMs: 180000,
};

function renderPlay(stateOverride?: unknown) {
  // Используем явный sentinel вместо ?? — null нужно сохранять как null,
  // ?? пропустит и использует дефолт.
  const state = arguments.length === 0 ? { session: SESSION } : stateOverride;
  return render(
    <I18nextProvider i18n={testI18n}>
      <MemoryRouter initialEntries={[{ pathname: '/drills/sprint/play', state }]}>
        <Routes>
          <Route path="/drills/sprint/play" element={<DrillSprintPlayPage />} />
          <Route
            path="/drills/sprint"
            element={<div data-testid="redirect-setup" />}
          />
          <Route
            path="/drills/sprint/results"
            element={<div data-testid="redirect-results" />}
          />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  apiPost.mockReset();
  mockPlay.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('<DrillSprintPlayPage> KS-2241', () => {
  it('без session в state → редирект на /drills/sprint', async () => {
    renderPlay(null);
    await waitFor(
      () =>
        expect(
          document.querySelector('[data-testid="redirect-setup"]'),
        ).not.toBeNull(),
      { timeout: 3000 },
    );
  });

  it('mount c session → рендер первого drill, score 0/0', () => {
    renderPlay();
    const root = document.querySelector('[data-testid="drill-sprint-play"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute('data-state')).toBe('idle');
    expect(root.getAttribute('data-shape')).toBe('number');
    const score = document.querySelector(
      '[data-testid="drill-sprint-play-score"]',
    ) as HTMLElement;
    expect(score.getAttribute('data-score')).toBe('0');
    expect(score.getAttribute('data-attempted')).toBe('0');
  });

  it('shape=number: клик 2 → POST submit с {shape:number,value:2}', async () => {
    apiPost.mockResolvedValue({
      attempt: {
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'number', value: 2 },
      },
      next: {
        ...SESSION.drill,
        id: 'd-num-2',
      },
    });
    const user = userEvent.setup();
    renderPlay();
    await user.click(document.querySelector('[data-testid="drill-count-attackers-btn-2"]')!);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/tactic-drill/sprint/submit',
        expect.objectContaining({
          drillId: 'd-num',
          mode: 'sprint',
          sessionId: 'sess-1',
          userAnswer: { shape: 'number', value: 2 },
        }),
      ),
    );
    // score инкрементировался.
    await waitFor(() => {
      const score = document.querySelector(
        '[data-testid="drill-sprint-play-score"]',
      ) as HTMLElement;
      expect(score.getAttribute('data-score')).toBe('1');
      expect(score.getAttribute('data-attempted')).toBe('1');
    });
  });

  it('resp.next=null + final → переход на /drills/sprint/results', async () => {
    apiPost.mockResolvedValue({
      attempt: {
        attemptId: 'a-last',
        solved: true,
        correctAnswer: { shape: 'number', value: 2 },
      },
      next: null,
      final: {
        scoreId: 'sc-99',
        score: 5,
        accuracy: 1.0,
        avgPrecision: 0,
      },
    });
    const user = userEvent.setup();
    renderPlay();
    await user.click(document.querySelector('[data-testid="drill-count-attackers-btn-2"]')!);
    await waitFor(
      () =>
        expect(
          document.querySelector('[data-testid="redirect-results"]'),
        ).not.toBeNull(),
      { timeout: 2000 },
    );
  });

  it('таймер показывает оставшееся время в формате M:SS', () => {
    renderPlay();
    const timer = document.querySelector(
      '[data-testid="drill-sprint-play-timer"]',
    ) as HTMLElement;
    expect(timer.textContent).toMatch(/\d+:\d{2}/);
    // ms-left ≈ durationMs.
    const left = Number(timer.getAttribute('data-ms-left'));
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(180000);
  });

  // ── KS-2425: звуки в sprint-режиме ───────────────────────────────────
  it('KS-2425: shape=number → puzzle-correct после правильного ответа', async () => {
    apiPost.mockResolvedValue({
      attempt: {
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'number', value: 2 },
      },
      next: { ...SESSION.drill, id: 'd-num-2' },
    });
    const user = userEvent.setup();
    renderPlay();
    await user.click(document.querySelector('[data-testid="drill-count-attackers-btn-2"]')!);
    // shape='number' не озвучивает submit-«move» (визуальный feedback от
    // кнопки достаточен) — играется только verdict.
    await waitFor(() => {
      expect(mockPlay).toHaveBeenCalledWith('puzzle-correct');
    });
    expect(mockPlay).not.toHaveBeenCalledWith('move');
  });

  it('KS-2425: solved=false → puzzle-incorrect', async () => {
    apiPost.mockResolvedValue({
      attempt: {
        attemptId: 'a1',
        solved: false,
        correctAnswer: { shape: 'number', value: 1 },
      },
      next: { ...SESSION.drill, id: 'd-num-2' },
    });
    const user = userEvent.setup();
    renderPlay();
    await user.click(document.querySelector('[data-testid="drill-count-attackers-btn-2"]')!);
    await waitFor(() => {
      expect(mockPlay).toHaveBeenCalledWith('puzzle-incorrect');
    });
  });

  it('KS-2425: shape=move click-click → select на pickup, move на коммите', async () => {
    apiPost.mockResolvedValue({
      attempt: {
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'move', from: 'e4', to: 'e5' },
      },
      next: null,
      final: { scoreId: 'sc-1', score: 1, accuracy: 1, avgPrecision: 0 },
    });
    const moveSession = {
      session: {
        ...SESSION,
        drill: {
          ...SESSION.drill,
          id: 'd-move',
          drillType: 'find-undefended-attack',
          answerShape: 'move',
          fen: '8/8/8/8/4P3/8/8/8 w - - 0 1',
        },
      },
    };
    const user = userEvent.setup();
    renderPlay(moveSession);
    // Первый клик — pickup.
    await user.click(document.querySelector('[data-testid="fire-square-e4"]')!);
    expect(mockPlay).toHaveBeenCalledWith('select');
    // Второй клик — коммит.
    await user.click(document.querySelector('[data-testid="fire-square-e5"]')!);
    await waitFor(() => {
      // Любой из move/capture/check/castle (resolveMoveSound решит) —
      // в этой простой позиции выйдет 'move'.
      expect(mockPlay).toHaveBeenCalledWith('move');
      expect(mockPlay).toHaveBeenCalledWith('puzzle-correct');
    });
  });
});
