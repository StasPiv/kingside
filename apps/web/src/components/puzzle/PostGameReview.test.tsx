/**
 * KS-2534 — тесты `<PostGameReview>` после переработки в PGN-формат.
 * Проверяем рендер всей партии единой строкой, NAG-знаки на user-ходах,
 * варианты с лучшим ходом в скобках после плохого user-хода и
 * кликабельность токенов.
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PostGameReview,
  buildPgnReviewTokens,
} from './PostGameReview';
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
    // KS-2686: новые WDL/depth-поля с null по умолчанию — большинство
    // тестов проверяют логику классификации/NAG и WDL им не нужен.
    wdlBefore: null,
    wdlAfter: null,
    depth: null,
    ...over,
  };
}

describe('<PostGameReview> KS-2534', () => {
  it('пустой playedSans → null', () => {
    const { container } = renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={[]}
        userBestLog={[]}
        userSide="w"
      />,
    );
    expect(container.querySelector('[data-testid="post-game-review"]')).toBeNull();
  });

  it('идеальная партия (все user-ходы best) → нет NAG `?`/`??`/`?!`, может быть `!`', () => {
    // user играет e4 (best), engine отвечает e5; user играет Nf3 (best),
    // engine — Nc6.
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        cpBefore: 30,
        cpAfter: 30,
      }),
      snap({
        halfMove: 3,
        fenBefore:
          'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        playedUci: 'g1f3',
        bestUci: 'g1f3',
        cpBefore: 50,
        cpAfter: 50,
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['e4', 'e5', 'Nf3', 'Nc6']}
        userBestLog={log}
        userSide="w"
      />,
    );
    const pgn = screen.getByTestId('post-game-review-pgn');
    // Нет «?» или «??» в выводе.
    expect(pgn.textContent).not.toMatch(/\?\?/);
    expect(pgn.textContent).not.toMatch(/(^|[^!])\?(?!\?)/);
    // Должно быть e4 и Nf3 с «!».
    expect(pgn.textContent).toMatch(/e4!/);
    expect(pgn.textContent).toMatch(/Nf3!/);
    // Ходы движка (e5, Nc6) — без NAG.
    expect(pgn.textContent).toMatch(/e5(?![!?])/);
    expect(pgn.textContent).toMatch(/Nc6(?![!?])/);
  });

  it('blunder с лучшим ходом → NAG ?? и вариант «(N. SAN!)»', () => {
    // KS-3068: классификация теперь WDL-loss primary (ADR-066).
    // E_before = 1.0 (W=1000), E_after = 0.0 (L=1000) → loss_E=1.0 → blunder.
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4',
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 0, d: 0, l: 1000 },
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['d3']}
        userBestLog={log}
        userSide="w"
      />,
    );
    const pgn = screen.getByTestId('post-game-review-pgn');
    expect(pgn.textContent).toMatch(/d3\?\?/); // blunder NAG
    expect(pgn.textContent).toMatch(/\(1\. e4!\)/); // вариант
  });

  it('inaccuracy → ?!', () => {
    // E_before=0.7, E_after=0.62, loss_E=0.08 → inaccuracy (0.05<0.08≤0.12).
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4',
        wdlBefore: { w: 500, d: 400, l: 100 },
        wdlAfter: { w: 420, d: 400, l: 180 },
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['d3']}
        userBestLog={log}
        userSide="w"
      />,
    );
    const pgn = screen.getByTestId('post-game-review-pgn');
    expect(pgn.textContent).toMatch(/d3\?!/); // inaccuracy
    expect(pgn.textContent).toMatch(/\(1\. e4!\)/);
  });

  it('mistake → ?', () => {
    // E_before=0.7, E_after=0.5, loss_E=0.20 → mistake (0.12<0.20≤0.25).
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4',
        wdlBefore: { w: 500, d: 400, l: 100 },
        wdlAfter: { w: 300, d: 400, l: 300 },
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['d3']}
        userBestLog={log}
        userSide="w"
      />,
    );
    const pgn = screen.getByTestId('post-game-review-pgn');
    // ровно один знак вопроса
    expect(pgn.textContent).toMatch(/d3\?(?!\?)/);
    expect(pgn.textContent).toMatch(/\(1\. e4!\)/);
  });

  // KS-3068 regression: UX-bug из жалобы (Wang Shixu B - Nakamura, Nd2).
  // WDL 100/0/0 → 100/0/0 = эталонный ход в выигранной позиции; cp может
  // упасть на тысячи, но классификация должна оставаться `best` (`!`),
  // а не `blunder` (`??`). До KS-3068 PostGameReview использовал cp-only
  // и ставил `??` в этом сценарии.
  it('KS-3068: WDL 100/0/0 → 100/0/0 с cp-drop → best (!), не blunder (??)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4', // user не сыграл best, но WDL не упал
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 1000, d: 0, l: 0 },
        cpBefore: 1500, // cp-loss = 700, по старой формуле — blunder
        cpAfter: 800,
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['d3']}
        userBestLog={log}
        userSide="w"
      />,
    );
    const pgn = screen.getByTestId('post-game-review-pgn');
    expect(pgn.textContent).toMatch(/d3!/); // best
    expect(pgn.textContent).not.toMatch(/d3\?\?/); // НЕ blunder
    expect(pgn.textContent).not.toMatch(/d3\?(?!!)/); // вообще никаких «?»
  });

  // KS-3068 regression: второй кейс из жалобы (Ndf3 87/13/0% vs Лучший 100/0/0%).
  // E_before=1.0, E_after=0.87+0.065=0.935, loss_E=0.065 → inaccuracy (?!).
  // До KS-3068 этот же кейс по cp-only мог давать blunder (??).
  it('KS-3068: WDL 100/0/0 → 87/13/0 → inaccuracy (?!), не blunder (??)', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4',
        wdlBefore: { w: 1000, d: 0, l: 0 },
        wdlAfter: { w: 870, d: 130, l: 0 },
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['d3']}
        userBestLog={log}
        userSide="w"
      />,
    );
    const pgn = screen.getByTestId('post-game-review-pgn');
    expect(pgn.textContent).toMatch(/d3\?!/); // inaccuracy
    expect(pgn.textContent).not.toMatch(/d3\?\?/); // не blunder
  });

  it('user играет чёрными → префикс «N...» у первого хода и движок ходит первым (но первого нет, начинаем с user)', () => {
    // FEN side='b', user играет первым (солвер).
    const fen = 'rnbqkbnr/pppppppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: fen,
        playedUci: 'b8c6',
        bestUci: 'b8c6',
        cpBefore: 0,
        cpAfter: 0,
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={fen}
        playedSans={['Nc6']}
        userBestLog={log}
        userSide="b"
      />,
    );
    const pgn = screen.getByTestId('post-game-review-pgn');
    // Префикс «1...» перед чёрным ходом.
    expect(pgn.textContent).toMatch(/1\.\.\. Nc6/);
  });

  it('клик по user-ходу зовёт onSelectMove с fenBefore', async () => {
    const onSelectMove = vi.fn();
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        cpBefore: 30,
        cpAfter: 30,
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['e4']}
        userBestLog={log}
        userSide="w"
        onSelectMove={onSelectMove}
      />,
    );
    const moveBtn = screen.getByTestId('post-game-review-move-0');
    expect(moveBtn.tagName).toBe('BUTTON');
    await userEvent.click(moveBtn);
    expect(onSelectMove).toHaveBeenCalledWith({ fenBefore: STARTING_FEN });
  });

  it('клик по варианту зовёт onSelectMove с тем же fenBefore', async () => {
    const onSelectMove = vi.fn();
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4',
        cpBefore: 100,
        cpAfter: -300, // blunder, вариант показан
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['d3']}
        userBestLog={log}
        userSide="w"
        onSelectMove={onSelectMove}
      />,
    );
    const variation = screen.getByTestId('post-game-review-variation-0');
    expect(variation.tagName).toBe('BUTTON');
    await userEvent.click(variation);
    expect(onSelectMove).toHaveBeenCalledWith({ fenBefore: STARTING_FEN });
  });

  it('engine-ходы помечены data-is-user="false" и не имеют user-class', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        cpBefore: 30,
        cpAfter: 30,
      }),
    ];
    renderWithProviders(
      <PostGameReview
        initialFen={STARTING_FEN}
        playedSans={['e4', 'e5']}
        userBestLog={log}
        userSide="w"
      />,
    );
    expect(
      screen
        .getByTestId('post-game-review-move-0')
        .getAttribute('data-is-user'),
    ).toBe('true');
    expect(
      screen
        .getByTestId('post-game-review-move-1')
        .getAttribute('data-is-user'),
    ).toBe('false');
  });
});

describe('buildPgnReviewTokens KS-2534', () => {
  it('партия с одним blunder + лучший ход в варианте', () => {
    // KS-3617 follow-up: blunder теперь требует loss_E > 0.50; cp 100/-300
    // даёт всего ~0.40 → mistake. Поднимаем до 200/-2000 для blunder.
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4',
        cpBefore: 200,
        cpAfter: -2000,
      }),
    ];
    const tokens = buildPgnReviewTokens({
      initialFen: STARTING_FEN,
      playedSans: ['d3'],
      userBestLog: log,
      userSide: 'w',
    });
    // [movenum '1.', move 'd3' isUser blunder, variation '(1. e4!)']
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toEqual({ kind: 'movenum', text: '1.' });
    expect(tokens[1]).toMatchObject({
      kind: 'move',
      san: 'd3',
      nag: '??',
      isUser: true,
      cls: 'blunder',
    });
    expect(tokens[2]).toMatchObject({
      kind: 'variation',
      text: '(1. e4!)',
    });
  });

  it('идеальная партия (best) → один best NAG, без вариантов', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'e2e4',
        bestUci: 'e2e4',
        cpBefore: 30,
        cpAfter: 30,
      }),
    ];
    const tokens = buildPgnReviewTokens({
      initialFen: STARTING_FEN,
      playedSans: ['e4'],
      userBestLog: log,
      userSide: 'w',
    });
    expect(tokens.find((t) => t.kind === 'variation')).toBeUndefined();
    const moveTok = tokens.find((t) => t.kind === 'move');
    expect(moveTok).toMatchObject({ nag: '!', cls: 'best' });
  });

  it('несколько ошибок подряд (mistake + blunder) — два варианта', () => {
    const log: UserBestSnapshot[] = [
      snap({
        halfMove: 1,
        fenBefore: STARTING_FEN,
        playedUci: 'd2d3',
        bestUci: 'e2e4',
        cpBefore: 100,
        cpAfter: -50, // mistake
      }),
      snap({
        halfMove: 3,
        // FEN после d3 e5: white to move.
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/8/3P4/PPP1PPPP/RNBQKBNR w KQkq - 0 2',
        playedUci: 'h2h3',
        // d2-d4 здесь нелегален (d2 пуст после первого хода d3); берём
        // легальный лучший ход g1-f3 (Nf3).
        bestUci: 'g1f3',
        cpBefore: 100,
        cpAfter: -300, // blunder
      }),
    ];
    const tokens = buildPgnReviewTokens({
      initialFen: STARTING_FEN,
      playedSans: ['d3', 'e5', 'h3'],
      userBestLog: log,
      userSide: 'w',
    });
    const variations = tokens.filter((t) => t.kind === 'variation');
    expect(variations).toHaveLength(2);
  });
});
