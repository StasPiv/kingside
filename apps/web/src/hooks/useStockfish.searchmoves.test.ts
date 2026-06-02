/**
 * KS-3596 (ADR-099 F1). Юнит-тесты на pure-функции из `useStockfish.ts`,
 * которые понадобились для поддержки `go searchmoves`:
 *  - `buildGoCommand` — собирает UCI-строку с опциональным `searchmoves` хвостом.
 *  - `filterLegalUci` — фильтрует нелегальные UCI-ходы для текущего FEN.
 *
 * Интеграция (worker-инстанс, watcher на смену `searchmoves`,
 * `resolveSearchmoves` perfen-fallback) — отдельным сценарным тестом
 * не покрываем: worker мокать дорого, watcher-логика дублирует уже
 * проверенные паттерны depth/multiPv/movetime (KS-3042/3085/3470).
 * Их в F2 поверх будет интегр-тест в `AnalysisSidebar`.
 */
import { describe, it, expect } from 'vitest';

import {
  buildGoCommand,
  filterLegalUci,
} from './useStockfish';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// После 1. e4 — ход чёрных. e7e5 / e7e6 / d7d5 — легальные; e2e4 — нет (там нет пешки).
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

describe('buildGoCommand (KS-3596)', () => {
  it('без searchmoves — обычный `go depth N`', () => {
    expect(buildGoCommand(undefined, false, 20)).toBe('go depth 20');
  });

  it('searchmoves=null/undefined/[] — обычный `go depth N`', () => {
    expect(buildGoCommand(undefined, false, 20, null)).toBe('go depth 20');
    expect(buildGoCommand(undefined, false, 20, undefined)).toBe('go depth 20');
    expect(buildGoCommand(undefined, false, 20, [])).toBe('go depth 20');
  });

  it('searchmoves хвост к `go depth N`', () => {
    expect(buildGoCommand(undefined, false, 18, ['e2e4', 'd2d4'])).toBe(
      'go depth 18 searchmoves e2e4 d2d4',
    );
  });

  it('searchmoves совместим с `go infinite`', () => {
    expect(buildGoCommand(undefined, true, 0, ['e2e4', 'd2d4', 'g1f3'])).toBe(
      'go infinite searchmoves e2e4 d2d4 g1f3',
    );
  });

  it('searchmoves совместим с `go movetime N`', () => {
    expect(buildGoCommand(500, false, 20, ['e2e4'])).toBe(
      'go movetime 500 searchmoves e2e4',
    );
  });

  it('movetime > infinite — searchmoves хвост к movetime', () => {
    expect(buildGoCommand(500, true, 20, ['e2e4'])).toBe(
      'go movetime 500 searchmoves e2e4',
    );
  });
});

describe('filterLegalUci (KS-3596)', () => {
  it('пустой массив → []', () => {
    expect(filterLegalUci(STARTPOS, [])).toEqual([]);
  });

  it('startpos: 1. e2e4, d2d4, g1f3 — все легальны', () => {
    expect(filterLegalUci(STARTPOS, ['e2e4', 'd2d4', 'g1f3'])).toEqual([
      'e2e4',
      'd2d4',
      'g1f3',
    ]);
  });

  it('фильтрует нелегальные, сохраняет порядок легальных', () => {
    // a2a5 — нелегальный (пешка ходит на 2 max), e2e4 — легальный.
    expect(filterLegalUci(STARTPOS, ['a2a5', 'e2e4', 'd2d3'])).toEqual([
      'e2e4',
      'd2d3',
    ]);
  });

  it('сохраняет дубликаты (caller отвечает за уникальность)', () => {
    expect(filterLegalUci(STARTPOS, ['e2e4', 'e2e4', 'd2d4'])).toEqual([
      'e2e4',
      'e2e4',
      'd2d4',
    ]);
  });

  it('ход чёрных в позиции с белыми на ходу → пусто', () => {
    expect(filterLegalUci(STARTPOS, ['e7e5', 'd7d5'])).toEqual([]);
  });

  it('после 1.e4 — ходы чёрных легальны, белый ход нет', () => {
    expect(filterLegalUci(AFTER_E4, ['e7e5', 'e2e4', 'd7d5'])).toEqual([
      'e7e5',
      'd7d5',
    ]);
  });

  it('некорректный FEN → []', () => {
    expect(filterLegalUci('garbage', ['e2e4'])).toEqual([]);
  });

  it('non-string элементы фильтруются', () => {
    // @ts-expect-error — тест defensive-обработки
    expect(filterLegalUci(STARTPOS, ['e2e4', 42, null, 'd2d4'])).toEqual([
      'e2e4',
      'd2d4',
    ]);
  });
});
