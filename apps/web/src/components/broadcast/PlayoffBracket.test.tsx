import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { BroadcastGameSummary } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PlayoffBracket,
  groupGamesByPair,
  layoutBracket,
  STAGE_ORDER,
} from './PlayoffBracket';

function game(over: Partial<BroadcastGameSummary>): BroadcastGameSummary {
  return {
    id: over.id ?? 'g-' + Math.random().toString(36).slice(2, 7),
    lichessGameId: 'lg-' + (over.id ?? 'x'),
    whitePlayer: 'Alice',
    blackPlayer: 'Bob',
    whiteElo: 2500,
    blackElo: 2500,
    result: '*',
    pgn: null,
    currentFen: null,
    updatedAt: '2026-04-24T10:00:00.000Z',
    bracketStage: 'quarter',
    bracketPairId: 'quarter:Alice|Bob',
    matchScore: '0-0',
    ...over,
  };
}

describe('groupGamesByPair', () => {
  it('группирует партии одной пары по bracketPairId', () => {
    const games: BroadcastGameSummary[] = [
      game({ id: 'g1', matchScore: '1-0' }),
      game({ id: 'g2', matchScore: '1-1' }),
      game({
        id: 'g3',
        bracketPairId: 'quarter:Carl|Dan',
        whitePlayer: 'Carl',
        blackPlayer: 'Dan',
      }),
    ];
    const pairs = groupGamesByPair(games);
    expect(pairs).toHaveLength(2);
    const ab = pairs.find((p) => p.pairId === 'quarter:Alice|Bob');
    expect(ab?.games).toHaveLength(2);
    // Последний matchScore «1-1» должен перезатереть первый «1-0».
    expect(ab?.matchScore).toBe('1-1');
  });

  it('игры без bracketPairId рендерятся как отдельные пары', () => {
    const games: BroadcastGameSummary[] = [
      game({ id: 'g1', bracketPairId: null }),
      game({ id: 'g2', bracketPairId: null }),
    ];
    const pairs = groupGamesByPair(games);
    expect(pairs).toHaveLength(2);
  });
});

describe('layoutBracket', () => {
  it('разделяет winners / losers / main в отдельные track', () => {
    const pairs = groupGamesByPair([
      game({ bracketStage: 'winners_semi', bracketPairId: 'w1' }),
      game({ bracketStage: 'losers_semi', bracketPairId: 'l1' }),
      game({ bracketStage: 'final', bracketPairId: 'f1' }),
    ]);
    const layout = layoutBracket(pairs);
    const labels = layout.map((t) => t.label);
    expect(labels).toEqual(['winners', 'losers', 'main']);
  });

  it('сортирует стадии в порядке STAGE_ORDER', () => {
    const pairs = groupGamesByPair([
      game({ bracketStage: 'final', bracketPairId: 'a' }),
      game({ bracketStage: 'quarter', bracketPairId: 'b' }),
      game({ bracketStage: 'semi', bracketPairId: 'c' }),
    ]);
    const layout = layoutBracket(pairs);
    const stages = layout[0].stages.map((s) => s.stage);
    expect(stages).toEqual(['quarter', 'semi', 'final']);
  });

  it('STAGE_ORDER замороженное (контрактный тест)', () => {
    expect([...STAGE_ORDER]).toEqual([
      'round_of_64',
      'round_of_32',
      'round_of_16',
      'quarter',
      'semi',
      'final',
      'grand_final',
      'playoff',
    ]);
  });
});

describe('<PlayoffBracket>', () => {
  it('пустой список → empty-state', () => {
    renderWithProviders(<PlayoffBracket games={[]} />);
    expect(screen.getByTestId('playoff-bracket-empty')).toBeInTheDocument();
  });

  it('рендерит пары, счёт, стадии', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[
          game({
            id: 'g1',
            bracketPairId: 'quarter:A|B',
            bracketStage: 'quarter',
            whitePlayer: 'Alice',
            blackPlayer: 'Bob',
            matchScore: '2-1',
          }),
          game({
            id: 'g2',
            bracketPairId: 'semi:C|D',
            bracketStage: 'semi',
            whitePlayer: 'Carl',
            blackPlayer: 'Dan',
            matchScore: '3-0',
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('playoff-bracket')).toBeInTheDocument();
    expect(screen.getByTestId('playoff-stage-quarter')).toBeInTheDocument();
    expect(screen.getByTestId('playoff-stage-semi')).toBeInTheDocument();
    expect(
      screen.getByTestId('playoff-pair-score-quarter:A|B'),
    ).toHaveTextContent('2-1');
    expect(
      screen.getByTestId('playoff-pair-score-semi:C|D'),
    ).toHaveTextContent('3-0');
  });

  it('winners/losers рендерятся в отдельных track', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[
          game({
            id: 'w',
            bracketPairId: 'winners_semi:A|B',
            bracketStage: 'winners_semi',
          }),
          game({
            id: 'l',
            bracketPairId: 'losers_semi:C|D',
            bracketStage: 'losers_semi',
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('playoff-track-winners')).toBeInTheDocument();
    expect(screen.getByTestId('playoff-track-losers')).toBeInTheDocument();
    expect(
      screen.queryByTestId('playoff-track-main'),
    ).not.toBeInTheDocument();
  });

  it('клик по игре → onGameClick вызван с её объектом', () => {
    const onGameClick = vi.fn();
    const target = game({
      id: 'g-click',
      pgn: '1. e4 e5',
      result: '1-0',
    });
    renderWithProviders(
      <PlayoffBracket games={[target]} onGameClick={onGameClick} />,
    );
    // Раскрываем <details> (в jsdom/happy-dom details не раскрывается
    // автоматически — клик по summary). Но кнопка игры тестируется
    // напрямую через testid.
    fireEvent.click(screen.getByTestId(`playoff-game-${target.id}`));
    expect(onGameClick).toHaveBeenCalledTimes(1);
    expect(onGameClick.mock.calls[0][0].id).toBe('g-click');
  });

  it('если у игры нет pgn — кнопка disabled', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[game({ id: 'no-pgn', pgn: null })]}
      />,
    );
    const btn = screen.getByTestId('playoff-game-no-pgn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('matchScore отсутствует → прочерк', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[
          game({
            id: 'no-score',
            bracketPairId: 'quarter:X|Y',
            matchScore: null,
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId('playoff-pair-score-quarter:X|Y'),
    ).toHaveTextContent('—');
  });
});
