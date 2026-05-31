import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { renderWithProviders, screen, testI18n } from '../test/test-utils';
import { BoardSettingsProvider } from '../context/BoardSettingsContext';
import { ThemeProvider } from '../context/ThemeContext';
import { GuessLandingPage } from './GuessLandingPage';

/**
 * KS-3412 (ADR-086 §9, F3) — точка входа /guess. GuessRunner (F1)
 * замокан — проверяем сетап: ввод PGN, валидация, выбор стороны, старт
 * прокидывает pgn+side в раннер.
 */

// KS-3503: GuessLandingPage теперь вызывает useAuth() для гейтинга
// кнопки «Pick from workshop». По умолчанию — авторизованный.
// Отдельные тесты переопределяют mockReturnValue до renderWithRoutes
// (см. KS-3503 guest test). vi.hoisted нужен, чтобы mockUseAuth
// существовал к моменту hoisted vi.mock factory.
const { mockUseAuth } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(() => ({
    user: { id: 'u-1', username: 'tester' },
    token: 'jwt',
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    loginWithTokens: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  })),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../components/guess', () => ({
  GuessSessionRunner: ({
    pgn,
    side,
    gameSource,
    gameRef,
  }: {
    pgn: string;
    side: string;
    gameSource: string;
    gameRef?: string | null;
  }) => (
    <div
      data-testid="guess-runner-stub"
      data-pgn-len={pgn.length}
      data-side={side}
      data-game-source={gameSource}
      data-game-ref={gameRef ?? ''}
    />
  ),
}));

const VALID_PGN = '[Event "T"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *';

afterEach(() => vi.restoreAllMocks());

describe('<GuessLandingPage> KS-3412', () => {
  it('setup-экран: textarea PGN + выбор стороны, Start задизейблен без PGN', () => {
    renderWithProviders(<GuessLandingPage />, { route: '/guess' });
    expect(screen.getByTestId('guess-page').getAttribute('data-state')).toBe('setup');
    expect(screen.getByTestId('guess-pgn-input')).toBeTruthy();
    expect(screen.getByTestId('guess-side-picker')).toBeTruthy();
    expect((screen.getByTestId('guess-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('невалидный PGN → Start задизейблен + ошибка', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GuessLandingPage />, { route: '/guess' });
    await user.type(screen.getByTestId('guess-pgn-input'), 'not a real pgn 1. zz9');
    expect((screen.getByTestId('guess-start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('guess-pgn-error')).toBeTruthy();
  });

  it('валидный PGN + сторона black → Start запускает раннер с pgn+side', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GuessLandingPage />, { route: '/guess' });
    // paste через fireEvent проще для большого PGN — используем clear+type.
    const ta = screen.getByTestId('guess-pgn-input') as HTMLTextAreaElement;
    await user.click(ta);
    // Вставляем PGN напрямую (type экранировал бы []).
    ta.value = VALID_PGN;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // Через React onChange value не подхватится при ручном dispatch —
    // используем fireEvent-эквивалент: меняем через userEvent.paste.
    await user.clear(ta);
    await user.paste(VALID_PGN);

    await user.click(screen.getByTestId('guess-side-black'));
    expect(screen.getByTestId('guess-side-black').getAttribute('aria-pressed')).toBe('true');

    expect((screen.getByTestId('guess-start') as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId('guess-start'));

    const runner = screen.getByTestId('guess-runner-stub');
    expect(runner).toBeTruthy();
    expect(runner.getAttribute('data-side')).toBe('black');
    expect(Number(runner.getAttribute('data-pgn-len'))).toBeGreaterThan(0);
    expect(screen.getByTestId('guess-page').getAttribute('data-state')).toBe('playing');
  });

  // ── KS-3498 (ADR-091 F1) ─────────────────────────────────────────
  describe('KS-3498: выбор партии из архива', () => {
    function ArchiveStub() {
      const loc = useLocation();
      return (
        <div
          data-testid="archive-stub"
          data-return-to={(loc.state as { returnTo?: string } | null)?.returnTo ?? ''}
          data-return-label={
            (loc.state as { returnLabel?: string } | null)?.returnLabel ?? ''
          }
        />
      );
    }

    function renderWithRoutes(initialEntries: Array<string | { pathname: string; state: unknown }>) {
      return render(
        <I18nextProvider i18n={testI18n}>
          <ThemeProvider initialTheme="dark">
            <BoardSettingsProvider>
              <MemoryRouter initialEntries={initialEntries}>
                <Routes>
                  <Route path="/guess" element={<GuessLandingPage />} />
                  <Route path="/archive" element={<ArchiveStub />} />
                </Routes>
              </MemoryRouter>
            </BoardSettingsProvider>
          </ThemeProvider>
        </I18nextProvider>,
      );
    }

    it('кнопка «Pick from archive» ведёт на /archive со state {returnTo,returnLabel}', async () => {
      const user = userEvent.setup();
      renderWithRoutes(['/guess']);
      const pick = screen.getByTestId('guess-archive-pick');
      expect(pick.textContent).toContain('Pick from archive');
      await user.click(pick);
      const stub = screen.getByTestId('archive-stub');
      expect(stub.getAttribute('data-return-to')).toBe('/guess');
      expect(stub.getAttribute('data-return-label')).toBe('Guess the move');
    });

    it('возврат со state {archiveGameId,...} (legacy) рисует превью + заполняет PGN + Start активен', () => {
      renderWithRoutes([
        {
          pathname: '/guess',
          state: {
            archiveGameId: 'arc-123',
            pgn: VALID_PGN,
            white: 'Carlsen',
            black: 'Nepomniachtchi',
            event: 'WCC 2021',
          },
        },
      ]);
      // KS-3503: testid унифицирован → guess-pick-preview, data-source.
      const preview = screen.getByTestId('guess-pick-preview');
      expect(preview.getAttribute('data-source')).toBe('archive');
      expect(preview.getAttribute('data-ref-id')).toBe('arc-123');
      expect(screen.getByTestId('guess-pick-preview-main').textContent).toContain(
        'Carlsen vs Nepomniachtchi',
      );
      expect(screen.getByTestId('guess-pick-preview-event').textContent).toContain(
        'WCC 2021',
      );
      expect(
        (screen.getByTestId('guess-pgn-input') as HTMLTextAreaElement).value,
      ).toBe(VALID_PGN);
      expect(
        (screen.getByTestId('guess-start') as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    it('Start с archive → GuessSessionRunner получает gameSource=archive + gameRef=id', async () => {
      const user = userEvent.setup();
      renderWithRoutes([
        {
          pathname: '/guess',
          state: {
            archiveGameId: 'arc-9',
            pgn: VALID_PGN,
            white: 'A',
            black: 'B',
            event: 'X',
          },
        },
      ]);
      await user.click(screen.getByTestId('guess-start'));
      const runner = screen.getByTestId('guess-runner-stub');
      expect(runner.getAttribute('data-game-source')).toBe('archive');
      expect(runner.getAttribute('data-game-ref')).toBe('arc-9');
    });

    it('«Изменить выбор» сбрасывает превью + уводит обратно в /archive', async () => {
      const user = userEvent.setup();
      renderWithRoutes([
        {
          pathname: '/guess',
          state: {
            archiveGameId: 'arc-7',
            pgn: VALID_PGN,
            white: 'A',
            black: 'B',
            event: 'X',
          },
        },
      ]);
      await user.click(screen.getByTestId('guess-pick-change'));
      const stub = screen.getByTestId('archive-stub');
      expect(stub.getAttribute('data-return-to')).toBe('/guess');
    });

    it('без archive — Start всё ещё требует валидный PGN', async () => {
      renderWithRoutes(['/guess']);
      expect(
        (screen.getByTestId('guess-start') as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });

  // ── KS-3503 (ADR-092 F1-ext) ─────────────────────────────────────
  describe('KS-3503: выбор партии из мастерской + унифицированный state', () => {
    function WorkshopStub() {
      const loc = useLocation();
      return (
        <div
          data-testid="workshop-stub"
          data-return-to={(loc.state as { returnTo?: string } | null)?.returnTo ?? ''}
          data-return-label={
            (loc.state as { returnLabel?: string } | null)?.returnLabel ?? ''
          }
        />
      );
    }

    function renderWithRoutes(
      initialEntries: Array<string | { pathname: string; state: unknown }>,
    ) {
      return render(
        <I18nextProvider i18n={testI18n}>
          <ThemeProvider initialTheme="dark">
            <BoardSettingsProvider>
              <MemoryRouter initialEntries={initialEntries}>
                <Routes>
                  <Route path="/guess" element={<GuessLandingPage />} />
                  <Route path="/workshop" element={<WorkshopStub />} />
                </Routes>
              </MemoryRouter>
            </BoardSettingsProvider>
          </ThemeProvider>
        </I18nextProvider>,
      );
    }

    it('кнопка «Pick from workshop» (auth) ведёт на /workshop со state', async () => {
      const user = userEvent.setup();
      renderWithRoutes(['/guess']);
      const pick = screen.getByTestId('guess-workshop-pick') as HTMLButtonElement;
      expect(pick.textContent).toContain('Pick from workshop');
      expect(pick.disabled).toBe(false);
      await user.click(pick);
      const stub = screen.getByTestId('workshop-stub');
      expect(stub.getAttribute('data-return-to')).toBe('/guess');
      expect(stub.getAttribute('data-return-label')).toBe('Guess the move');
    });

    it('гость: кнопка «Pick from workshop» disabled + title с подсказкой', () => {
      mockUseAuth.mockReturnValueOnce({
        user: null,
        token: null,
        loading: false,
        login: vi.fn(),
        register: vi.fn(),
        loginWithTokens: vi.fn(),
        logout: vi.fn(),
        refreshUser: vi.fn(),
      } as ReturnType<typeof mockUseAuth>);
      renderWithRoutes(['/guess']);
      const pick = screen.getByTestId('guess-workshop-pick') as HTMLButtonElement;
      expect(pick.disabled).toBe(true);
      expect(pick.getAttribute('aria-disabled')).toBe('true');
      expect(pick.title).toContain('Sign in');
    });

    it('возврат со state {source:"own", refId, title} рисует workshop-превью', () => {
      renderWithRoutes([
        {
          pathname: '/guess',
          state: {
            source: 'own',
            refId: 'an-42',
            pgn: VALID_PGN,
            title: 'Sicilian fix attempt #3',
          },
        },
      ]);
      const preview = screen.getByTestId('guess-pick-preview');
      expect(preview.getAttribute('data-source')).toBe('own');
      expect(preview.getAttribute('data-ref-id')).toBe('an-42');
      expect(screen.getByTestId('guess-pick-preview-label').textContent).toContain(
        'From workshop',
      );
      expect(screen.getByTestId('guess-pick-preview-main').textContent).toContain(
        'Sicilian fix attempt #3',
      );
      // archive-event'а в own-режиме нет.
      expect(screen.queryByTestId('guess-pick-preview-event')).toBeNull();
    });

    it('Start с own → runner получает gameSource=own + gameRef=id', async () => {
      const user = userEvent.setup();
      renderWithRoutes([
        {
          pathname: '/guess',
          state: {
            source: 'own',
            refId: 'an-99',
            pgn: VALID_PGN,
            title: 'My game',
          },
        },
      ]);
      await user.click(screen.getByTestId('guess-start'));
      const runner = screen.getByTestId('guess-runner-stub');
      expect(runner.getAttribute('data-game-source')).toBe('own');
      expect(runner.getAttribute('data-game-ref')).toBe('an-99');
    });

    it('возврат с унифицированным state {source:"archive", refId} рисует archive-превью', () => {
      renderWithRoutes([
        {
          pathname: '/guess',
          state: {
            source: 'archive',
            refId: 'arc-50',
            pgn: VALID_PGN,
            white: 'Magnus',
            black: 'Fabiano',
            event: 'Norway',
          },
        },
      ]);
      const preview = screen.getByTestId('guess-pick-preview');
      expect(preview.getAttribute('data-source')).toBe('archive');
      expect(preview.getAttribute('data-ref-id')).toBe('arc-50');
      expect(screen.getByTestId('guess-pick-preview-label').textContent).toContain(
        'From archive',
      );
      expect(screen.getByTestId('guess-pick-preview-main').textContent).toContain(
        'Magnus vs Fabiano',
      );
      expect(screen.getByTestId('guess-pick-preview-event').textContent).toContain(
        'Norway',
      );
    });

    it('кнопки «pick-buttons»: своё перед чужим', () => {
      renderWithRoutes(['/guess']);
      const container = screen.getByTestId('guess-pick-buttons');
      const btns = Array.from(
        container.querySelectorAll('[data-testid]'),
      ).map((el) => el.getAttribute('data-testid'));
      expect(btns).toEqual(['guess-workshop-pick', 'guess-archive-pick']);
    });
  });
});
