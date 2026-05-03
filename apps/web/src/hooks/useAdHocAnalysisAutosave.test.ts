import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  clearAdHocAnalysisStorage,
  readAdHocAnalysisStorage,
  useAdHocAnalysisAutosave,
} from './useAdHocAnalysisAutosave';
import type { ChessMove } from '../review/types';

/**
 * KS-2281 — autosave ad-hoc /analysis в localStorage.
 *
 * Покрытие:
 *  - сохранение PGN в localStorage при изменении history;
 *  - throttle (повторные изменения внутри окна не пишут немедленно);
 *  - не сохраняет, если enabled=false;
 *  - не сохраняет пустую партию + нет initialAnnotations;
 *  - не перезатирает существующую запись пустотой;
 *  - restore на mount → onRestore(pgn);
 *  - flush на unmount;
 *  - readAdHocAnalysisStorage / clearAdHocAnalysisStorage хелперы;
 *  - изоляция по initialFen (две позиции — две записи).
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeMove(idx: number, san = 'e4'): ChessMove {
  return {
    san,
    fen: INITIAL_FEN,
    from: 'e2',
    to: 'e4',
    piece: 'p',
    flags: 'b',
    lan: 'e2e4',
    before: INITIAL_FEN,
    after: INITIAL_FEN,
    globalIndex: idx,
    ply: idx,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('useAdHocAnalysisAutosave (KS-2281)', () => {
  it('mount + история [e4] → запись в localStorage появляется', () => {
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: INITIAL_FEN,
        history: [makeMove(1)],
      }),
    );
    const stored = readAdHocAnalysisStorage(INITIAL_FEN);
    expect(stored).not.toBeNull();
    // Сериализованный PGN должен содержать ход.
    expect(stored).toContain('e4');
  });

  it('enabled=false → ничего не сохраняется', () => {
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: false,
        initialFen: INITIAL_FEN,
        history: [makeMove(1)],
      }),
    );
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).toBeNull();
  });

  it('пустая history без initialAnnotations → не пишет', () => {
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: INITIAL_FEN,
        history: [],
      }),
    );
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).toBeNull();
  });

  it('пустая history НЕ перезатирает существующую запись (защита)', () => {
    // Прямо ставим запись (имитация прошлой сессии).
    const seedKey = `analysis:adhoc:${btoa(unescape(encodeURIComponent(INITIAL_FEN)))}`;
    localStorage.setItem(seedKey, '[Result "*"]\n\n*');
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: INITIAL_FEN,
        history: [],
      }),
    );
    // Запись осталась нетронутой.
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).toContain('Result');
  });

  it('throttle: 2 изменения подряд внутри окна → второй пишет позже (через timer)', async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ history }) =>
        useAdHocAnalysisAutosave({
          enabled: true,
          initialFen: INITIAL_FEN,
          history,
        }),
      { initialProps: { history: [makeMove(1, 'e4')] } },
    );
    // Первый save (immediate, throttle ещё не блокирует).
    const afterFirst = readAdHocAnalysisStorage(INITIAL_FEN);
    expect(afterFirst).toContain('e4');
    expect(afterFirst).not.toContain('Nf3');

    // Сразу же меняем history (e4 + Nf3) — внутри throttle-окна (1500ms).
    rerender({ history: [makeMove(1, 'e4'), makeMove(2, 'Nf3')] });
    // Новый ход ещё НЕ записан (throttle pending).
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).not.toContain('Nf3');

    // Прокручиваем 1600ms — pending timer срабатывает.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).toContain('Nf3');
  });

  it('restore на mount: вызывает onRestore с PGN из localStorage', () => {
    const seedPgn = '[Event "?"]\n[Result "*"]\n\n1. e4 e5 *';
    const seedKey = `analysis:adhoc:${btoa(unescape(encodeURIComponent(INITIAL_FEN)))}`;
    localStorage.setItem(seedKey, seedPgn);
    const onRestore = vi.fn();
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: INITIAL_FEN,
        history: [],
        onRestore,
      }),
    );
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith(seedPgn);
  });

  it('restore не вызывается, если enabled=false', () => {
    const seedKey = `analysis:adhoc:${btoa(unescape(encodeURIComponent(INITIAL_FEN)))}`;
    localStorage.setItem(seedKey, '[Result "*"]\n\n*');
    const onRestore = vi.fn();
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: false,
        initialFen: INITIAL_FEN,
        history: [],
        onRestore,
      }),
    );
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('restore не вызывается, если запись пустая', () => {
    const onRestore = vi.fn();
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: INITIAL_FEN,
        history: [],
        onRestore,
      }),
    );
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('clearAdHocAnalysisStorage сбрасывает запись', () => {
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: INITIAL_FEN,
        history: [makeMove(1)],
      }),
    );
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).not.toBeNull();
    clearAdHocAnalysisStorage(INITIAL_FEN);
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).toBeNull();
  });

  it('изоляция по initialFen: 2 позиции → 2 разные записи', () => {
    const fen2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: INITIAL_FEN,
        history: [makeMove(1, 'e4')],
      }),
    );
    renderHook(() =>
      useAdHocAnalysisAutosave({
        enabled: true,
        initialFen: fen2,
        history: [makeMove(1, 'Nf3')],
      }),
    );
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).toContain('e4');
    expect(readAdHocAnalysisStorage(fen2)).toContain('Nf3');
    // Записи не пересеклись.
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).not.toContain('Nf3');
    expect(readAdHocAnalysisStorage(fen2)).not.toContain('e4');
  });

  it('flush на unmount пишет последний snapshot', async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderHook(
      ({ history }) =>
        useAdHocAnalysisAutosave({
          enabled: true,
          initialFen: INITIAL_FEN,
          history,
        }),
      { initialProps: { history: [makeMove(1, 'e4')] } },
    );
    // Внутри throttle-окна меняем history (e4 + Nf3).
    rerender({ history: [makeMove(1, 'e4'), makeMove(2, 'Nf3')] });
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).not.toContain('Nf3');
    // Unmount до срабатывания pending timer'а — flush в cleanup всё равно сохранит.
    await act(async () => {
      unmount();
    });
    expect(readAdHocAnalysisStorage(INITIAL_FEN)).toContain('Nf3');
  });
});
