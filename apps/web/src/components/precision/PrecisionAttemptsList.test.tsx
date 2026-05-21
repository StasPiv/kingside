import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { PrecisionAttemptsListResponse } from '@kingside/shared';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { PrecisionAttemptsList } from './PrecisionAttemptsList';

/**
 * KS-2724 — список попыток в /precision.
 * Через DI `fetcher` мокаем endpoint без global api.
 *
 * KS-3171: карточка попытки превращена из <button onClick={navigate}> в
 * <Link to=...>, поэтому `useNavigate` больше не мокается — навигация
 * проверяется через `href` ссылки (нативная семантика react-router).
 */

// Chessboard в jsdom тяжёл и не нужен — рендерим пустой div вместо него.
vi.mock('react-chessboard', () => ({
  Chessboard: ({ options }: { options: { position: string } }) => (
    <div data-testid="chessboard-mock" data-fen={options.position} />
  ),
}));

function makeItem(
  id: string,
  solved: boolean,
  overrides: Partial<{
    accuracyPercent: number;
    halfMovesPlayed: number;
    classCounts: { best: number; good: number; inaccuracy: number; mistake: number; blunder: number };
    endReason: string;
    attemptedAt: string;
  }> = {},
): PrecisionAttemptsListResponse['items'][number] {
  return {
    attemptId: id,
    puzzleId: `p-${id}`,
    puzzleFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    attemptedAt: overrides.attemptedAt ?? '2026-05-10T12:00:00Z',
    solved,
    endReason: overrides.endReason ?? (solved ? 'win' : 'lose-wdl'),
    halfMovesPlayed: overrides.halfMovesPlayed ?? 6,
    accuracyPercent: overrides.accuracyPercent ?? 80,
    classCounts: overrides.classCounts ?? {
      best: 3,
      good: 1,
      inaccuracy: 1,
      mistake: 1,
      blunder: 0,
    },
  };
}

describe('<PrecisionAttemptsList>', () => {
  beforeEach(() => {
    // KS-3171: navigateMock больше не используется — карточка стала <Link>.
  });

  it('рендерит 3 попытки с разными endReason', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [
        makeItem('a1', true, { endReason: 'win' }),
        makeItem('a2', false, { endReason: 'lose-wdl' }),
        makeItem('a3', false, { endReason: 'lose-mate' }),
      ],
      total: 3,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.queryByTestId('precision-attempts')).toBeTruthy();
    });

    expect(
      screen.getByTestId('precision-attempts').getAttribute('data-state'),
    ).toBe('ready');
    expect(screen.getByTestId('precision-attempts-row-a1')).toBeTruthy();
    expect(screen.getByTestId('precision-attempts-row-a2')).toBeTruthy();
    expect(screen.getByTestId('precision-attempts-row-a3')).toBeTruthy();
    expect(
      screen.getByTestId('precision-attempts-row-a1').getAttribute('data-solved'),
    ).toBe('true');
    expect(
      screen.getByTestId('precision-attempts-row-a2').getAttribute('data-solved'),
    ).toBe('false');
  });

  it('KS-3171: карточка — <a href="/precision/attempts/<id>"> (вся кликабельна, без отдельного «Review →» CTA)', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('att-42', true)],
      total: 1,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    const link = await waitFor(() =>
      screen.getByTestId('precision-attempts-link-att-42'),
    );
    // Карточка теперь — нативный <a> (от <Link>), а не <button>.
    // Tab-focus / правый-клик «Открыть в новой вкладке» работают сами,
    // отдельный CTA «Review →» удалён.
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/precision/attempts/att-42');
    // KS-3171: «Review →» как отдельная подпись внутри карточки удалена —
    // дублирующего CTA быть не должно. Аria-label на ссылке остался
    // ('Open review') — он не виден глазам.
    expect(link.textContent).not.toMatch(/Review →|Разбор →/);
  });

  it('пустой ответ → empty-state', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('empty');
    });
    expect(screen.getByTestId('precision-attempts-empty')).toBeTruthy();
  });

  it('ошибка fetch → error-state с retry', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('500'));

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(
        screen.getByTestId('precision-attempts').getAttribute('data-state'),
      ).toBe('error');
    });
    expect(screen.getByTestId('precision-attempts-retry')).toBeTruthy();
  });

  it('фильтр Preserved оставляет только solved=true', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [
        makeItem('a1', true),
        makeItem('a2', false),
        makeItem('a3', true),
      ],
      total: 3,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.queryByTestId('precision-attempts-row-a1')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('precision-attempts-filter-preserved'));

    expect(screen.queryByTestId('precision-attempts-row-a1')).toBeTruthy();
    expect(screen.queryByTestId('precision-attempts-row-a2')).toBeNull();
    expect(screen.queryByTestId('precision-attempts-row-a3')).toBeTruthy();
  });

  it('KS-3076: items.length < total → рендерится sentinel для infinite-scroll', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('a1', true)],
      total: 5,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.getByTestId('precision-attempts-sentinel')).toBeTruthy();
    });
  });

  it('KS-3076: items.length === total → sentinel не рендерится', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('a1', true)],
      total: 1,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    await waitFor(() => {
      expect(screen.queryByTestId('precision-attempts-row-a1')).toBeTruthy();
    });
    expect(screen.queryByTestId('precision-attempts-sentinel')).toBeNull();
  });
});
