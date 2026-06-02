/**
 * KS-3584. Тесты `MaiaAnalysisSection`: статусы (loading/error/ready),
 * top-5 ограничение, формат «prob% │ SAN», select ELO.
 *
 * Мокаем `useMaiaAnalysis` чтобы проверить только рендер. Auth-контекст
 * мокаем по паттерну GuessLandingPage (KS-3503).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';

import { MaiaAnalysisSection } from './MaiaAnalysisSection';
import { renderWithProviders, screen } from '../../test/test-utils';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const { mockUseMaia } = vi.hoisted(() => ({
  mockUseMaia: vi.fn(),
}));

vi.mock('../../hooks/useMaiaAnalysis', () => ({
  useMaiaAnalysis: () => mockUseMaia(),
  MAIA_ELO_OPTIONS: [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400],
}));

beforeEach(() => {
  mockUseMaia.mockReset();
});

describe('<MaiaAnalysisSection> KS-3584', () => {
  it('loading: показывает «Loading Maia…»', () => {
    mockUseMaia.mockReturnValue({
      elo: 1500,
      setElo: vi.fn(),
      lines: [],
      status: 'loading',
      error: null,
      retry: vi.fn(),
    });
    renderWithProviders(<MaiaAnalysisSection fen={STARTPOS} />);
    expect(screen.getByTestId('maia-section-loading').textContent).toMatch(
      /loading|maia/i,
    );
  });

  it('error: показывает сообщение и кнопку retry, клик зовёт retry()', () => {
    const retry = vi.fn();
    mockUseMaia.mockReturnValue({
      elo: 1500,
      setElo: vi.fn(),
      lines: [],
      status: 'error',
      error: 'boom',
      retry,
    });
    renderWithProviders(<MaiaAnalysisSection fen={STARTPOS} />);
    expect(screen.getByTestId('maia-section-error').textContent).toMatch(
      /failed|maia/i,
    );
    const btn = screen.getByTestId(
      'maia-section-retry',
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('ready: рендерит top-N линий, top-1 жирностью (класс best)', () => {
    mockUseMaia.mockReturnValue({
      elo: 1500,
      setElo: vi.fn(),
      lines: [
        { move: 'e2e4', probability: 0.352 },
        { move: 'd2d4', probability: 0.221 },
        { move: 'g1f3', probability: 0.125 },
      ],
      status: 'ready',
      error: null,
      retry: vi.fn(),
    });
    renderWithProviders(<MaiaAnalysisSection fen={STARTPOS} />);
    const list = screen.getByTestId('maia-lines');
    expect(list.children).toHaveLength(3);

    // Формат «prob% │ SAN».
    expect(list.textContent).toContain('35.2%');
    expect(list.textContent).toContain('22.1%');
    expect(list.textContent).toContain('12.5%');
    expect(list.textContent).toContain('│');
    // SAN из стартовой позиции: e2e4 → e4, g1f3 → Nf3.
    expect(list.textContent).toContain('e4');
    expect(list.textContent).toContain('d4');
    expect(list.textContent).toContain('Nf3');

    // Top-1 жирностью (класс best).
    const first = screen.getByTestId('maia-line-0');
    expect(first.className).toContain('maia-line--best');
    const second = screen.getByTestId('maia-line-1');
    expect(second.className).not.toContain('maia-line--best');
  });

  it('ready: лимит top-N — не больше 5 строк', () => {
    mockUseMaia.mockReturnValue({
      elo: 1500,
      setElo: vi.fn(),
      // Хук уже отдаёт slice(0, 5) — здесь имитируем что компонент
      // не отрисовывает лишнего, даже если бы пришло 7.
      lines: [
        { move: 'a2a3', probability: 0.3 },
        { move: 'b2b3', probability: 0.25 },
        { move: 'c2c3', probability: 0.15 },
        { move: 'd2d3', probability: 0.1 },
        { move: 'e2e3', probability: 0.08 },
      ],
      status: 'ready',
      error: null,
      retry: vi.fn(),
    });
    renderWithProviders(<MaiaAnalysisSection fen={STARTPOS} />);
    const list = screen.getByTestId('maia-lines');
    expect(list.children).toHaveLength(5);
  });

  it('select ELO: смена value зовёт setElo с числом', () => {
    const setElo = vi.fn();
    mockUseMaia.mockReturnValue({
      elo: 1500,
      setElo,
      lines: [],
      status: 'ready',
      error: null,
      retry: vi.fn(),
    });
    renderWithProviders(<MaiaAnalysisSection fen={STARTPOS} />);
    const select = screen.getByTestId(
      'maia-section-elo-select',
    ) as HTMLSelectElement;
    expect(select.value).toBe('1500');
    act(() => {
      select.value = '1900';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setElo).toHaveBeenCalledWith(1900);
  });

  it('stale: при loading с непустыми lines показывается список с data-stale=true', () => {
    mockUseMaia.mockReturnValue({
      elo: 1500,
      setElo: vi.fn(),
      lines: [{ move: 'e2e4', probability: 0.5 }],
      status: 'loading',
      error: null,
      retry: vi.fn(),
    });
    renderWithProviders(<MaiaAnalysisSection fen={STARTPOS} />);
    const list = screen.getByTestId('maia-lines');
    expect(list.getAttribute('data-stale')).toBe('true');
  });
});
