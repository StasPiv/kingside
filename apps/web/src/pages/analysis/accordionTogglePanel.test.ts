/**
 * KS-3696. Тесты accordion-редюсера правой колонки `AnalysisPage`.
 * Логика вынесена в чистую функцию `panelToggleReducer`, чтобы не
 * поднимать AnalysisPage в jsdom. Здесь проверяем:
 *  - одна открытая панель за раз среди engine/moves/ai/book;
 *  - повторный клик по уже открытой панели — закрывает её;
 *  - gameInfo не входит в accordion;
 *  - engineWillCollapse=true в правильных случаях (для AnalysisPage —
 *    сигнал на «приостановить Stockfish»).
 */
import { describe, it, expect } from 'vitest';

import {
  panelToggleReducer,
  type PanelStates,
} from './accordionTogglePanel';

const ALL_CLOSED: PanelStates = {
  gameInfo: true,
  engine: false,
  moves: false,
  ai: false,
  book: false,
};

const ENGINE_OPEN: PanelStates = {
  ...ALL_CLOSED,
  engine: true,
};

const AI_OPEN: PanelStates = {
  ...ALL_CLOSED,
  ai: true,
};

describe('panelToggleReducer — accordion (KS-3696)', () => {
  it('открытие engine → engine: true, остальные false', () => {
    const { next } = panelToggleReducer(ALL_CLOSED, 'engine');
    expect(next).toEqual({ ...ALL_CLOSED, engine: true });
  });

  it('engine открыт → клик на ai → engine схлопывается, ai открыт', () => {
    const { next } = panelToggleReducer(ENGINE_OPEN, 'ai');
    expect(next).toEqual({ ...ALL_CLOSED, ai: true });
  });

  it('ai открыт → клик на book → ai схлопывается, book открыт', () => {
    const { next } = panelToggleReducer(AI_OPEN, 'book');
    expect(next).toEqual({ ...ALL_CLOSED, book: true });
  });

  it('повторный клик по уже открытой панели — схлопывает её, 0 открытых', () => {
    const { next } = panelToggleReducer(ENGINE_OPEN, 'engine');
    expect(next).toEqual(ALL_CLOSED);
  });

  it('gameInfo не входит в accordion — переключается отдельно', () => {
    const start: PanelStates = { ...ENGINE_OPEN, gameInfo: false };
    const { next } = panelToggleReducer(start, 'gameInfo');
    // engine остался открытым, gameInfo поменялся.
    expect(next).toEqual({ ...ENGINE_OPEN, gameInfo: true });
  });

  it('клик по gameInfo не меняет accordion-флаги', () => {
    const { next } = panelToggleReducer(AI_OPEN, 'gameInfo');
    expect(next.ai).toBe(true);
    expect(next.engine).toBe(false);
    expect(next.moves).toBe(false);
    expect(next.book).toBe(false);
  });

  it('последовательно: engine → moves → book → ai — открыта всегда последняя', () => {
    let st = ALL_CLOSED;
    st = panelToggleReducer(st, 'engine').next;
    expect(st.engine).toBe(true);
    st = panelToggleReducer(st, 'moves').next;
    expect(st).toMatchObject({ engine: false, moves: true });
    st = panelToggleReducer(st, 'book').next;
    expect(st).toMatchObject({ moves: false, book: true });
    st = panelToggleReducer(st, 'ai').next;
    expect(st).toMatchObject({ book: false, ai: true });
  });
});

describe('panelToggleReducer — engineWillCollapse (KS-3696)', () => {
  it('engine открыт → клик на ai → engineWillCollapse=true', () => {
    const { engineWillCollapse } = panelToggleReducer(ENGINE_OPEN, 'ai');
    expect(engineWillCollapse).toBe(true);
  });

  it('engine открыт → клик на engine (закрытие) → engineWillCollapse=true', () => {
    const { engineWillCollapse } = panelToggleReducer(ENGINE_OPEN, 'engine');
    expect(engineWillCollapse).toBe(true);
  });

  it('engine закрыт → клик на ai → engineWillCollapse=false', () => {
    const { engineWillCollapse } = panelToggleReducer(ALL_CLOSED, 'ai');
    expect(engineWillCollapse).toBe(false);
  });

  it('engine закрыт → клик на engine (открытие) → engineWillCollapse=false', () => {
    const { engineWillCollapse } = panelToggleReducer(ALL_CLOSED, 'engine');
    expect(engineWillCollapse).toBe(false);
  });

  it('клик по gameInfo → engineWillCollapse=false независимо от engine', () => {
    const { engineWillCollapse } = panelToggleReducer(ENGINE_OPEN, 'gameInfo');
    expect(engineWillCollapse).toBe(false);
  });
});
