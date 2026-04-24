import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { BracketLink, BroadcastGameSummary } from '@kingside/shared';

import { renderWithProviders, screen } from '../../test/test-utils';
import {
  PlayoffBracket,
  computeLinePoints,
  computeMatchScore,
  computeOrthogonalPath,
  deriveWinnerLinks,
  determineWinner,
  formatHalfScore,
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
      game({ id: 'g1', result: '1-0', updatedAt: '2026-04-24T10:00:00Z' }),
      game({ id: 'g2', result: '0-1', updatedAt: '2026-04-24T11:00:00Z' }),
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
    // Обе партии g1+g2 с whitePlayer=Alice (дефолт), поэтому Alice-white в обеих.
    // g1: 1-0 → Alice +1, Bob 0. g2: 0-1 → Alice 0, Bob +1. Итог «1-1».
    expect(ab?.matchScore).toBe('1-1');
  });

  it('matchScore агрегирован, а не взят из одной партии (backend поле игнорируется)', () => {
    // Все 3 партии в pair'е, разные результаты. Раньше код брал matchScore
    // из поля одной партии — теперь считает на клиенте.
    const games: BroadcastGameSummary[] = [
      game({ id: 'g-late', result: '1-0', matchScore: '9-9', updatedAt: '2026-04-24T12:00:00Z' }),
      game({ id: 'g-mid', result: '1-0', matchScore: '7-7', updatedAt: '2026-04-24T11:00:00Z' }),
      game({ id: 'g-early', result: '1/2-1/2', matchScore: '5-5', updatedAt: '2026-04-24T10:00:00Z' }),
    ];
    const pairs = groupGamesByPair(games);
    // Все партии Alice-white, Bob-black: 1-0 + 1-0 + 1/2-1/2 = Alice 2.5, Bob 0.5.
    expect(pairs[0].matchScore).toBe('2½-½');
  });

  it('matchScore учитывает чередование цветов (prod-паттерн chess.com)', () => {
    // Реальный сценарий: пара Abdu-Sevian, игры меняют цвет. Все 3 партии
    // выиграл Abdusattorov. Итог 3-0 в пользу Abdu, т.е. для anchor (Sevian,
    // который был white в g1) — «0-3», если считать от его имени.
    const games: BroadcastGameSummary[] = [
      game({
        id: 'g1',
        whitePlayer: 'Sevian',
        blackPlayer: 'Abdusattorov',
        result: '0-1', // Abdu (black) won
        bracketPairId: 'p',
      }),
      game({
        id: 'g2',
        whitePlayer: 'Abdusattorov', // colors swapped
        blackPlayer: 'Sevian',
        result: '1-0', // Abdu (white) won
        bracketPairId: 'p',
      }),
      game({
        id: 'g3',
        whitePlayer: 'Sevian',
        blackPlayer: 'Abdusattorov',
        result: '0-1', // Abdu (black) won
        bracketPairId: 'p',
      }),
    ];
    const pairs = groupGamesByPair(games);
    // Pair anchor: whitePlayer=Sevian, blackPlayer=Abdu. Сумма от лица anchor.
    expect(pairs[0].matchScore).toBe('0-3');
  });

  it('пропускает партии с result=«*» (в процессе)', () => {
    const games: BroadcastGameSummary[] = [
      game({ id: 'g1', result: '1-0', bracketPairId: 'p' }),
      game({ id: 'g2', result: '*', bracketPairId: 'p' }),
      game({ id: 'g3', result: '*', bracketPairId: 'p' }),
    ];
    const pairs = groupGamesByPair(games);
    expect(pairs[0].matchScore).toBe('1-0');
  });

  it('все партии в процессе → matchScore=null (прочерк в UI)', () => {
    const games: BroadcastGameSummary[] = [
      game({ id: 'g1', result: '*', bracketPairId: 'p' }),
      game({ id: 'g2', result: '*', bracketPairId: 'p' }),
    ];
    const pairs = groupGamesByPair(games);
    expect(pairs[0].matchScore).toBeNull();
  });

  it('распознаёт и «1/2-1/2», и «½-½»', () => {
    const games: BroadcastGameSummary[] = [
      game({ id: 'g1', result: '1/2-1/2', bracketPairId: 'p' }),
      game({ id: 'g2', result: '½-½', bracketPairId: 'p' }),
    ];
    const pairs = groupGamesByPair(games);
    expect(pairs[0].matchScore).toBe('1-1');
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

describe('formatHalfScore', () => {
  it.each([
    [0, '0'],
    [0.5, '½'],
    [1, '1'],
    [1.5, '1½'],
    [2, '2'],
    [2.5, '2½'],
    [3, '3'],
  ])('%f → %s', (input, expected) => {
    expect(formatHalfScore(input)).toBe(expected);
  });
});

describe('computeMatchScore', () => {
  const mk = (white: string, black: string, result: string): BroadcastGameSummary => ({
    id: `${white}-${black}-${result}`,
    lichessGameId: 'x',
    whitePlayer: white,
    blackPlayer: black,
    whiteElo: 2500,
    blackElo: 2500,
    result,
    pgn: null,
    currentFen: null,
    updatedAt: '2026-04-24T10:00:00Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
  });

  it('0 партий → null', () => {
    expect(computeMatchScore('A', 'B', [])).toBeNull();
  });

  it('все «*» → null', () => {
    expect(
      computeMatchScore('A', 'B', [mk('A', 'B', '*'), mk('B', 'A', '*')]),
    ).toBeNull();
  });

  it('победа anchor-white во всех партиях (без смены цветов)', () => {
    const games = [mk('A', 'B', '1-0'), mk('A', 'B', '1-0'), mk('A', 'B', '1-0')];
    expect(computeMatchScore('A', 'B', games)).toBe('3-0');
  });

  it('цвета чередуются — учитывается имя игрока, а не поле white/black', () => {
    const games = [
      mk('A', 'B', '1-0'), // A wins
      mk('B', 'A', '0-1'), // A wins (колор swap, A был black)
      mk('A', 'B', '1/2-1/2'),
    ];
    expect(computeMatchScore('A', 'B', games)).toBe('2½-½');
  });

  it('anchor null → fallback: считаем game-white как pair-white', () => {
    const games = [mk('A', 'B', '1-0'), mk('A', 'B', '0-1')];
    expect(computeMatchScore(null, null, games)).toBe('1-1');
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

  it('стадии пересортируются tree-каскадом: R16 под своими QF-детьми', () => {
    // 4 R16 → 2 QF. Backend прислал QF insertion-порядок [QF2 (Carl+Guy),
    // QF1 (Alice+Eve)]. R16 insertion-порядок arbitrary: [r1 Alice, r2 Carl,
    // r3 Eve, r4 Guy].
    //
    // Backward-каскад (`layoutBracket`): самая поздняя стадия (QF)
    // сохраняет insertion-порядок. Для R16 каждая пара получает слот
    // `childSlot * 2 + j`:
    //   - r1 (Alice wins) → QF1 (slot 1) → slot 1*2 + j
    //   - r2 (Carl  wins) → QF2 (slot 0) → slot 0*2 + j
    //   - r3 (Eve   wins) → QF1 (slot 1) → slot 1*2 + j'
    //   - r4 (Guy   wins) → QF2 (slot 0) → slot 0*2 + j'
    // Пары под одним ребёнком получают j=0 и j=1 (в insertion-порядке).
    // Итог R16-порядка: [r2, r4, r1, r3].
    const games: BroadcastGameSummary[] = [
      game({ id: 'r1', bracketStage: 'round_of_16', bracketPairId: 'r16:alice|bob', whitePlayer: 'Alice', blackPlayer: 'Bob', result: '1-0' }),
      game({ id: 'r2', bracketStage: 'round_of_16', bracketPairId: 'r16:carl|dan', whitePlayer: 'Carl', blackPlayer: 'Dan', result: '1-0' }),
      game({ id: 'r3', bracketStage: 'round_of_16', bracketPairId: 'r16:eve|fred', whitePlayer: 'Eve', blackPlayer: 'Fred', result: '1-0' }),
      game({ id: 'r4', bracketStage: 'round_of_16', bracketPairId: 'r16:guy|hen', whitePlayer: 'Guy', blackPlayer: 'Hen', result: '1-0' }),
      game({ id: 'q2', bracketStage: 'quarter', bracketPairId: 'qf:carl|guy', whitePlayer: 'Carl', blackPlayer: 'Guy', result: '*' }),
      game({ id: 'q1', bracketStage: 'quarter', bracketPairId: 'qf:alice|eve', whitePlayer: 'Alice', blackPlayer: 'Eve', result: '*' }),
    ];
    const layout = layoutBracket(groupGamesByPair(games));
    const r16Pairs = layout[0].stages.find((s) => s.stage === 'round_of_16')!.pairs;
    const qfPairs = layout[0].stages.find((s) => s.stage === 'quarter')!.pairs;
    // QF сохранил insertion-порядок.
    expect(qfPairs.map((p) => p.pairId)).toEqual([
      'qf:carl|guy',
      'qf:alice|eve',
    ]);
    // R16 переупорядочен: сначала родители QF2, потом родители QF1.
    expect(r16Pairs.map((p) => p.pairId)).toEqual([
      'r16:carl|dan',
      'r16:guy|hen',
      'r16:alice|bob',
      'r16:eve|fred',
    ]);
  });
});

describe('determineWinner', () => {
  const mk = (white: string, black: string, result: string): BroadcastGameSummary => ({
    id: `${white}-${black}-${result}`,
    lichessGameId: 'x',
    whitePlayer: white,
    blackPlayer: black,
    whiteElo: 2500,
    blackElo: 2500,
    result,
    pgn: null,
    currentFen: null,
    updatedAt: '2026-04-24T10:00:00Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
  });

  it('пара не играна → null', () => {
    expect(
      determineWinner({
        pairId: 'p',
        stage: 'final',
        whitePlayer: 'A',
        blackPlayer: 'B',
        matchScore: null,
        games: [mk('A', 'B', '*')],
      }),
    ).toBeNull();
  });

  it('белые (anchor) выиграли → имя белого', () => {
    expect(
      determineWinner({
        pairId: 'p',
        stage: 'final',
        whitePlayer: 'Carlsen',
        blackPlayer: 'Caruana',
        matchScore: null,
        games: [mk('Carlsen', 'Caruana', '1-0'), mk('Caruana', 'Carlsen', '0-1')],
      }),
    ).toBe('Carlsen');
  });

  it('чёрные (anchor) выиграли → имя чёрного', () => {
    expect(
      determineWinner({
        pairId: 'p',
        stage: 'final',
        whitePlayer: 'Carlsen',
        blackPlayer: 'Caruana',
        matchScore: null,
        games: [mk('Carlsen', 'Caruana', '0-1'), mk('Caruana', 'Carlsen', '1-0')],
      }),
    ).toBe('Caruana');
  });

  it('ничья по очкам → null', () => {
    expect(
      determineWinner({
        pairId: 'p',
        stage: 'final',
        whitePlayer: 'A',
        blackPlayer: 'B',
        matchScore: null,
        games: [mk('A', 'B', '1-0'), mk('B', 'A', '1-0')],
      }),
    ).toBeNull();
  });
});

describe('deriveWinnerLinks', () => {
  it('связывает победителя R16 с QF-парой, содержащей его имя', () => {
    // Реальный прод-паттерн: QF-пары содержат РАЗНЫЕ пары победителей
    // из разных R16-пар. deriveWinnerLinks находит правильного родителя
    // по совпадению имени.
    const games: BroadcastGameSummary[] = [
      game({ id: 'r1', bracketStage: 'round_of_16', bracketPairId: 'r16:carlsen|sargsyan', whitePlayer: 'Carlsen', blackPlayer: 'Sargsyan', result: '1-0' }),
      game({ id: 'r2', bracketStage: 'round_of_16', bracketPairId: 'r16:keymer|pranesh', whitePlayer: 'Keymer', blackPlayer: 'Pranesh', result: '1-0' }),
      game({ id: 'r3', bracketStage: 'round_of_16', bracketPairId: 'r16:abdu|sevian', whitePlayer: 'Abdu', blackPlayer: 'Sevian', result: '1-0' }),
      game({ id: 'r4', bracketStage: 'round_of_16', bracketPairId: 'r16:lazavik|yu', whitePlayer: 'Lazavik', blackPlayer: 'Yu', result: '1-0' }),
      game({ id: 'q1', bracketStage: 'quarter', bracketPairId: 'qf:carlsen|keymer', whitePlayer: 'Carlsen', blackPlayer: 'Keymer', result: '*' }),
      game({ id: 'q2', bracketStage: 'quarter', bracketPairId: 'qf:abdu|lazavik', whitePlayer: 'Abdu', blackPlayer: 'Lazavik', result: '*' }),
    ];
    const layout = layoutBracket(groupGamesByPair(games));
    const derived = deriveWinnerLinks(layout);
    // Должны быть 4 winner-линии: каждый R16 → соответствующая QF
    expect(derived).toHaveLength(4);
    expect(derived).toContainEqual(
      expect.objectContaining({ fromPairId: 'r16:carlsen|sargsyan', toPairId: 'qf:carlsen|keymer', kind: 'winner' }),
    );
    expect(derived).toContainEqual(
      expect.objectContaining({ fromPairId: 'r16:keymer|pranesh', toPairId: 'qf:carlsen|keymer', kind: 'winner' }),
    );
    expect(derived).toContainEqual(
      expect.objectContaining({ fromPairId: 'r16:abdu|sevian', toPairId: 'qf:abdu|lazavik', kind: 'winner' }),
    );
    expect(derived).toContainEqual(
      expect.objectContaining({ fromPairId: 'r16:lazavik|yu', toPairId: 'qf:abdu|lazavik', kind: 'winner' }),
    );
  });

  it('R16 не доигран (result=*) → линии из этой пары нет', () => {
    const games: BroadcastGameSummary[] = [
      game({ id: 'r1', bracketStage: 'round_of_16', bracketPairId: 'r16:a|b', whitePlayer: 'A', blackPlayer: 'B', result: '*' }),
      game({ id: 'q1', bracketStage: 'quarter', bracketPairId: 'qf:a|c', whitePlayer: 'A', blackPlayer: 'C', result: '*' }),
    ];
    const layout = layoutBracket(groupGamesByPair(games));
    const derived = deriveWinnerLinks(layout);
    expect(derived).toHaveLength(0);
  });

  it('победитель не найден среди QF-пар следующей стадии → линии нет', () => {
    const games: BroadcastGameSummary[] = [
      game({ id: 'r1', bracketStage: 'round_of_16', bracketPairId: 'r16:a|b', whitePlayer: 'A', blackPlayer: 'B', result: '1-0' }),
      game({ id: 'q1', bracketStage: 'quarter', bracketPairId: 'qf:x|y', whitePlayer: 'X', blackPlayer: 'Y', result: '*' }),
    ];
    const layout = layoutBracket(groupGamesByPair(games));
    const derived = deriveWinnerLinks(layout);
    expect(derived).toHaveLength(0);
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
            id: 'g1a',
            bracketPairId: 'quarter:A|B',
            bracketStage: 'quarter',
            whitePlayer: 'Alice',
            blackPlayer: 'Bob',
            result: '1-0',
          }),
          game({
            id: 'g1b',
            bracketPairId: 'quarter:A|B',
            bracketStage: 'quarter',
            whitePlayer: 'Bob',
            blackPlayer: 'Alice',
            result: '0-1', // Alice wins (colors swapped)
          }),
          game({
            id: 'g1c',
            bracketPairId: 'quarter:A|B',
            bracketStage: 'quarter',
            whitePlayer: 'Alice',
            blackPlayer: 'Bob',
            result: '1/2-1/2',
          }),
          game({
            id: 'g2',
            bracketPairId: 'semi:C|D',
            bracketStage: 'semi',
            whitePlayer: 'Carl',
            blackPlayer: 'Dan',
            result: '1-0',
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('playoff-bracket')).toBeInTheDocument();
    expect(screen.getByTestId('playoff-stage-quarter')).toBeInTheDocument();
    expect(screen.getByTestId('playoff-stage-semi')).toBeInTheDocument();
    // Alice 2 wins + 1 draw vs Bob 0 wins + 1 draw = 2½-½
    expect(
      screen.getByTestId('playoff-pair-score-quarter:A|B'),
    ).toHaveTextContent('2½-½');
    expect(
      screen.getByTestId('playoff-pair-score-semi:C|D'),
    ).toHaveTextContent('1-0');
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

  it('клик по доске игры → onGameClick вызван с её объектом', () => {
    const onGameClick = vi.fn();
    const target = game({
      id: 'g-click',
      pgn: '1. e4 e5',
      result: '1-0',
    });
    renderWithProviders(
      <PlayoffBracket games={[target]} onGameClick={onGameClick} />,
    );
    fireEvent.click(screen.getByTestId(`broadcast-board-card-${target.id}`));
    expect(onGameClick).toHaveBeenCalledTimes(1);
    expect(onGameClick.mock.calls[0][0].id).toBe('g-click');
  });

  it('если у игры нет pgn — карточка без role=button (не кликабельна)', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[game({ id: 'no-pgn', pgn: null })]}
      />,
    );
    const card = screen.getByTestId('broadcast-board-card-no-pgn');
    expect(card.getAttribute('role')).toBeNull();
    expect(card.className).not.toContain('broadcast-board-card--clickable');
  });

  it('все партии «*» → прочерк (нет законченных — счёт не определён)', () => {
    renderWithProviders(
      <PlayoffBracket
        games={[
          game({
            id: 'no-score',
            bracketPairId: 'quarter:X|Y',
            result: '*',
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

  it('links не пустой → рендерится SVG с <path>-линиями нужных kind', () => {
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
    const paths = svg.querySelectorAll('path');
    expect(paths).toHaveLength(2);
    expect(svg.querySelector('[data-testid="playoff-bracket-link-winner"]')).toBeTruthy();
    expect(svg.querySelector('[data-testid="playoff-bracket-link-loser"]')).toBeTruthy();
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
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelectorAll('path')).toHaveLength(0);
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

describe('computeOrthogonalPath', () => {
  it('строит L-shape path с вертикалью на середине между from и to', () => {
    const container = { left: 0, top: 0, right: 1000, bottom: 800 };
    const from = { left: 100, top: 100, right: 200, bottom: 200 };
    const to = { left: 400, top: 400, right: 500, bottom: 500 };
    const d = computeOrthogonalPath(from, to, container);
    // x1=200, y1=150, x2=400, y2=450, midX=300
    expect(d).toBe('M 200 150 L 300 150 L 300 450 L 400 450');
  });

  it('горизонтальные пары на одной высоте → путь вырождается в прямую через ортогональные сегменты', () => {
    const container = { left: 0, top: 0, right: 1000, bottom: 800 };
    const from = { left: 100, top: 100, right: 200, bottom: 200 };
    const to = { left: 400, top: 100, right: 500, bottom: 200 };
    const d = computeOrthogonalPath(from, to, container);
    // y1=y2=150, midX=300
    expect(d).toBe('M 200 150 L 300 150 L 300 150 L 400 150');
  });
});
