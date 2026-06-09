/**
 * KS-3696 (исправлено по уточнению пользователя). Правило правой
 * колонки: взаимно исключаются ТОЛЬКО `engine` ↔ `ai`. Остальные
 * (`moves`, `book`) — независимые и могут сосуществовать с любой
 * из них и друг с другом. В пределе одновременно открыто до трёх:
 * (engine ИЛИ ai) + moves + book. `gameInfo` (плашка-заголовок) —
 * отдельный переключатель.
 *
 * `engineWillCollapse` — сигнал для AnalysisPage, что Stockfish
 * нужно поставить на паузу (engine закрывается).
 */
import { describe, it, expect } from 'vitest';

import {
  panelToggleReducer,
  type PanelStates,
} from './accordionTogglePanel';

const BASE: PanelStates = {
  gameInfo: true,
  engine: false,
  moves: false,
  ai: false,
  book: false,
  metrics: false,
};

describe('panelToggleReducer — engine ↔ ai взаимное исключение (KS-3696)', () => {
  it('engine открыт, клик на ai → engine закрывается, ai открывается', () => {
    const prev: PanelStates = { ...BASE, engine: true };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'ai');
    expect(next.engine).toBe(false);
    expect(next.ai).toBe(true);
    expect(engineWillCollapse).toBe(true);
  });

  it('ai открыт, клик на engine → ai закрывается, engine открывается', () => {
    const prev: PanelStates = { ...BASE, ai: true };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'engine');
    expect(next.ai).toBe(false);
    expect(next.engine).toBe(true);
    // engine открывается, а не закрывается — на паузу ставить нечего.
    expect(engineWillCollapse).toBe(false);
  });

  it('оба закрыты, клик на engine → открывается только engine', () => {
    const { next, engineWillCollapse } = panelToggleReducer(BASE, 'engine');
    expect(next).toEqual({ ...BASE, engine: true });
    expect(engineWillCollapse).toBe(false);
  });

  it('оба закрыты, клик на ai → открывается только ai', () => {
    const { next, engineWillCollapse } = panelToggleReducer(BASE, 'ai');
    expect(next).toEqual({ ...BASE, ai: true });
    expect(engineWillCollapse).toBe(false);
  });

  it('engine открыт, клик на engine — закрывается, engineWillCollapse=true', () => {
    const prev: PanelStates = { ...BASE, engine: true };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'engine');
    expect(next.engine).toBe(false);
    expect(engineWillCollapse).toBe(true);
  });

  it('ai открыт, клик на ai — закрывается, engineWillCollapse=false', () => {
    const prev: PanelStates = { ...BASE, ai: true };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'ai');
    expect(next.ai).toBe(false);
    expect(engineWillCollapse).toBe(false);
  });
});

describe('panelToggleReducer — moves и book независимы (KS-3696)', () => {
  it('engine открыт, клик на moves → engine остаётся, moves открывается', () => {
    const prev: PanelStates = { ...BASE, engine: true };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'moves');
    expect(next).toEqual({ ...BASE, engine: true, moves: true });
    expect(engineWillCollapse).toBe(false);
  });

  it('ai открыт, клик на book → ai остаётся, book открывается', () => {
    const prev: PanelStates = { ...BASE, ai: true };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'book');
    expect(next).toEqual({ ...BASE, ai: true, book: true });
    expect(engineWillCollapse).toBe(false);
  });

  it('moves + book + engine открыты, клик на ai → engine→ai, moves+book остаются', () => {
    const prev: PanelStates = {
      ...BASE,
      engine: true,
      moves: true,
      book: true,
    };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'ai');
    expect(next).toEqual({
      ...BASE,
      engine: false,
      ai: true,
      moves: true,
      book: true,
    });
    expect(engineWillCollapse).toBe(true);
  });

  it('клик по moves не затрагивает engine/ai/book', () => {
    const prev: PanelStates = {
      ...BASE,
      engine: true,
      ai: false,
      book: true,
    };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'moves');
    expect(next).toEqual({ ...prev, moves: true });
    expect(engineWillCollapse).toBe(false);
  });

  it('клик по book не затрагивает engine/ai/moves', () => {
    const prev: PanelStates = {
      ...BASE,
      engine: false,
      ai: true,
      moves: true,
    };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'book');
    expect(next).toEqual({ ...prev, book: true });
    expect(engineWillCollapse).toBe(false);
  });
});

describe('panelToggleReducer — gameInfo (KS-3696)', () => {
  it('gameInfo переключается независимо, остальные не меняются', () => {
    const prev: PanelStates = { ...BASE, engine: true, ai: false };
    const { next, engineWillCollapse } = panelToggleReducer(prev, 'gameInfo');
    expect(next).toEqual({ ...prev, gameInfo: !prev.gameInfo });
    expect(engineWillCollapse).toBe(false);
  });
});

describe('panelToggleReducer — одновременно до трёх панелей (KS-3696)', () => {
  it('engine + moves + book — допустимая комбинация', () => {
    let st: PanelStates = BASE;
    st = panelToggleReducer(st, 'engine').next;
    st = panelToggleReducer(st, 'moves').next;
    st = panelToggleReducer(st, 'book').next;
    expect(st).toMatchObject({
      engine: true,
      moves: true,
      book: true,
      ai: false,
    });
  });

  it('ai + moves + book — допустимая комбинация', () => {
    let st: PanelStates = BASE;
    st = panelToggleReducer(st, 'ai').next;
    st = panelToggleReducer(st, 'moves').next;
    st = panelToggleReducer(st, 'book').next;
    expect(st).toMatchObject({
      engine: false,
      ai: true,
      moves: true,
      book: true,
    });
  });

  it('engine + ai одновременно недопустимо — открытие ai закрывает engine', () => {
    let st: PanelStates = BASE;
    st = panelToggleReducer(st, 'engine').next;
    st = panelToggleReducer(st, 'moves').next;
    st = panelToggleReducer(st, 'book').next;
    expect(st.engine).toBe(true);
    st = panelToggleReducer(st, 'ai').next;
    // engine принудительно закрыт, остальные сохраняются.
    expect(st).toMatchObject({
      engine: false,
      ai: true,
      moves: true,
      book: true,
    });
  });
});
