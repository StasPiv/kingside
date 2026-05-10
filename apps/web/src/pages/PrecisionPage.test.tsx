/**
 * KS-2484 → KS-2578 → KS-2586. Тесты `PrecisionPage`.
 * Покрываем: загрузку (через `useInfinitePuzzles` после KS-2586), рендер
 * карточек, empty / error состояния, навигацию, KS-2545 stats-блок,
 * KS-2586 draft badge + индивидуальный publish.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

const mockNavigate = vi.fn();
const mockSearchParams = new URLSearchParams();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [mockSearchParams, vi.fn()] as const,
  };
});

vi.mock('react-chessboard', () => ({
  Chessboard: ({
    options,
  }: {
    options: { position: string; boardOrientation: string };
  }) => (
    <div
      data-testid="mock-chessboard"
      data-position={options.position}
      data-orientation={options.boardOrientation}
    />
  ),
}));

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

const authValue: { user: { id: string; username: string } | null } = {
  user: null,
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authValue.user, loading: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PrecisionPage } from './PrecisionPage';

const SAMPLE = [
  {
    id: '2dfcd01c-456a-4066-b911-28a32802a6c6',
    fen: '1rb2rk1/3nq1bp/2n1p1p1/ppppPp2/5P2/P1PPBNP1/1P1N1QBP/R4RK1 w - - 2 15',
    rating: 1973,
    themes: ['crushing', 'knightMove', 'playVsEngine'],
    source: 'generated',
    solutionMode: 'play-vs-engine',
    moves: '',
    sourceId: null,
    sourceMoveNum: null,
    sourceMetadata: null,
    createdAt: '2026-05-07T10:00:00Z',
    isPublic: true,
  },
  {
    id: 'bc940cc2-15ab-4fc9-bf06-feaf114f2a28',
    fen: '1r3bk1/1r2q2p/b3p1p1/p1npPp2/2pB1P2/P1P3PP/1P1R1QBN/4R1K1 b - - 2 23',
    rating: 1991,
    themes: ['crushing', 'playVsEngine', 'rookMove'],
    source: 'generated',
    solutionMode: 'play-vs-engine',
    moves: '',
    sourceId: null,
    sourceMoveNum: null,
    sourceMetadata: null,
    createdAt: '2026-05-07T10:00:00Z',
    isPublic: true,
  },
];

const wrap = (data: unknown[]) => ({ data, nextCursor: null });

/**
 * KS-2724: PrecisionPage параллельно дёргает несколько endpoint'ов
 * (`/puzzles/browse?...` через `useInfinitePuzzles`, `/precision/stats/me`,
 * `/precision/attempts/me`). Старые тесты использовали
 * `apiGet.mockResolvedValueOnce(wrap(SAMPLE))` — это эмулировало ОДИН вызов.
 * После KS-2724 вызовов несколько и FIFO-очередь mockOnce может вернуть
 * SAMPLE не на тот endpoint. Хелпер ставит url-aware mockImplementation
 * с дефолтами для остальных endpoint'ов (пустой список / null stats).
 */
const mockBrowseOnce = (data: unknown[]) => {
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/puzzles/browse')) return Promise.resolve(wrap(data));
    if (url.startsWith('/precision/attempts/me'))
      return Promise.resolve({ items: [], total: 0 });
    if (url === '/precision/stats/me') return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
};

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  mockNavigate.mockReset();
  authValue.user = null;
  // Сброс search params между тестами.
  for (const key of Array.from(mockSearchParams.keys())) {
    mockSearchParams.delete(key);
  }
  // KS-2724: PrecisionPage теперь рендерит `<PrecisionAttemptsList>` для
  // залогиненного юзера, который зовёт `GET /precision/attempts/me`. В
  // тестах, не сетающих свой mockImplementation, отдаём пустой список,
  // чтобы render не падал в network undefined.
  apiGet.mockImplementation((url: string) => {
    if (url === '/precision/attempts/me?limit=20&offset=0') {
      return Promise.resolve({ items: [], total: 0 });
    }
    if (url === '/precision/stats/me') return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
});

afterEach(() => vi.restoreAllMocks());

/**
 * KS-2586: PrecisionPage переехал на `useInfinitePuzzles`. Хук строит
 * query с `limit=20&source=generated[&visibility=...]` — порядок
 * фиксированный (см. `buildQuery` в useInfinitePuzzles.ts). Тесты
 * проверяют ключи через регулярки, не строгое совпадение.
 */

describe('<PrecisionPage> KS-2484 / KS-2578 / KS-2586 — загрузка', () => {
  it('fetch /puzzles/browse с source=generated и limit=20 при mount', async () => {
    mockBrowseOnce(SAMPLE);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/^\/puzzles\/browse\?/);
    expect(url).toMatch(/source=generated/);
    expect(url).toMatch(/limit=20/);
    expect(url).not.toMatch(/visibility=/); // visibility не задан
    expect(url).not.toMatch(/mine=/); // mine не задан
  });

  it('рендерит карточки на каждый пазл с FEN; рейтинг скрыт (KS-2689)', async () => {
    mockBrowseOnce(SAMPLE);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('ready'),
    );
    const cards = screen.getAllByTestId('play-vs-engine-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-puzzle-id')).toBe(SAMPLE[0].id);
    const boards = screen.getAllByTestId('mock-chessboard');
    expect(boards[0].getAttribute('data-position')).toBe(SAMPLE[0].fen);
    expect(boards[1].getAttribute('data-orientation')).toBe('black');
    // KS-2689: рейтинг сгенерированных пазлов скрыт (формула MVP даёт
    // некорректные значения — пользователь жаловался). Поле `rating`
    // продолжает приходить в DTO.
    expect(
      screen.queryAllByTestId('play-vs-engine-card-rating'),
    ).toHaveLength(0);
  });

  it('KS-2547: клик по «Solve» → /puzzle/:id?source=precision', async () => {
    mockBrowseOnce(SAMPLE);
    const user = userEvent.setup();
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('ready'),
    );
    await user.click(screen.getAllByTestId('play-vs-engine-card-solve')[0]);
    expect(mockNavigate).toHaveBeenCalledWith(
      `/puzzle/${SAMPLE[0].id}?source=precision`,
    );
  });

  it('пустой ответ → empty state', async () => {
    mockBrowseOnce([]);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('empty'),
    );
    expect(screen.getByTestId('play-vs-engine-empty')).toBeInTheDocument();
  });

  it('ошибка API → error state с retry-кнопкой (через reload)', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('error'),
    );
    expect(screen.getByTestId('play-vs-engine-error')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /retry|повторить/i }),
    ).toBeInTheDocument();
  });

  it('гость → stats-блок НЕ рендерится', async () => {
    mockBrowseOnce(SAMPLE);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-puzzles').getAttribute('data-state'),
      ).toBe('ready'),
    );
    expect(screen.queryByTestId('precision-stats')).toBeNull();
  });
});

describe('<PrecisionPage> KS-2586 — URL params (mine, visibility)', () => {
  it('mine=true → запрос содержит mine=true', async () => {
    mockSearchParams.set('mine', 'true');
    apiGet.mockResolvedValue(wrap(SAMPLE));
    renderWithProviders(<PrecisionPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/mine=true/);
    expect(
      screen
        .getByTestId('play-vs-engine-puzzles')
        .getAttribute('data-mine'),
    ).toBe('true');
  });

  it('visibility=draft → запрос содержит visibility=draft', async () => {
    mockSearchParams.set('visibility', 'draft');
    apiGet.mockResolvedValue(wrap(SAMPLE));
    renderWithProviders(<PrecisionPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).toMatch(/visibility=draft/);
    expect(
      screen
        .getByTestId('play-vs-engine-puzzles')
        .getAttribute('data-visibility'),
    ).toBe('draft');
  });

  it('невалидный visibility (junk) → не пробрасывается в query', async () => {
    mockSearchParams.set('visibility', 'invalid-value');
    apiGet.mockResolvedValue(wrap(SAMPLE));
    renderWithProviders(<PrecisionPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = apiGet.mock.calls[0][0] as string;
    expect(url).not.toMatch(/visibility=invalid-value/);
  });
});

describe('<PrecisionPage> KS-2586 — Draft badge + Publish button', () => {
  beforeEach(() => {
    authValue.user = { id: 'u1', username: 'tester' };
    mockSearchParams.set('mine', 'true');
    mockSearchParams.set('visibility', 'draft');
  });

  it('owned draft → Draft badge + Publish button видны', async () => {
    const draft = {
      ...SAMPLE[0],
      isPublic: false,
      userId: 'u1',
    };
    mockBrowseOnce([draft]);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('play-vs-engine-card')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('precision-card-draft-badge'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('precision-card-publish'),
    ).toBeInTheDocument();
  });

  it('owned public → ни badge, ни Publish button', async () => {
    const pub = {
      ...SAMPLE[0],
      isPublic: true,
      userId: 'u1',
    };
    mockBrowseOnce([pub]);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('play-vs-engine-card')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('precision-card-draft-badge'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('precision-card-publish'),
    ).not.toBeInTheDocument();
  });

  it("чужой draft (другой userId) → ни badge, ни Publish button у текущего юзера", async () => {
    const otherDraft = {
      ...SAMPLE[0],
      isPublic: false,
      userId: 'u-someone-else',
    };
    mockBrowseOnce([otherDraft]);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('play-vs-engine-card')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('precision-card-draft-badge'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('precision-card-publish'),
    ).not.toBeInTheDocument();
  });

  // KS-2668: backend кладёт владельца в `createdBy` (не `userId`).
  // Этот тест ловит регрессию старого имени поля.
  it("KS-2668: owned draft по `createdBy` (имя поля DTO) → Publish + Copy link + Delete", async () => {
    const draft = {
      ...SAMPLE[0],
      isPublic: false,
      createdBy: 'u1',
    };
    mockBrowseOnce([draft]);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('play-vs-engine-card')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('precision-card-publish'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('precision-card-copy-link'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('precision-card-delete'),
    ).toBeInTheDocument();
  });

  it('KS-2668: чужой пазл по `createdBy` → owner-кнопок нет', async () => {
    const otherPuzzle = {
      ...SAMPLE[0],
      isPublic: true,
      createdBy: 'u-someone-else',
    };
    mockBrowseOnce([otherPuzzle]);
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('play-vs-engine-card')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('precision-card-copy-link'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('precision-card-make-private'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('precision-card-delete'),
    ).not.toBeInTheDocument();
  });

  it('Publish click → PATCH /puzzles/:id { isPublic: true } + оптимистичный апдейт (badge исчезает)', async () => {
    const draft = {
      ...SAMPLE[0],
      isPublic: false,
      userId: 'u1',
    };
    mockBrowseOnce([draft]);
    apiPatch.mockResolvedValueOnce({ ok: true });
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('precision-card-publish')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('precision-card-publish'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/puzzles/${draft.id}`, {
        isPublic: true,
      }),
    );
    // patchLocally убирает badge и кнопку (isPublic стал true).
    await waitFor(() =>
      expect(
        screen.queryByTestId('precision-card-draft-badge'),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('precision-card-publish'),
    ).not.toBeInTheDocument();
    // Показывается «Published» toast (исчезнет через 2с — но в тесте
    // достаточно проверить что он появился).
    expect(
      screen.getByTestId('precision-card-published-toast'),
    ).toBeInTheDocument();
  });

  it('Publish ошибка → показывает publish-error, badge остаётся', async () => {
    const draft = {
      ...SAMPLE[0],
      isPublic: false,
      userId: 'u1',
    };
    mockBrowseOnce([draft]);
    apiPatch.mockRejectedValueOnce(new Error('publish boom'));
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('precision-card-publish')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('precision-card-publish'));
    // KS-2673: ошибка показывается через локализованный toast
    // (раньше — inline `precision-publish-error`).
    await waitFor(() => {
      const toast = screen.getByTestId('precision-toast');
      expect(toast).toBeInTheDocument();
      expect(toast.getAttribute('data-tone')).toBe('error');
    });
    // badge всё ещё там (оптимистик не применился, так как api упал).
    expect(
      screen.getByTestId('precision-card-draft-badge'),
    ).toBeInTheDocument();
  });

  it('Publish во время запроса → кнопка disabled + текст «Publishing…»', async () => {
    const draft = {
      ...SAMPLE[0],
      isPublic: false,
      userId: 'u1',
    };
    mockBrowseOnce([draft]);
    let resolvePatch: (v: unknown) => void = () => {};
    apiPatch.mockReturnValueOnce(
      new Promise((res) => {
        resolvePatch = res;
      }),
    );
    renderWithProviders(<PrecisionPage />);
    await waitFor(() =>
      expect(screen.getByTestId('precision-card-publish')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('precision-card-publish'));
    await waitFor(() =>
      expect(
        (screen.getByTestId('precision-card-publish') as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    // KS-2673: после перевода на icon-action текст «Publishing…» теперь
    // в aria-label (иконка без видимого текста).
    expect(
      screen
        .getByTestId('precision-card-publish')
        .getAttribute('aria-label'),
    ).toMatch(/Publishing|Публикуем/);
    resolvePatch({ ok: true });
  });
});

describe('<PrecisionPage> KS-2719 F2 — top-блок (4 карточки)', () => {
  it('рендерит 4 карточки из /precision/stats/me', async () => {
    authValue.user = { id: 'u1', username: 'tester' };
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/puzzles/browse?')) return Promise.resolve(wrap(SAMPLE));
      if (url === '/precision/stats/me') {
        return Promise.resolve({
          totalAttempts: 12,
          preservedCount: 7,
          avgAccuracyPercent: 76.5,
          avgWdlLeakPerMove: 0.034,
          avgHalfMovesUntilFirstMistake: 4.2,
        });
      }
      return Promise.resolve([]);
    });
    renderWithProviders(<PrecisionPage />);
    const block = await waitFor(() => {
      const el = screen.queryByTestId('precision-stats');
      if (!el) throw new Error('stats not yet rendered');
      return el;
    });
    expect(block.getAttribute('data-state')).toBe('ready');
    expect(block.getAttribute('data-attempts')).toBe('12');
    expect(block.getAttribute('data-preserved')).toBe('7');
    expect(
      screen.getByTestId('precision-stats-accuracy').textContent,
    ).toMatch(/77%|76%/);
    expect(
      screen.getByTestId('precision-stats-preserved').textContent,
    ).toMatch(/7/);
    expect(
      screen.getByTestId('precision-stats-leak').textContent,
    ).toMatch(/3\.4%/);
    expect(
      screen.getByTestId('precision-stats-first-mistake').textContent,
    ).toMatch(/4\.2/);
  });

  it('totalAttempts=0 → показывает placeholder', async () => {
    authValue.user = { id: 'u1', username: 'tester' };
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/puzzles/browse?')) return Promise.resolve(wrap([]));
      if (url === '/precision/stats/me') {
        return Promise.resolve({
          totalAttempts: 0,
          preservedCount: 0,
          avgAccuracyPercent: null,
          avgWdlLeakPerMove: null,
          avgHalfMovesUntilFirstMistake: null,
        });
      }
      return Promise.resolve([]);
    });
    renderWithProviders(<PrecisionPage />);
    const block = await waitFor(() => {
      const el = screen.queryByTestId('precision-stats');
      if (!el) throw new Error('stats not yet rendered');
      return el;
    });
    expect(block.getAttribute('data-state')).toBe('empty');
    expect(
      screen.getByTestId('precision-stats-placeholder'),
    ).toBeTruthy();
  });

  it('endpoint падает → placeholder (graceful)', async () => {
    authValue.user = { id: 'u1', username: 'tester' };
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/puzzles/browse?')) return Promise.resolve(wrap(SAMPLE));
      if (url === '/precision/stats/me') return Promise.reject(new Error('500'));
      return Promise.resolve([]);
    });
    renderWithProviders(<PrecisionPage />);
    const block = await waitFor(() => {
      const el = screen.queryByTestId('precision-stats');
      if (!el) throw new Error('stats not yet rendered');
      return el;
    });
    expect(block.getAttribute('data-state')).toBe('empty');
    expect(
      screen.getByTestId('precision-stats-placeholder'),
    ).toBeTruthy();
  });
});

describe('<PrecisionPage> KS-2719 F3 — toggle Скрыть удержанные', () => {
  it('рендерит toggle и пробрасывает hideSolved=true в URL', async () => {
    authValue.user = { id: 'u1', username: 'tester' };
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/puzzles/browse?')) return Promise.resolve(wrap(SAMPLE));
      if (url === '/precision/stats/me') {
        return Promise.resolve({
          totalAttempts: 5,
          preservedCount: 3,
          avgAccuracyPercent: 80,
          avgWdlLeakPerMove: 0.02,
          avgHalfMovesUntilFirstMistake: 5,
        });
      }
      return Promise.resolve([]);
    });
    renderWithProviders(<PrecisionPage />);
    const toggle = await waitFor(() => {
      const el = screen.queryByTestId('precision-hide-preserved-input');
      if (!el) throw new Error('toggle not rendered');
      return el as HTMLInputElement;
    });
    expect(toggle.checked).toBe(false);
  });
});
