import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen, userEvent } from '../../test/test-utils';
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
      edges: [
        { moveUci: 'e2e4', moveSan: 'e4', childFen: 'after-e4' },
      ],
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

describe('RepertoireTreeView (KS-3296 F2)', () => {
  it('рендерит каждый edge как строку с цвет-чипом по статусу', () => {
    const lines: OpeningLineProgressDto[] = [
      makeLine({ pathUci: ['e2e4'], status: 'mastered' }),
      makeLine({ pathUci: ['e2e4', 'c7c5'], status: 'due' }),
      makeLine({ pathUci: ['e2e4', 'e7e5'], status: 'wrong' }),
    ];
    renderWithProviders(<RepertoireTreeView tree={makeTree()} lines={lines} />);
    expect(screen.getByTestId('opening-trainer-tree')).toBeInTheDocument();
    expect(screen.getByTestId('opening-trainer-tree-row-mastered')).toBeInTheDocument();
    expect(screen.getByTestId('opening-trainer-tree-row-due')).toBeInTheDocument();
    expect(screen.getByTestId('opening-trainer-tree-row-wrong')).toBeInTheDocument();
  });

  it('линии без записи в lines имеют статус not-played', () => {
    renderWithProviders(<RepertoireTreeView tree={makeTree()} lines={[]} />);
    // 3 edges всего, без progress = все not-played.
    expect(
      screen.getAllByTestId('opening-trainer-tree-row-not-played').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('orphan-линии не отрисовываются', () => {
    const lines: OpeningLineProgressDto[] = [
      makeLine({ pathUci: ['e2e4'], status: 'mastered', orphaned: true }),
    ];
    renderWithProviders(<RepertoireTreeView tree={makeTree()} lines={lines} />);
    expect(
      screen.queryByTestId('opening-trainer-tree-row-mastered'),
    ).toBeNull();
  });

  it('клик по edge открывает tooltip с counters', async () => {
    const lines: OpeningLineProgressDto[] = [
      makeLine({
        pathUci: ['e2e4'],
        status: 'learning',
        correctCount: 2,
        wrongCount: 1,
        consecutiveCorrect: 1,
      }),
    ];
    renderWithProviders(<RepertoireTreeView tree={makeTree()} lines={lines} />);
    const row = screen.getByTestId('opening-trainer-tree-row-learning');
    const btn = row.querySelector('button')!;
    await userEvent.click(btn);
    const tip = screen.getByTestId('opening-trainer-tree-tooltip');
    expect(tip.textContent).toContain('2'); // correctCount
    expect(tip.textContent).toContain('1'); // wrongCount
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
});
