import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { BroadcastCrosstable } from './BroadcastCrosstable';
import type {
  CrosstableRoundRobin,
  CrosstableSwiss,
  CrosstableTeam,
  CrosstableLegacy,
  CrosstableCell,
  CrosstablePlayer,
} from '@kingside/shared';

/**
 * KS-1740 / ADR-023 §2.12 (A16) — integration-тесты рендера
 * `<BroadcastCrosstable>` на всех 4 типах `CrosstableResponse`.
 *
 * Проверяют что:
 *  1. Диспетчер корректно поднимает нужный компонент по `tournamentType`.
 *  2. Переведённые ключи из `broadcast.crosstable.*` (en-фикстура
 *     test-utils) присутствуют в рендере.
 *  3. Данные фикстуры отображаются конечному пользователю.
 *
 * Языковые ассерты сосредоточены на английском (test-utils использует
 * en-локаль). Эквивалентные ru-строки присутствуют в
 * `src/i18n/locales/ru/translation.json` — проверка равенства ключей
 * сводится к «оба JSON должны содержать те же пути».
 */

const mockBroadcastApi = { get: vi.fn() };
vi.mock('../../api/broadcastApi', () => ({
  broadcastApi: {
    get: (...args: unknown[]) => mockBroadcastApi.get(...args),
  },
}));

function player(
  overrides: Partial<CrosstablePlayer> & Pick<CrosstablePlayer, 'rank' | 'name'>,
): CrosstablePlayer {
  return {
    normalizedName: overrides.name.toLowerCase(),
    points: 0,
    gamesPlayed: 0,
    ...overrides,
  };
}

function cell(
  result: CrosstableCell['result'],
  opRank?: number,
  color?: CrosstableCell['color'],
  gameId?: string,
): CrosstableCell {
  return {
    result,
    ...(opRank !== undefined ? { opponentRank: opRank } : {}),
    ...(color ? { color } : {}),
    ...(gameId ? { gameRef: { gameId, roundId: `r-${gameId}`, roundName: 'R' } } : {}),
  };
}

const BASE = {
  sourceType: 'chess-results' as const,
  sourceUrl: 'https://chess-results.com/x',
  fetchedAt: '2026-04-23T10:00:00.000Z',
};

beforeEach(() => {
  mockBroadcastApi.get.mockReset();
});

describe('<BroadcastCrosstable> integration — 4 tournament types', () => {
  it('round-robin: рендерит RoundRobinCrosstable + i18n-заголовки', async () => {
    const data: CrosstableRoundRobin = {
      ...BASE,
      tournamentType: 'round-robin',
      players: [
        player({ rank: 1, name: 'Alice', points: 1, gamesPlayed: 1, elo: 2500, federation: 'USA' }),
        player({ rank: 2, name: 'Bob', points: 0, gamesPlayed: 1, elo: 2400, federation: 'GBR' }),
      ],
      matrix: [
        [cell(null), cell('win', 2, 'white', 'g1')],
        [cell('loss', 1, 'black', 'g1'), cell(null)],
      ],
    };
    mockBroadcastApi.get.mockResolvedValueOnce(data);

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="T1" />);

    await waitFor(() => expect(screen.getByTestId('round-robin-crosstable')).toBeInTheDocument());

    // Player names present
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // Translated column headers
    expect(screen.getByRole('columnheader', { name: 'Fed' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Elo' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Pts' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'GP' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Player' })).toBeInTheDocument();
  });

  it('swiss: рендерит BroadcastSwissStandings + i18n-заголовки + bye=«—»', async () => {
    const data: CrosstableSwiss = {
      ...BASE,
      tournamentType: 'swiss',
      roundCount: 2,
      players: [
        player({ rank: 1, name: 'Carlsen', elo: 2830, points: 1.5 }),
        player({ rank: 2, name: 'Ding', elo: 2780, points: 0.5 }),
      ],
      pairings: [
        [cell('win', 2, 'white', 'g1'), cell('bye')],
        [cell('loss', 1, 'black', 'g1'), cell('draw', 1, 'white')],
      ],
    };
    mockBroadcastApi.get.mockResolvedValueOnce(data);

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="T1" />);

    await waitFor(() =>
      expect(screen.getByTestId('broadcast-swiss-standings')).toBeInTheDocument(),
    );

    expect(screen.getByText('Carlsen')).toBeInTheDocument();
    expect(screen.getByText('Ding')).toBeInTheDocument();
    // Column headers translated
    expect(screen.getByRole('columnheader', { name: 'Fed' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Elo' })).toBeInTheDocument();
    // Bye symbol from i18n
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('team-swiss: рендерит TeamStandings + i18n-заголовок «Team»', async () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-swiss',
      teams: [
        { name: 'Red', rank: 1, points: 5 },
        { name: 'Blue', rank: 2, points: 3 },
      ],
      players: [
        player({ rank: 1, name: 'RedA', team: 'Red', elo: 2500 }),
        player({ rank: 2, name: 'BlueA', team: 'Blue', elo: 2400 }),
      ],
    };
    mockBroadcastApi.get.mockResolvedValueOnce(data);

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="T1" />);

    await waitFor(() => expect(screen.getByTestId('team-standings')).toBeInTheDocument());

    // Team column header translated
    expect(screen.getByRole('columnheader', { name: 'Team' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Pts' })).toBeInTheDocument();
    // Team names from fixture
    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('Blue')).toBeInTheDocument();
    // Toggle aria-label is translated
    const toggle = screen.getByTestId('team-toggle-Red');
    expect(toggle).toHaveAttribute('aria-label', 'Expand team');
  });

  it('team-round-robin: рендерит TeamStandings с тем же discriminator-путём', async () => {
    const data: CrosstableTeam = {
      ...BASE,
      tournamentType: 'team-round-robin',
      teams: [
        { name: 'Alpha', rank: 1, points: 12 },
        { name: 'Beta', rank: 2, points: 9 },
      ],
      players: [],
    };
    mockBroadcastApi.get.mockResolvedValueOnce(data);

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="T1" />);

    await waitFor(() => expect(screen.getByTestId('team-standings')).toBeInTheDocument());
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('unknown (legacy): рендерит LegacyStandings и подтягивает /standings', async () => {
    const data: CrosstableLegacy = {
      ...BASE,
      sourceType: 'internal-fallback',
      sourceUrl: null,
      fetchedAt: null,
      tournamentType: 'unknown',
      players: [],
      reason: 'standings_url not on chess-results.com',
    };
    mockBroadcastApi.get.mockImplementation((path: string) => {
      if (path === '/b1/crosstable') return Promise.resolve(data);
      if (path === '/b1/standings') return Promise.resolve({ players: [] });
      if (path === '/b1/rounds') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="T1" />);

    // LegacyStandings показывает сообщение noStandings при пустом списке
    await waitFor(() =>
      expect(screen.getByText('Standings not available yet')).toBeInTheDocument(),
    );
  });

  it('loading-состояние показывает локализованный текст из broadcast.crosstable.loading', () => {
    mockBroadcastApi.get.mockImplementation(() => new Promise(() => {}));

    renderWithProviders(<BroadcastCrosstable broadcastId="b1" broadcastTitle="T1" />);

    expect(screen.getByTestId('broadcast-crosstable-loading')).toHaveTextContent(
      'Loading standings…',
    );
  });
});

describe('i18n coverage: en и ru translation.json содержат все ключи broadcast.crosstable.*', async () => {
  const en = (await import('../../i18n/locales/en/translation.json')).default as Record<string, unknown>;
  const ru = (await import('../../i18n/locales/ru/translation.json')).default as Record<string, unknown>;

  function collect(obj: unknown, prefix = ''): string[] {
    if (!obj || typeof obj !== 'object') return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') out.push(...collect(v, path));
      else out.push(path);
    }
    return out;
  }

  function crosstableKeys(bundle: Record<string, unknown>): string[] {
    const broadcast = (bundle.broadcast ?? {}) as Record<string, unknown>;
    const crosstable = (broadcast.crosstable ?? {}) as Record<string, unknown>;
    return collect(crosstable).sort();
  }

  it('en + ru имеют совпадающий набор ключей crosstable.*', () => {
    const enKeys = crosstableKeys(en);
    const ruKeys = crosstableKeys(ru);
    expect(ruKeys).toEqual(enKeys);
    // минимальная полнота набора — явный whitelist обязательных путей
    const required = [
      'title',
      'teamsTitle',
      'team',
      'fed',
      'elo',
      'points',
      'gamesPlayed',
      'board',
      'loading',
      'noDataFromSource',
      'expandTeam',
      'collapseTeam',
      'roundLabel',
      'cellVs',
      'swissCellTooltip',
      'swissCellForfeit',
      'gameNotInBroadcast',
      'opensGameViewer',
      'result.win',
      'result.loss',
      'result.draw',
      'result.bye',
      'result.byeSwiss',
      'result.forfeitPlus',
      'result.forfeitMinus',
    ];
    for (const key of required) {
      expect(enKeys, `en missing: ${key}`).toContain(key);
      expect(ruKeys, `ru missing: ${key}`).toContain(key);
    }
  });
});
