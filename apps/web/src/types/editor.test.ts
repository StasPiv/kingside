import { describe, it, expect } from 'vitest';

import { emptyStepPayload } from './editor';

/**
 * KS-1873: дефолтные payload'ы должны быть валидны для backend
 * DTO'шек, иначе создание шага из UI падает 400.
 *
 * Unit-snapshot тут только проверяет shape (без сетевого вызова).
 * Реальный POST через dev-сервер — в `tests/e2e/step-add-puzzle.spec.ts`.
 */

describe('emptyStepPayload', () => {
  it('puzzle: mode=filter, themes непустые, limit в [1..20], валидное окно рейтинга', () => {
    const p = emptyStepPayload('puzzle');
    expect(p.type).toBe('puzzle');
    if (p.type !== 'puzzle') throw new Error('not puzzle');
    expect(p.selection.mode).toBe('filter');
    if (p.selection.mode !== 'filter') throw new Error('not filter');
    // Backend DTO отвергает пустой themes c 400 «should not be empty».
    expect(p.selection.themes.length).toBeGreaterThan(0);
    expect(p.selection.limit).toBeGreaterThanOrEqual(1);
    expect(p.selection.limit).toBeLessThanOrEqual(20);
    expect(p.selection.ratingMin).toBeGreaterThan(0);
    expect(p.selection.ratingMax).toBeGreaterThan(p.selection.ratingMin ?? 0);
  });

  it('puzzle: НЕ возвращает {mode:"ids", puzzleIds:[]} (regression KS-1873)', () => {
    const p = emptyStepPayload('puzzle');
    if (p.type !== 'puzzle') throw new Error('not puzzle');
    // Backend `UserPuzzleStepPayloadDto` отвергает пустой puzzleIds c 400
    // «should not be empty» — критично, чтобы дефолт не уходил в ids-режим.
    if (p.selection.mode === 'ids') {
      expect(p.selection.puzzleIds.length).toBeGreaterThan(0);
    }
  });

  it('text: bodyMarkdown="" + diagrams=[] (валидный стартовый шаблон)', () => {
    const p = emptyStepPayload('text');
    expect(p).toEqual({ type: 'text', bodyMarkdown: '', diagrams: [] });
  });

  it('endgame_drill: валидный FEN + playerSide + winCondition', () => {
    const p = emptyStepPayload('endgame_drill');
    if (p.type !== 'endgame_drill') throw new Error('not endgame_drill');
    expect(p.fen).toMatch(/^[1-8rnbqkpRNBQKP/]+ [wb] /);
    expect(['white', 'black']).toContain(p.playerSide);
    expect(p.winCondition.kind).toBeTruthy();
    expect(p.skillLevel).toBeGreaterThanOrEqual(0);
  });
});
