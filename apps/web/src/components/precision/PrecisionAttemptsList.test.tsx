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
    score: number | null;
    scorePct: number | null;
    // KS-3374: precision-рейтинг (KS-3341).
    ratingBefore: number | null;
    ratingAfter: number | null;
    ratingDelta: number | null;
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
    // KS-3173: score нужен в тестах эффективного solved (5★ → success
    // даже при solved=false для legacy saveEquality-попыток до KS-3169).
    score: overrides.score === undefined ? null : overrides.score,
    scorePct: overrides.scorePct === undefined ? null : overrides.scorePct,
    // KS-3374: rating-поля. undefined в overrides → null (legacy).
    ratingBefore:
      overrides.ratingBefore === undefined ? null : overrides.ratingBefore,
    ratingAfter:
      overrides.ratingAfter === undefined ? null : overrides.ratingAfter,
    ratingDelta:
      overrides.ratingDelta === undefined ? null : overrides.ratingDelta,
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

  /**
   * KS-3171 follow-up: первая итерация фикса оставила доску внутри
   * `<Link>`, но `react-chessboard` навешивает pointer-handlers на каждую
   * клетку — реальный пользователь на мобильном тапал «мимо» (event
   * проваливался в обработчик клетки, а не в Link).
   *
   * Превью-обёртка обязана быть `pointer-events: none`, чтобы touch/click
   * прошли до родительского <a>. В jsdom глобальный CSS из puzzle.css не
   * парсится, поэтому проверяем inline-style (дублирует CSS-правило
   * именно по этой причине; см. комментарий в `PrecisionAttemptsList.tsx`).
   */
  it('KS-3171 follow-up: превью-доска имеет pointer-events:none — тап уходит к Link', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      items: [makeItem('att-42', true)],
      total: 1,
    } satisfies PrecisionAttemptsListResponse);

    renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

    const link = await waitFor(() =>
      screen.getByTestId('precision-attempts-link-att-42'),
    );
    const preview = link.querySelector(
      '.precision-attempts__preview',
    ) as HTMLElement | null;
    expect(preview).not.toBeNull();
    expect(preview!.style.pointerEvents).toBe('none');
    // aria-hidden: содержимое доски (длинные alt'ы у каждой клетки от
    // react-chessboard) — шум для скринридеров; aria-label ссылки
    // достаточен для семантики.
    expect(preview!.getAttribute('aria-hidden')).toBe('true');
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

  /**
   * KS-3173: рассинхрон UI-цвета с accuracy для legacy saveEquality-
   * попыток (solved=false при score=5/accuracy=100%). UI считает
   * «успехом» либо настоящий `solved=true`, либо `score === 5` — иначе
   * пользователь видел две 5★-карточки с разным цветом бордера.
   */
  describe('KS-3173: effectiveSolved = solved || score===5', () => {
    it('solved=false + score=5 → row помечен как preserved (зелёный бордер → красный через KS-3172)', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [
          // legacy saveEquality: backend проставил solved=false, но звезда 5★.
          makeItem('legacy-5star', false, { score: 5, scorePct: 96, endReason: 'lose-wdl' }),
        ],
        total: 1,
      } satisfies PrecisionAttemptsListResponse);

      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

      const row = await waitFor(() =>
        screen.getByTestId('precision-attempts-row-legacy-5star'),
      );
      // data-solved сохраняет «честный» БД-флаг для диагностики.
      expect(row.getAttribute('data-solved')).toBe('false');
      // data-effective-solved — derived флаг для UI/фильтра.
      expect(row.getAttribute('data-effective-solved')).toBe('true');
      // Класс — preserved (после KS-3172 это красный левый бордер).
      expect(row.className).toContain('precision-attempts__row--preserved');
      expect(row.className).not.toContain('precision-attempts__row--lost');
    });

    it('solved=false + score=4 → row остаётся lost (4★ не считаем успехом)', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [makeItem('4star-lost', false, { score: 4, scorePct: 88 })],
        total: 1,
      } satisfies PrecisionAttemptsListResponse);

      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

      const row = await waitFor(() =>
        screen.getByTestId('precision-attempts-row-4star-lost'),
      );
      expect(row.getAttribute('data-effective-solved')).toBe('false');
      expect(row.className).toContain('precision-attempts__row--lost');
    });

    it('solved=true + score=null → preserved (без регрессии для legacy без score)', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [makeItem('legacy-no-score', true, { score: null, scorePct: null })],
        total: 1,
      } satisfies PrecisionAttemptsListResponse);

      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);

      const row = await waitFor(() =>
        screen.getByTestId('precision-attempts-row-legacy-no-score'),
      );
      expect(row.getAttribute('data-effective-solved')).toBe('true');
      expect(row.className).toContain('precision-attempts__row--preserved');
    });

    it('фильтр Preserved включает 5★ + solved=false (legacy saveEquality)', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [
          makeItem('legacy-5star', false, { score: 5 }),
          makeItem('honest-fail', false, { score: 2 }),
          makeItem('honest-win', true, { score: 4 }),
        ],
        total: 3,
      } satisfies PrecisionAttemptsListResponse);

      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);
      await waitFor(() => screen.getByTestId('precision-attempts-row-legacy-5star'));

      fireEvent.click(screen.getByTestId('precision-attempts-filter-preserved'));

      // 5★ legacy с solved=false попадает в Preserved (effectiveSolved=true).
      expect(screen.queryByTestId('precision-attempts-row-legacy-5star')).toBeTruthy();
      // honest-win solved=true → тоже здесь.
      expect(screen.queryByTestId('precision-attempts-row-honest-win')).toBeTruthy();
      // 2★ + solved=false → нет.
      expect(screen.queryByTestId('precision-attempts-row-honest-fail')).toBeNull();
    });

    it('фильтр Lost исключает 5★ + solved=false', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [
          makeItem('legacy-5star', false, { score: 5 }),
          makeItem('honest-fail', false, { score: 2 }),
        ],
        total: 2,
      } satisfies PrecisionAttemptsListResponse);

      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);
      await waitFor(() => screen.getByTestId('precision-attempts-row-legacy-5star'));

      fireEvent.click(screen.getByTestId('precision-attempts-filter-lost'));

      expect(screen.queryByTestId('precision-attempts-row-legacy-5star')).toBeNull();
      expect(screen.queryByTestId('precision-attempts-row-honest-fail')).toBeTruthy();
    });
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

  describe('KS-3374: колонка ±delta рейтинга', () => {
    it('positive delta → «+15» + tone=gain + tooltip', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [
          makeItem('a-gain', true, {
            ratingBefore: 1487,
            ratingAfter: 1502,
            ratingDelta: 15,
          }),
        ],
        total: 1,
      } satisfies PrecisionAttemptsListResponse);
      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);
      const delta = await waitFor(() =>
        screen.getByTestId('precision-attempts-rating-delta-a-gain'),
      );
      expect(delta.getAttribute('data-delta')).toBe('15');
      expect(delta.getAttribute('data-tone')).toBe('gain');
      expect(delta.textContent).toMatch(/\+15/);
      // Tooltip — before → after.
      expect(delta.getAttribute('title')).toMatch(/1487/);
      expect(delta.getAttribute('title')).toMatch(/1502/);
    });

    it('negative delta → «-8» + tone=loss', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [
          makeItem('a-loss', false, {
            ratingBefore: 1500,
            ratingAfter: 1492,
            ratingDelta: -8,
          }),
        ],
        total: 1,
      } satisfies PrecisionAttemptsListResponse);
      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);
      const delta = await waitFor(() =>
        screen.getByTestId('precision-attempts-rating-delta-a-loss'),
      );
      expect(delta.getAttribute('data-delta')).toBe('-8');
      expect(delta.getAttribute('data-tone')).toBe('loss');
      expect(delta.textContent).toMatch(/-8/);
    });

    it('null (legacy/skip) → «—» + data-delta="null", без tooltip с числами', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [
          makeItem('a-null', true, {
            ratingBefore: null,
            ratingAfter: null,
            ratingDelta: null,
          }),
        ],
        total: 1,
      } satisfies PrecisionAttemptsListResponse);
      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);
      const delta = await waitFor(() =>
        screen.getByTestId('precision-attempts-rating-delta-a-null'),
      );
      expect(delta.getAttribute('data-delta')).toBe('null');
      expect(delta.textContent).toMatch(/—/);
      expect(delta.getAttribute('title')).toBeNull();
    });

    it('delta=0 → tone=flat (нейтральный), знака «+/-» нет', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        items: [
          makeItem('a-flat', true, {
            ratingBefore: 1500,
            ratingAfter: 1500,
            ratingDelta: 0,
          }),
        ],
        total: 1,
      } satisfies PrecisionAttemptsListResponse);
      renderWithProviders(<PrecisionAttemptsList fetcher={fetcher} />);
      const delta = await waitFor(() =>
        screen.getByTestId('precision-attempts-rating-delta-a-flat'),
      );
      expect(delta.getAttribute('data-delta')).toBe('0');
      expect(delta.getAttribute('data-tone')).toBe('flat');
      // «0» без знака.
      expect(delta.textContent?.trim()).toMatch(/0$/);
    });
  });
});
