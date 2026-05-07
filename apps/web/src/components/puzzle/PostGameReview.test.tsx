/**
 * KS-2508 — тесты `<PostGameReview>`. Pure-компонент: проверяем
 * рендер на разных классификациях, fallback при null cp-полях,
 * empty-state и условный показ «Best was».
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PostGameReview } from './PostGameReview';
import type { UserBestSnapshot } from './PlayVsEngineRunner';

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function snap(over: Partial<UserBestSnapshot> = {}): UserBestSnapshot {
  return {
    halfMove: 1,
    fenBefore: STARTING_FEN,
    playedUci: 'e2e4',
    bestUci: 'e2e4',
    cpBefore: 30,
    cpAfter: 30,
    ...over,
  };
}

describe('<PostGameReview> KS-2508', () => {
  it('пустой userBestLog → null (компонент не рендерится)', () => {
    const { container } = renderWithProviders(
      <PostGameReview userBestLog={[]} />,
    );
    expect(container.querySelector('[data-testid="post-game-review"]')).toBeNull();
  });

  it('played === best → метка `best` (без блока «Best was»)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        cpBefore: 30,
        cpAfter: 30,
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    expect(screen.getByTestId('post-game-review')).toBeInTheDocument();
    const row = screen.getByTestId('post-game-review-row-1');
    expect(row.getAttribute('data-class')).toBe('best');
    // «Best was» не показывается на best/good.
    expect(screen.queryByTestId('post-game-review-best-1')).toBeNull();
  });

  it('cp-loss < 50 → good (нет «Best was»)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        playedUci: 'e2e4',
        bestUci: 'd2d4',
        cpBefore: 100,
        cpAfter: 70, // loss=30
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    expect(screen.getByTestId('post-game-review-row-1').getAttribute('data-class')).toBe(
      'good',
    );
    expect(screen.queryByTestId('post-game-review-best-1')).toBeNull();
  });

  it('cp-loss 50-99 → inaccuracy (с «Best was»)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 2,
        playedUci: 'g1f3',
        bestUci: 'd2d4',
        cpBefore: 100,
        cpAfter: 30, // loss=70
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    const row = screen.getByTestId('post-game-review-row-2');
    expect(row.getAttribute('data-class')).toBe('inaccuracy');
    expect(screen.getByTestId('post-game-review-best-2')).toBeInTheDocument();
  });

  it('cp-loss 100-199 → mistake (с «Best was»)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 3,
        playedUci: 'b1c3',
        bestUci: 'd2d4',
        cpBefore: 100,
        cpAfter: -50, // loss=150
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    expect(
      screen.getByTestId('post-game-review-row-3').getAttribute('data-class'),
    ).toBe('mistake');
    expect(screen.getByTestId('post-game-review-best-3')).toBeInTheDocument();
  });

  it('cp-loss ≥ 200 → blunder (с «Best was»)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 4,
        playedUci: 'h2h3',
        bestUci: 'd2d4',
        cpBefore: 100,
        cpAfter: -300, // loss=400
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    expect(
      screen.getByTestId('post-game-review-row-4').getAttribute('data-class'),
    ).toBe('blunder');
    expect(screen.getByTestId('post-game-review-best-4')).toBeInTheDocument();
  });

  it('cpBefore=null или cpAfter=null → fallback: best (если played==best) либо good', () => {
    const log: UserBestSnapshot[] = [
      // played === best → даже без cp, помечаем best.
      snap({
        halfMove: 1,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        cpBefore: null,
        cpAfter: null,
      }),
      // played !== best и нет cp → graceful good (вреда нет, но
      // помечать blunder без данных нечестно).
      snap({
        halfMove: 2,
        playedUci: 'h2h3',
        bestUci: 'd2d4',
        cpBefore: null,
        cpAfter: null,
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    expect(
      screen.getByTestId('post-game-review-row-1').getAttribute('data-class'),
    ).toBe('best');
    expect(
      screen.getByTestId('post-game-review-row-2').getAttribute('data-class'),
    ).toBe('good');
    // На graceful-good «Best was» не показываем — нечего объяснять
    // без cp-данных.
    expect(screen.queryByTestId('post-game-review-best-1')).toBeNull();
    expect(screen.queryByTestId('post-game-review-best-2')).toBeNull();
  });

  it('SAN played и SAN best отображаются в правильных строках', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        playedUci: 'h2h3',
        bestUci: 'e2e4',
        cpBefore: 100,
        cpAfter: -200, // mistake / blunder, чтобы Best was показался
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    const row = screen.getByTestId('post-game-review-row-1');
    expect(row.textContent).toMatch(/h3/); // played
    const best = screen.getByTestId('post-game-review-best-1');
    expect(best.textContent).toMatch(/e4/); // best (через SAN)
    expect(best.textContent).toMatch(/Best was|Лучше было/);
  });

  it('KS-2510: без onSelectMove строка не button — нет post-game-review-select-N', () => {
    const log: UserBestSnapshot[] = [snap()];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    expect(screen.queryByTestId('post-game-review-select-1')).toBeNull();
  });

  it('KS-2510: с onSelectMove строка кликабельна и зовёт callback со snapshot', async () => {
    const onSelectMove = vi.fn();
    const log: UserBestSnapshot[] = [
      snap({ halfMove: 1, playedUci: 'e2e4' }),
      snap({
        halfMove: 2,
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        playedUci: 'g1f3',
        bestUci: 'd2d4',
        cpBefore: 100,
        cpAfter: -200, // mistake, чтобы row реально был кликабелен
      }),
    ];
    renderWithProviders(
      <PostGameReview userBestLog={log} onSelectMove={onSelectMove} />,
    );
    const btn = screen.getByTestId('post-game-review-select-2');
    expect(btn.tagName).toBe('BUTTON');
    await userEvent.click(btn);
    expect(onSelectMove).toHaveBeenCalledTimes(1);
    expect(onSelectMove).toHaveBeenCalledWith(log[1]);
    // Передан именно snapshot с тем же fenBefore, который потом
    // дёргает родитель.
    const arg = onSelectMove.mock.calls[0][0] as UserBestSnapshot;
    expect(arg.fenBefore).toBe(log[1].fenBefore);
  });

  it('заголовок и метки не fallback на ключи (i18n работает)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        playedUci: 'h2h3',
        bestUci: 'e2e4',
        cpBefore: 100,
        cpAfter: -300,
      }),
    ];
    renderWithProviders(<PostGameReview userBestLog={log} />);
    const root = screen.getByTestId('post-game-review');
    // Ни один из ключей i18n не должен утечь в DOM как fallback.
    expect(root.textContent).not.toContain('puzzle.engine.review.headerLabel');
    expect(root.textContent).not.toContain('puzzle.engine.review.class.blunder');
    expect(root.textContent).toMatch(/Game review|Разбор партии/);
    expect(root.textContent).toMatch(/Blunder|Зевок/);
  });

  it('KS-2511: snapshot полного разбора по всем 5 классам', () => {
    // Каждая классификация представлена строкой с правильным
    // cp-loss'ом. SAN-ы выбраны разные, чтобы snapshot отличался
    // содержательно, а не только метками.
    const log: UserBestSnapshot[] = [
      // 1. best: played === best
      snap({
        halfMove: 1,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        cpBefore: 30,
        cpAfter: 30,
      }),
      // 2. good: cp-loss < 50
      snap({
        halfMove: 2,
        fenBefore:
          'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        playedUci: 'g1f3',
        bestUci: 'd2d4',
        cpBefore: 100,
        cpAfter: 70,
      }),
      // 3. inaccuracy: cp-loss 50-99
      snap({
        halfMove: 3,
        fenBefore:
          'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
        playedUci: 'b8c6',
        bestUci: 'g8f6',
        cpBefore: 100,
        cpAfter: 30,
      }),
      // 4. mistake: cp-loss 100-199
      snap({
        halfMove: 4,
        fenBefore:
          'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        playedUci: 'f1c4',
        bestUci: 'd2d4',
        cpBefore: 100,
        cpAfter: -50,
      }),
      // 5. blunder: cp-loss ≥ 200
      snap({
        halfMove: 5,
        fenBefore:
          'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
        playedUci: 'h7h6',
        bestUci: 'g8f6',
        cpBefore: 100,
        cpAfter: -300,
      }),
    ];
    const { container } = renderWithProviders(
      <PostGameReview userBestLog={log} />,
    );
    expect(
      container.querySelector('[data-testid="post-game-review"]'),
    ).toMatchSnapshot();
  });
});
