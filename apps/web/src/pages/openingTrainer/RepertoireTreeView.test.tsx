import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { RepertoireTreeView } from './RepertoireTreeView';
import type {
  OpeningLineProgressDto,
  RepertoireTree,
} from '@kingside/shared';

const makeTree = (): RepertoireTree => ({
  rootFen: 'start',
  nodes: {
    start: {
      fen: 'start',
      edges: [{ moveUci: 'e2e4', moveSan: 'e4', childFen: 'after-e4' }],
    },
    'after-e4': {
      fen: 'after-e4',
      edges: [
        { moveUci: 'c7c5', moveSan: 'c5', childFen: 'after-c5' },
        { moveUci: 'e7e5', moveSan: 'e5', childFen: 'after-e5' },
      ],
    },
    'after-c5': { fen: 'after-c5', edges: [] },
    'after-e5': { fen: 'after-e5', edges: [] },
  },
  meta: { nodeCount: 4, edgeCount: 3, maxDepth: 2 },
});

function makeLine(overrides: Partial<OpeningLineProgressDto>): OpeningLineProgressDto {
  return {
    id: 'l',
    repertoireId: 'r',
    pathHash: 'h',
    pathUci: [],
    pathLength: 0,
    correctCount: 0,
    wrongCount: 0,
    consecutiveCorrect: 0,
    lastPlayedAt: '2026-05-24T00:00:00Z',
    masteredAt: null,
    sm2DueAt: null,
    sm2Interval: null,
    sm2Easiness: null,
    sm2Reps: null,
    orphaned: false,
    status: 'not-played',
    ...overrides,
  };
}

describe('RepertoireTreeView (KS-3305 — via ReviewMoveList)', () => {
  it('рендерит главную линию inline и альтернативу в скобках', () => {
    const lines: OpeningLineProgressDto[] = [
      makeLine({ pathUci: ['e2e4'], status: 'mastered' }),
      makeLine({ pathUci: ['e2e4', 'c7c5'], status: 'due' }),
      makeLine({ pathUci: ['e2e4', 'e7e5'], status: 'wrong' }),
    ];
    const { container } = renderWithProviders(
      <RepertoireTreeView tree={makeTree()} lines={lines} />,
    );
    expect(screen.getByTestId('opening-trainer-tree')).toBeInTheDocument();
    // Главная линия: 1.e4 1...c5 (первый edge каждого node как main).
    const moveSpans = Array.from(container.querySelectorAll('.review-move'));
    const moveTexts = moveSpans.map((el) => el.textContent ?? '');
    expect(moveTexts.some((t) => t.includes('e4'))).toBe(true);
    expect(moveTexts.some((t) => t.includes('c5'))).toBe(true);
    expect(moveTexts.some((t) => t.includes('e5'))).toBe(true);
    // Альтернатива в скобках — DOM имеет review-bracket span'ы.
    const brackets = container.querySelectorAll('.review-bracket');
    expect(brackets.length).toBeGreaterThan(0);
  });

  it('у каждого хода data-status соответствует прогрессу', () => {
    const lines: OpeningLineProgressDto[] = [
      makeLine({ pathUci: ['e2e4'], status: 'mastered' }),
      makeLine({ pathUci: ['e2e4', 'c7c5'], status: 'due' }),
    ];
    const { container } = renderWithProviders(
      <RepertoireTreeView tree={makeTree()} lines={lines} />,
    );
    const moves = Array.from(container.querySelectorAll('.review-move'));
    const statuses = moves
      .map((el) => el.getAttribute('data-status'))
      .filter(Boolean);
    expect(statuses).toContain('mastered');
    expect(statuses).toContain('due');
  });

  it('линии без записи имеют data-status="not-played"', () => {
    const { container } = renderWithProviders(
      <RepertoireTreeView tree={makeTree()} lines={[]} />,
    );
    const moves = Array.from(container.querySelectorAll('.review-move'));
    const notPlayed = moves.filter(
      (el) => el.getAttribute('data-status') === 'not-played',
    );
    expect(notPlayed.length).toBeGreaterThanOrEqual(3);
  });

  it('orphan-линии не отрисовываются', () => {
    const lines: OpeningLineProgressDto[] = [
      makeLine({ pathUci: ['e2e4'], status: 'mastered', orphaned: true }),
    ];
    const { container } = renderWithProviders(
      <RepertoireTreeView tree={makeTree()} lines={lines} />,
    );
    // Если корневой 1.e4 orphan'ный — всё дерево пустое после фильтра.
    const moves = container.querySelectorAll('.review-move');
    expect(moves.length).toBe(0);
  });

  it('пустое дерево показывает плашку empty', () => {
    const empty: RepertoireTree = {
      rootFen: 'start',
      nodes: { start: { fen: 'start', edges: [] } },
      meta: { nodeCount: 1, edgeCount: 0, maxDepth: 0 },
    };
    renderWithProviders(<RepertoireTreeView tree={empty} lines={[]} />);
    expect(screen.getByTestId('opening-trainer-tree-empty')).toBeInTheDocument();
  });

  it('KS-3308: при side=black белые ходы (бот) имеют data-status="bot", чёрные — реальный статус', () => {
    // Простое дерево: 1.e4 (бот) → 1...c5 (юзер) → 2.Nf3 (бот) → 2...d6 (юзер).
    const lines: OpeningLineProgressDto[] = [
      makeLine({ pathUci: ['e2e4', 'c7c5'], status: 'mastered' }),
    ];
    const tree: RepertoireTree = {
      rootFen: 'start',
      nodes: {
        start: { fen: 'start', edges: [{ moveUci: 'e2e4', moveSan: 'e4', childFen: 'a' }] },
        a: { fen: 'a', edges: [{ moveUci: 'c7c5', moveSan: 'c5', childFen: 'b' }] },
        b: { fen: 'b', edges: [] },
      },
      meta: { nodeCount: 3, edgeCount: 2, maxDepth: 2 },
    };
    const { container } = renderWithProviders(
      <RepertoireTreeView tree={tree} lines={lines} side="black" />,
    );
    const moves = Array.from(container.querySelectorAll('.review-move'));
    // 2 хода: 1.e4 (бот для black-user), 1...c5 (user).
    const statuses = moves.map((el) => el.getAttribute('data-status'));
    expect(statuses).toContain('bot'); // ход белых
    expect(statuses).toContain('mastered'); // ход чёрных = user, статус из progress
    expect(statuses).not.toContain('not-played'); // мы поставили статус для c5
  });

  it('KS-3308: при side=white всё наоборот — белые ходы user, чёрные нейтральные', () => {
    const lines: OpeningLineProgressDto[] = [
      makeLine({ pathUci: ['e2e4'], status: 'mastered' }),
    ];
    const tree: RepertoireTree = {
      rootFen: 'start',
      nodes: {
        start: { fen: 'start', edges: [{ moveUci: 'e2e4', moveSan: 'e4', childFen: 'a' }] },
        a: { fen: 'a', edges: [{ moveUci: 'c7c5', moveSan: 'c5', childFen: 'b' }] },
        b: { fen: 'b', edges: [] },
      },
      meta: { nodeCount: 3, edgeCount: 2, maxDepth: 2 },
    };
    const { container } = renderWithProviders(
      <RepertoireTreeView tree={tree} lines={lines} side="white" />,
    );
    const moves = Array.from(container.querySelectorAll('.review-move'));
    const statuses = moves.map((el) => el.getAttribute('data-status'));
    expect(statuses).toContain('mastered'); // 1.e4 user
    expect(statuses).toContain('bot');       // 1...c5 нейтральный
  });

  it('KS-3305 acceptance: длинная главная линия без альтернатив рендерится плоско', () => {
    // 10-ходовая линия 1.c4 e6 2.g3 d5 3.Bg2 dxc4 4.Nf3 a6 5.Qc2 b5 …
    const buildLongTree = (): RepertoireTree => {
      const edges = [
        { moveUci: 'c2c4', moveSan: 'c4', childFen: 'f1' },
        { moveUci: 'e7e6', moveSan: 'e6', childFen: 'f2' },
        { moveUci: 'g2g3', moveSan: 'g3', childFen: 'f3' },
        { moveUci: 'd7d5', moveSan: 'd5', childFen: 'f4' },
        { moveUci: 'f1g2', moveSan: 'Bg2', childFen: 'f5' },
        { moveUci: 'd5c4', moveSan: 'dxc4', childFen: 'f6' },
        { moveUci: 'g1f3', moveSan: 'Nf3', childFen: 'f7' },
        { moveUci: 'a7a6', moveSan: 'a6', childFen: 'f8' },
        { moveUci: 'd1c2', moveSan: 'Qc2', childFen: 'f9' },
        { moveUci: 'b7b5', moveSan: 'b5', childFen: 'f10' },
      ];
      const nodes: RepertoireTree['nodes'] = {
        start: { fen: 'start', edges: [edges[0]] },
      };
      for (let i = 0; i < edges.length; i++) {
        const nextEdges = i + 1 < edges.length ? [edges[i + 1]] : [];
        nodes[edges[i].childFen] = { fen: edges[i].childFen, edges: nextEdges };
      }
      return {
        rootFen: 'start',
        nodes,
        meta: { nodeCount: 11, edgeCount: 10, maxDepth: 10 },
      };
    };
    const { container } = renderWithProviders(
      <RepertoireTreeView tree={buildLongTree()} lines={[]} />,
    );
    const moves = container.querySelectorAll('.review-move');
    // Все 10 ходов в одном flex-flow без вложенных контейнеров с
    // padding-left на каждом уровне (это и есть отказ от «лесенки»).
    expect(moves.length).toBe(10);
    // Нет brackets — нет альтернатив.
    const brackets = container.querySelectorAll('.review-bracket');
    expect(brackets.length).toBe(0);
  });
});
