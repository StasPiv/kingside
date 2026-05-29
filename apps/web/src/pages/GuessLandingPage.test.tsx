import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../test/test-utils';
import { GuessLandingPage } from './GuessLandingPage';

/**
 * KS-3412 (ADR-086 §9, F3) — точка входа /guess. GuessRunner (F1)
 * замокан — проверяем сетап: ввод PGN, валидация, выбор стороны, старт
 * прокидывает pgn+side в раннер.
 */

vi.mock('../components/guess', () => ({
  GuessRunner: ({ pgn, side }: { pgn: string; side: string }) => (
    <div data-testid="guess-runner-stub" data-pgn-len={pgn.length} data-side={side} />
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
});
