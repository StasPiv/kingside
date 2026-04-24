import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { BracketLink, BroadcastGameSummary } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PlayoffBracket,
  computeLinePoints,
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

  // ─── KS-1825: links + SVG overlay ──────────────────────────────────

  it('links не задан → SVG-overlay не рендерится (fallback KS-1814)', () => {
    renderWithProviders(
      <PlayoffBracket games={[game({ bracketPairId: 'q:A|B' })]} />,
    );
    expect(
      screen.queryByTestId('playoff-bracket-links'),
    ).not.toBeInTheDocument();
  });

  it('links=[] → SVG-overlay не рендерится', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[game({ bracketPairId: 'q:A|B' })]}
        links={[]}
      />,
    );
    expect(
      screen.queryByTestId('playoff-bracket-links'),
    ).not.toBeInTheDocument();
  });

  it('links не пустой → рендерится SVG с правильным числом <line> и правильными kind-classes', () => {
    const games = [
      game({ bracketPairId: 'wq:A|B', bracketStage: 'winners_quarter' }),
      game({ bracketPairId: 'ws:A|C', bracketStage: 'winners_semi' }),
      game({ bracketPairId: 'ls:B|D', bracketStage: 'losers_semi' }),
    ];
    const links: BracketLink[] = [
      { fromPairId: 'wq:A|B', toPairId: 'ws:A|C', kind: 'winner' },
      { fromPairId: 'wq:A|B', toPairId: 'ls:B|D', kind: 'loser' },
    ];
    renderWithProviders(<PlayoffBracket games={games} links={links} />);
    const svg = screen.getByTestId('playoff-bracket-links');
    expect(svg).toBeInTheDocument();
    expect(svg.tagName.toLowerCase()).toBe('svg');
    const lines = svg.querySelectorAll('line');
    expect(lines).toHaveLength(2);
    expect(svg.querySelector('[data-testid="playoff-bracket-link-winner"]')).toBeTruthy();
    expect(svg.querySelector('[data-testid="playoff-bracket-link-loser"]')).toBeTruthy();
    // Классы задают стиль линий (сплошная/пунктир через CSS).
    expect(
      svg.querySelector('.playoff-bracket__link--winner'),
    ).toBeTruthy();
    expect(
      svg.querySelector('.playoff-bracket__link--loser'),
    ).toBeTruthy();
  });

  it('link с несуществующим fromPairId/toPairId — игнорируется', () => {
    const games = [game({ bracketPairId: 'wq:A|B', bracketStage: 'winners_quarter' })];
    const links: BracketLink[] = [
      { fromPairId: 'wq:A|B', toPairId: 'does-not-exist', kind: 'winner' },
      { fromPairId: 'also-missing', toPairId: 'wq:A|B', kind: 'loser' },
    ];
    renderWithProviders(<PlayoffBracket games={games} links={links} />);
    const svg = screen.queryByTestId('playoff-bracket-links');
    // svg есть (links.length>0), но <line> нет
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelectorAll('line')).toHaveLength(0);
  });

  it('каждая пара получает data-pair-id для DOM-поиска SVG-линиями', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[
          game({ id: 'g1', bracketPairId: 'p:A|B' }),
          game({ id: 'g2', bracketPairId: 'p:C|D' }),
        ]}
      />,
    );
    expect(
      document.querySelector('[data-pair-id="p:A|B"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-pair-id="p:C|D"]'),
    ).toBeTruthy();
  });
});

describe('computeLinePoints', () => {
  it('вычисляет координаты линии «центр правой — центр левой» относительно контейнера', () => {
    // Контейнер 1000×800, начало (100, 50)
    const container = { left: 100, top: 50, right: 1100, bottom: 850 };
    // from пара 200×100 на (150, 100) — абсолютные координаты
    const from = { left: 150, top: 100, right: 350, bottom: 200 };
    // to пара 200×100 на (500, 400)
    const to = { left: 500, top: 400, right: 700, bottom: 500 };
    const pts = computeLinePoints(from, to, container);
    expect(pts).toEqual({
      // x1 = from.right - container.left = 350 - 100 = 250
      x1: 250,
      // y1 = (from.top + from.bottom) / 2 - container.top = 150 - 50 = 100
      y1: 100,
      // x2 = to.left - container.left = 500 - 100 = 400
      x2: 400,
      // y2 = (to.top + to.bottom) / 2 - container.top = 450 - 50 = 400
      y2: 400,
    });
  });

  it('контейнер в (0,0) → координаты = абсолютные', () => {
    const container = { left: 0, top: 0, right: 1000, bottom: 800 };
    const from = { left: 10, top: 20, right: 30, bottom: 40 };
    const to = { left: 100, top: 200, right: 120, bottom: 220 };
    const pts = computeLinePoints(from, to, container);
    expect(pts).toEqual({ x1: 30, y1: 30, x2: 100, y2: 210 });
  });
});
