/**
 * KS-2561: тесты `useInfinitePuzzles`. Проверяем cursor pagination,
 * race-guard на смене фильтров, локальные операции (remove/patch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

import { useInfinitePuzzles } from './useInfinitePuzzles';

const PUZZLE_A = {
  id: 'a',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moves: ['e2e4'],
  rating: 1500,
  themes: ['mateIn1'],
  source: 'lichess',
  sourceId: null,
  sourceMoveNum: null,
  sourceMetadata: null,
  createdAt: '2026-05-07T10:00:00Z',
};
const PUZZLE_B = { ...PUZZLE_A, id: 'b' };
const PUZZLE_C = { ...PUZZLE_A, id: 'c' };

/**
 * Helper: фильтрует mock.calls по типу запроса. После KS-3894 хук
 * параллельно с `/puzzles/browse` дёргает `/puzzles/browse/count`
 * (approx + exact). Существующие тесты, проверяющие порядок и
 * количество вызовов `apiGet`, опираются именно на browse-вызовы.
 */
function browseCalls(): unknown[][] {
  return apiGet.mock.calls.filter(
    (c) =>
      typeof c[0] === 'string' && !(c[0] as string).startsWith('/puzzles/browse/count'),
  );
}

beforeEach(() => {
  apiGet.mockReset();
  // KS-3894. Дефолт для `/puzzles/browse/count`: «висящий» Promise.
  // Тесты, не интересующиеся approx/exact-count, не указывают для
  // этих запросов `mockResolvedValueOnce` — `mockImplementation`
  // ловит их. Очередь `mockResolvedValueOnce` имеет приоритет над
  // `mockImplementation`, поэтому существующие тесты на /browse
  // и loadMore продолжают работать как раньше: first-once → init,
  // second-once → loadMore.
  apiGet.mockImplementation((path: unknown) => {
    if (
      typeof path === 'string' &&
      path.startsWith('/puzzles/browse/count')
    ) {
      // Никогда не резолвится — count-логика в этих тестах не
      // тестируется и не должна влиять на total.
      return new Promise<never>(() => {});
    }
    // Дефолт для /browse, если тест не выставил mockResolvedValueOnce.
    return Promise.resolve({ data: [], nextCursor: null });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInfinitePuzzles KS-2561', () => {
  it('первичный fetch загружает первую страницу', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A, PUZZLE_B],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() => useInfinitePuzzles({ limit: 2 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    // KS-3894: api.get теперь принимает второй аргумент {signal}.
    expect(browseCalls()[0][0]).toBe('/puzzles/browse?limit=2');
  });

  it('loadMore догружает следующую страницу с cursor', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() => useInfinitePuzzles({ limit: 1 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_B],
      nextCursor: null,
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
    expect(apiGet).toHaveBeenLastCalledWith(
      '/puzzles/browse?limit=1&cursor=cur1',
    );
  });

  it('hasMore=false при nextCursor=null с первого ответа', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: null });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it('передаёт фильтры в query (themes ANY-of через запятую)', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfinitePuzzles({
        ratingMin: 1200,
        ratingMax: 1800,
        themes: ['mateIn1', 'fork'],
        mine: true,
        hideSolved: true,
        source: 'lichess',
        visibility: 'draft',
        limit: 30,
      }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/limit=30/);
    expect(url).toMatch(/ratingMin=1200/);
    expect(url).toMatch(/ratingMax=1800/);
    expect(url).toMatch(/themes=mateIn1%2Cfork|themes=mateIn1,fork/);
    expect(url).toMatch(/mine=true/);
    expect(url).toMatch(/hideSolved=true/);
    expect(url).toMatch(/source=lichess/);
    expect(url).toMatch(/visibility=draft/);
  });

  it('KS-3657: minMaiaWeakChoiceProb > 0 → передаётся в query', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfinitePuzzles({ minMaiaWeakChoiceProb: 0.5, limit: 10 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/minMaiaWeakChoiceProb=0\.5/);
  });

  it('KS-3657: minMaiaWeakChoiceProb=0 → параметр НЕ передаётся (0 трактуется как «без фильтра»)', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfinitePuzzles({ minMaiaWeakChoiceProb: 0, limit: 10 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).not.toMatch(/minMaiaWeakChoiceProb/);
  });

  it('KS-3665: maxMaiaWeakChoiceProb < 1 → передаётся в query', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfinitePuzzles({ maxMaiaWeakChoiceProb: 0.7, limit: 10 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/maxMaiaWeakChoiceProb=0\.7/);
  });

  it('KS-3665: maxMaiaWeakChoiceProb=1 → параметр НЕ передаётся (1 = без верхней границы)', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfinitePuzzles({ maxMaiaWeakChoiceProb: 1, limit: 10 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).not.toMatch(/maxMaiaWeakChoiceProb/);
  });

  it('KS-3665: min и max вместе → оба параметра в query', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    renderHook(() =>
      useInfinitePuzzles({
        minMaiaWeakChoiceProb: 0.3,
        maxMaiaWeakChoiceProb: 0.7,
        limit: 10,
      }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/minMaiaWeakChoiceProb=0\.3/);
    expect(url).toMatch(/maxMaiaWeakChoiceProb=0\.7/);
  });

  it('KS-3672: total из ответа /puzzles/browse прокидывается в state', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: null,
      total: 42,
    });
    const { result } = renderHook(() => useInfinitePuzzles({ limit: 10 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.total).toBe(42);
  });

  it('KS-3672: backend не прислал total → state = null (fallback', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: null,
    });
    const { result } = renderHook(() => useInfinitePuzzles({ limit: 10 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.total).toBeNull();
  });

  it('KS-3892: loadMore с total=null НЕ перезаписывает total с первой страницы', async () => {
    // KS-3891 backend: COUNT(*) только на первой странице, чтобы не
    // делать тяжёлый запрос на каждом скроллинге. На последующих
    // страницах backend возвращает `total: null`. Хук должен сохранить
    // значение, пришедшее с первой страницы.
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
      total: 137,
    });
    const { result } = renderHook(() => useInfinitePuzzles({ limit: 1 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.total).toBe(137);

    // Вторая страница: backend (после KS-3891) присылает total: null.
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_B],
      nextCursor: 'cur2',
      total: null,
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
    // Главное: счётчик «Найдено: 137» не сбросился.
    expect(result.current.total).toBe(137);

    // Третья страница: total: null (вариант — поле вообще отсутствует).
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_C],
      nextCursor: null,
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.total).toBe(137);
  });

  it('KS-3672: смена фильтров → total сбрасывается до прихода нового ответа', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: null,
      total: 42,
    });
    const { result, rerender } = renderHook(
      ({ filters }: { filters: Parameters<typeof useInfinitePuzzles>[0] }) =>
        useInfinitePuzzles(filters),
      {
        initialProps: {
          filters: { limit: 10 } as Parameters<typeof useInfinitePuzzles>[0],
        },
      },
    );
    await waitFor(() => expect(result.current.total).toBe(42));

    // Новые фильтры → effect успевает обнулить total до прихода ответа.
    // Используем "висящий" промис, чтобы зафиксировать промежуточное
    // состояние total=null между сбросом и следующим успехом.
    let resolveSecond: (v: unknown) => void = () => {};
    apiGet.mockReturnValueOnce(
      new Promise((res) => {
        resolveSecond = res;
      }),
    );
    rerender({
      filters: { limit: 10, minMaiaWeakChoiceProb: 0.5 } as Parameters<
        typeof useInfinitePuzzles
      >[0],
    });
    await waitFor(() => expect(result.current.total).toBeNull());
    resolveSecond({ data: [PUZZLE_B], nextCursor: null, total: 7 });
    await waitFor(() => expect(result.current.total).toBe(7));
  });

  it('KS-3657: смена minMaiaWeakChoiceProb → новый запрос', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    const { rerender } = renderHook(
      ({ filters }: { filters: Parameters<typeof useInfinitePuzzles>[0] }) =>
        useInfinitePuzzles(filters),
      {
        initialProps: {
          filters: { minMaiaWeakChoiceProb: 0.3 } as Parameters<
            typeof useInfinitePuzzles
          >[0],
        },
      },
    );
    await waitFor(() => expect(browseCalls()).toHaveLength(1));
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    rerender({
      filters: { minMaiaWeakChoiceProb: 0.7 } as Parameters<
        typeof useInfinitePuzzles
      >[0],
    });
    await waitFor(() => expect(browseCalls()).toHaveLength(2));
    expect(browseCalls()[0][0] as string).toMatch(
      /minMaiaWeakChoiceProb=0\.3/,
    );
    expect(browseCalls()[1][0] as string).toMatch(
      /minMaiaWeakChoiceProb=0\.7/,
    );
  });

  it('KS-2586: смена visibility → новый запрос с другим параметром', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    const { rerender } = renderHook(
      ({ filters }: { filters: Parameters<typeof useInfinitePuzzles>[0] }) =>
        useInfinitePuzzles(filters),
      {
        initialProps: {
          filters: {
            visibility: 'draft',
          } as Parameters<typeof useInfinitePuzzles>[0],
        },
      },
    );
    await waitFor(() => expect(browseCalls()).toHaveLength(1));
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null });
    rerender({
      filters: {
        visibility: 'public',
      } as Parameters<typeof useInfinitePuzzles>[0],
    });
    await waitFor(() => expect(browseCalls()).toHaveLength(2));
    expect(browseCalls()[0][0] as string).toMatch(/visibility=draft/);
    expect(browseCalls()[1][0] as string).toMatch(/visibility=public/);
  });

  it('смена фильтров → новый запрос без cursor (reset)', async () => {
    apiGet.mockResolvedValueOnce({ data: [PUZZLE_A], nextCursor: 'cur1' });
    const { result, rerender } = renderHook(
      ({ filters }: { filters: Parameters<typeof useInfinitePuzzles>[0] }) =>
        useInfinitePuzzles(filters),
      { initialProps: { filters: { ratingMin: 1000 } } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({ data: [PUZZLE_C], nextCursor: null });
    rerender({ filters: { ratingMin: 2000 } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Список заменён, не дополнен (reset).
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['c']);
    expect(browseCalls()[1][0]).toBe(
      '/puzzles/browse?limit=30&ratingMin=2000',
    );
  });

  it('removeLocally удаляет пазл из state', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A, PUZZLE_B],
      nextCursor: null,
    });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.removeLocally('a'));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['b']);
  });

  it('patchLocally обновляет одно поле пазла', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: null,
    });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.patchLocally('a', { isPublic: true }));
    expect(result.current.puzzles[0].isPublic).toBe(true);
  });

  it('KS-2565: backend возвращает тот же cursor что получил → hasMore=false (защита от цикла)', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Backend "глюкает" и возвращает тот же cursor, который мы послали.
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_B],
      nextCursor: 'cur1',
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('KS-2565: повторный loadMore с тем же cursor → no-op, hasMore=false', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_B],
      nextCursor: 'cur2',
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    // Симулируем багу retry-effect: cursor не успел обновиться, мы
    // снова дёргаем loadMore с тем же cur1. Гард `lastUsedCursorRef`
    // должен поймать это: запрос НЕ должен уйти.
    // (cursorRef сейчас = cur2; чтобы сэмулировать «зависший cur1»,
    // фейкаем — на самом деле гард срабатывает и при попытке повторно
    // переслать любой ранее использованный cursor. Здесь убеждаемся,
    // что после успешного loadMore lastUsedCursor == cur1, и backend
    // ответ с nextCursor=cur2 НЕ перезапишет lastUsedCursor — так что
    // если cur1 опять попадёт в cursorRef, loadMore не пошлёт его).
    expect(browseCalls()).toHaveLength(2);
    // Третий вызов loadMore без подмены cursor → cur2 ≠ lastUsed=cur1,
    // запрос уйдёт. Проверяем что cycle не возникает.
    apiGet.mockResolvedValueOnce({
      data: [],
      nextCursor: null,
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(browseCalls()).toHaveLength(3);
    expect(result.current.hasMore).toBe(false);
  });

  it('KS-2565: одновременные loadMore (двойной retry) → один запрос', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
    });
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));

    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_B],
      nextCursor: 'cur2',
    });
    // Двойной synchronous loadMore — типичный сценарий: retry-effect и
    // observer cb стрельнули почти одновременно. Только один уйдёт в
    // сеть благодаря `loadingMore`-guard'у.
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    // 1 initial + 1 loadMore = 2 запроса всего, не 3.
    expect(browseCalls()).toHaveLength(2);
  });

  // === KS-3894: параллельные /browse + /browse/count?approx + /browse/count

  it('KS-3894: при инициализации стартуют 3 параллельных запроса (browse + approx-count + exact-count)', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
      total: null,
    });
    renderHook(() =>
      useInfinitePuzzles({ source: 'lichess', hideSolved: true, limit: 30 }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    // Должны быть три URL'а.
    const calls = apiGet.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.startsWith('/puzzles/browse?'))).toBe(true);
    expect(
      calls.some(
        (u) =>
          u.startsWith('/puzzles/browse/count?') && u.includes('approx=true'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (u) =>
          u.startsWith('/puzzles/browse/count?') && !u.includes('approx='),
      ),
    ).toBe(true);
  });

  it('KS-3894: фильтры пробрасываются в count-запросы (без limit/cursor)', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null, total: null });
    renderHook(() =>
      useInfinitePuzzles({
        ratingMin: 1200,
        themes: ['mateIn1'],
        hideSolved: true,
        source: 'lichess',
        limit: 30,
      }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const countApproxUrl = (apiGet.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).startsWith('/puzzles/browse/count') &&
        (c[0] as string).includes('approx=true'),
    )?.[0] as string) ?? '';
    expect(countApproxUrl).toMatch(/ratingMin=1200/);
    expect(countApproxUrl).toMatch(/themes=mateIn1/);
    expect(countApproxUrl).toMatch(/hideSolved=true/);
    expect(countApproxUrl).toMatch(/source=lichess/);
    // Никакого limit/cursor в /count.
    expect(countApproxUrl).not.toMatch(/limit=/);
    expect(countApproxUrl).not.toMatch(/cursor=/);
  });

  it('KS-3894: approx-count ставит total и totalApproximate=true', async () => {
    // /browse приходит с total=null (cache miss).
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
      total: null,
    });
    // /count?approx=true приходит быстро.
    apiGet.mockResolvedValueOnce({ total: 200, approximate: true });
    // /count exact — висит (mockImplementation в beforeEach).

    const { result } = renderHook(() =>
      useInfinitePuzzles({ source: 'lichess', limit: 30 }),
    );
    await waitFor(() => expect(result.current.total).toBe(200));
    expect(result.current.totalApproximate).toBe(true);
  });

  it('KS-3894: exact-count перетирает approx и снимает флаг', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
      total: null,
    });
    apiGet.mockResolvedValueOnce({ total: 200, approximate: true });
    apiGet.mockResolvedValueOnce({ total: 137, approximate: false });

    const { result } = renderHook(() =>
      useInfinitePuzzles({ source: 'lichess', limit: 30 }),
    );
    await waitFor(() => expect(result.current.total).toBe(137));
    expect(result.current.totalApproximate).toBe(false);
  });

  it('KS-3894: cache hit total в /browse — флаг approximate=false, approx-ответ не подменяет', async () => {
    // /browse сразу возвращает точное число (Redis cache hit).
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
      total: 42,
    });
    // approx-ответ приходит позже, но НЕ должен подменить.
    apiGet.mockResolvedValueOnce({ total: 100, approximate: true });
    apiGet.mockResolvedValueOnce({ total: 42, approximate: false });

    const { result } = renderHook(() =>
      useInfinitePuzzles({ source: 'lichess', limit: 30 }),
    );
    await waitFor(() => expect(result.current.total).toBe(42));
    // Даже после микротасков approx не должен сбить значение на 100.
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.total).toBe(42);
    expect(result.current.totalApproximate).toBe(false);
  });

  it('KS-3894: approx-ответ опоздал и пришёл после exact → НЕ подменяет точное число', async () => {
    // /browse — total:null (cache miss).
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
      total: null,
    });
    // approx — отложенный (resolve вручную позже).
    let resolveApprox: (v: unknown) => void = () => {};
    apiGet.mockReturnValueOnce(
      new Promise((res) => {
        resolveApprox = res;
      }),
    );
    // exact — приходит сразу.
    apiGet.mockResolvedValueOnce({ total: 137, approximate: false });

    const { result } = renderHook(() =>
      useInfinitePuzzles({ source: 'lichess', limit: 30 }),
    );
    await waitFor(() => expect(result.current.total).toBe(137));

    // Теперь резолвим approx — он уже опоздал.
    act(() => resolveApprox({ total: 200, approximate: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.total).toBe(137);
    expect(result.current.totalApproximate).toBe(false);
  });

  it('KS-3894: loadMore НЕ дёргает /browse/count', async () => {
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
      total: null,
    });
    apiGet.mockResolvedValueOnce({ total: 200, approximate: true });
    apiGet.mockResolvedValueOnce({ total: 137, approximate: false });
    const { result } = renderHook(() =>
      useInfinitePuzzles({ source: 'lichess', limit: 1 }),
    );
    await waitFor(() => expect(result.current.total).toBe(137));

    const countCallsBefore = apiGet.mock.calls.filter(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).startsWith('/puzzles/browse/count'),
    ).length;

    // loadMore → новый /browse, но НЕ /count.
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_B],
      nextCursor: null,
      total: null,
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    const countCallsAfter = apiGet.mock.calls.filter(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).startsWith('/puzzles/browse/count'),
    ).length;
    expect(countCallsAfter).toBe(countCallsBefore);
    // total стабилен на 137 (KS-3892).
    expect(result.current.total).toBe(137);
    expect(result.current.totalApproximate).toBe(false);
  });

  it('KS-3894: смена фильтров отменяет inflight через AbortController', async () => {
    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null, total: null });
    const { rerender } = renderHook(
      ({ filters }: { filters: Parameters<typeof useInfinitePuzzles>[0] }) =>
        useInfinitePuzzles(filters),
      {
        initialProps: {
          filters: {
            source: 'lichess',
            limit: 30,
          } as Parameters<typeof useInfinitePuzzles>[0],
        },
      },
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    // Берём signal'ы count-запросов первого поколения.
    const firstGenInits = apiGet.mock.calls
      .filter(
        (c) =>
          typeof c[0] === 'string' &&
          (c[0] as string).startsWith('/puzzles/browse/count'),
      )
      .map((c) => c[1] as { signal?: AbortSignal });
    expect(firstGenInits.length).toBeGreaterThan(0);
    // До смены — не отменены.
    firstGenInits.forEach((init) => {
      expect(init.signal?.aborted).toBe(false);
    });

    apiGet.mockResolvedValueOnce({ data: [], nextCursor: null, total: null });
    rerender({
      filters: { source: 'lichess', limit: 30, ratingMin: 1500 } as Parameters<
        typeof useInfinitePuzzles
      >[0],
    });

    // После rerender — старые signal'ы должны быть aborted.
    firstGenInits.forEach((init) => {
      expect(init.signal?.aborted).toBe(true);
    });
  });

  it('error устанавливается при отказе API', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useInfinitePuzzles({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.puzzles).toEqual([]);
  });

  it('KS-3122: смена filtersKey пока loadMore inflight сбрасывает loadingMore (раньше залипал на true)', async () => {
    // Initial fetch — есть hasMore.
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_A],
      nextCursor: 'cur1',
    });
    const { result, rerender } = renderHook(
      ({ themes }: { themes?: string[] }) =>
        useInfinitePuzzles({ themes }),
      { initialProps: {} },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Подвешиваем loadMore — promise который никогда не зарезолвится в
    // пределах текущего теста (имитация inflight-запроса в момент смены
    // фильтра). Этот запрос увеличит seqRef, но потом мы поменяем
    // filtersKey — следующий increment seqRef сделает старый ответ
    // невалидным.
    let resolveSlow: (v: unknown) => void = () => {};
    apiGet.mockReturnValueOnce(
      new Promise((res) => {
        resolveSlow = res;
      }),
    );
    act(() => {
      result.current.loadMore();
    });
    // loadingMore стал true, запрос в полёте.
    expect(result.current.loadingMore).toBe(true);

    // Пользователь меняет theme — filtersKey изменился, идёт новый
    // initial-fetch с новыми параметрами.
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_C],
      nextCursor: 'cur2',
    });
    rerender({ themes: ['mateIn1'] });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Главное: loadingMore СБРОШЕН в false, индикатор «Загрузка...»
    // не залипает. Раньше без фикса оставался true навсегда (старый
    // mySeq не совпадает с новым seqRef.current → .finally early-return).
    expect(result.current.loadingMore).toBe(false);
    // Список заменён на отфильтрованные пазлы.
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['c']);

    // Sanity: даже если старый запрос всё-таки зарезолвится — он не
    // должен подмешать данные в новый список (race-guard через seqRef).
    apiGet.mockResolvedValueOnce({
      data: [PUZZLE_C, PUZZLE_A],
      nextCursor: 'cur3',
    });
    act(() => {
      resolveSlow({ data: [PUZZLE_B], nextCursor: 'old-cur' });
    });
    await waitFor(() =>
      expect(result.current.puzzles.map((p) => p.id)).toEqual(['c']),
    );
    expect(result.current.loadingMore).toBe(false);

    // Новый loadMore работает: после фикса разблокировано (раньше
    // `if (loadingMore) return` блокировал).
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.puzzles.map((p) => p.id)).toEqual(['c', 'c', 'a']);
  });
});
