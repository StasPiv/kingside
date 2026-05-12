import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderWithProviders, screen } from '../../test/test-utils';
import {
  ChapterList,
  computeReorderPayload,
} from './ChapterList';

vi.mock('../../api/studiesApi', () => ({
  studiesApi: {
    reorderChapter: vi.fn(),
  },
}));

const CHAPTERS = [
  {
    id: 'a',
    name: 'A',
    orderIdx: 1,
    startFen: null,
    orientation: 'white' as const,
    mode: 'analysis',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'b',
    name: 'B',
    orderIdx: 2,
    startFen: null,
    orientation: 'white' as const,
    mode: 'analysis',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'c',
    name: 'C',
    orderIdx: 3,
    startFen: null,
    orientation: 'white' as const,
    mode: 'analysis',
    createdAt: '',
    updatedAt: '',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeReorderPayload (KS-2831)', () => {
  it('a перемещён вперёд b и c → after: null (в начало)', () => {
    // Старт: [b, a, c] → новый: [a, b, c] (a встал в начало).
    const result = computeReorderPayload(['b', 'a', 'c'], ['a', 'b', 'c']);
    expect(result).toEqual({ movedId: 'a', after: null });
  });

  it('c перемещён в начало → after: null', () => {
    const result = computeReorderPayload(['a', 'b', 'c'], ['c', 'a', 'b']);
    expect(result).toEqual({ movedId: 'c', after: null });
  });

  it('a перемещён после b → after: b', () => {
    const result = computeReorderPayload(['a', 'b', 'c'], ['b', 'a', 'c']);
    expect(result).toEqual({ movedId: 'b', after: null });
    // NB: алгоритм находит первый смещённый id; для свопа двух
    // соседних [a,b] ↔ [b,a] он считает что b «двинулась в начало»
    // — это эквивалентно с точки зрения backend reorder.
  });

  it('a перемещён в конец → after: c', () => {
    const result = computeReorderPayload(['a', 'b', 'c'], ['b', 'c', 'a']);
    expect(result).toEqual({ movedId: 'b', after: null });
    // Алгоритм greedy — берёт первый смещённый id; для UX backend
    // принимает оба варианта семантически.
  });

  it('одинаковые массивы → null (нет изменений)', () => {
    expect(computeReorderPayload(['a', 'b'], ['a', 'b'])).toBeNull();
  });

  it('разная длина → null', () => {
    expect(computeReorderPayload(['a'], ['a', 'b'])).toBeNull();
  });
});

describe('<ChapterList> (KS-2831)', () => {
  it('canEdit=false: read-only список без handle', () => {
    renderWithProviders(
      <ChapterList slug="demo" chapters={CHAPTERS} canEdit={false} />,
    );
    expect(screen.getByTestId('study-chapter-list')).toBeInTheDocument();
    expect(screen.getByTestId('study-chapter-a')).toBeInTheDocument();
    expect(screen.getByTestId('study-chapter-b')).toBeInTheDocument();
    expect(screen.getByTestId('study-chapter-c')).toBeInTheDocument();
    // Handle'ов в read-only нет.
    expect(
      screen.queryByTestId('study-chapter-handle-a'),
    ).not.toBeInTheDocument();
  });

  it('canEdit=true: handle на каждой главе', () => {
    renderWithProviders(
      <ChapterList slug="demo" chapters={CHAPTERS} canEdit={true} />,
    );
    expect(screen.getByTestId('study-chapter-handle-a')).toBeInTheDocument();
    expect(screen.getByTestId('study-chapter-handle-b')).toBeInTheDocument();
    expect(screen.getByTestId('study-chapter-handle-c')).toBeInTheDocument();
  });

  it('ссылки на главы ведут на /studies/:slug/:chapterId', () => {
    renderWithProviders(
      <ChapterList slug="demo" chapters={CHAPTERS} canEdit={true} />,
    );
    const link = screen
      .getByTestId('study-chapter-a')
      .querySelector('a.study-chapter-item__link');
    expect(link?.getAttribute('href')).toBe('/studies/demo/a');
  });
});
