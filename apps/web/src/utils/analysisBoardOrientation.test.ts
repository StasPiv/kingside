/**
 * KS-3044 — тесты персистенции ориентации доски Workshop-анализа.
 * Используем happy-dom localStorage напрямую — фикстуры на in-memory
 * mock'е смысла нет, всё API синхронное.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getStoredBoardOrientation,
  setStoredBoardOrientation,
  clearStoredBoardOrientation,
} from './analysisBoardOrientation';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';

describe('analysisBoardOrientation — get/set (KS-3044)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('новая запись: getStoredBoardOrientation для неизвестного id → null', () => {
    expect(getStoredBoardOrientation(ID_A)).toBeNull();
  });

  it('после setStoredBoardOrientation(id, "black") → getStoredBoardOrientation возвращает "black"', () => {
    setStoredBoardOrientation(ID_A, 'black');
    expect(getStoredBoardOrientation(ID_A)).toBe('black');
  });

  it('после setStoredBoardOrientation(id, "white") → возвращает "white"', () => {
    setStoredBoardOrientation(ID_A, 'white');
    expect(getStoredBoardOrientation(ID_A)).toBe('white');
  });

  it('перезапись: первый "black", потом "white" — итог "white"', () => {
    setStoredBoardOrientation(ID_A, 'black');
    setStoredBoardOrientation(ID_A, 'white');
    expect(getStoredBoardOrientation(ID_A)).toBe('white');
  });

  it('значения изолированы по id: ID_A=black, ID_B=null', () => {
    setStoredBoardOrientation(ID_A, 'black');
    expect(getStoredBoardOrientation(ID_A)).toBe('black');
    expect(getStoredBoardOrientation(ID_B)).toBeNull();
  });

  it('clearStoredBoardOrientation удаляет конкретный id, не трогает соседей', () => {
    setStoredBoardOrientation(ID_A, 'black');
    setStoredBoardOrientation(ID_B, 'black');
    clearStoredBoardOrientation(ID_A);
    expect(getStoredBoardOrientation(ID_A)).toBeNull();
    expect(getStoredBoardOrientation(ID_B)).toBe('black');
  });

  it('id=undefined/null: get → null, set/clear — no-op без исключений', () => {
    expect(() => setStoredBoardOrientation(undefined, 'black')).not.toThrow();
    expect(() => setStoredBoardOrientation(null, 'black')).not.toThrow();
    expect(() => clearStoredBoardOrientation(undefined)).not.toThrow();
    expect(getStoredBoardOrientation(undefined)).toBeNull();
    expect(getStoredBoardOrientation(null)).toBeNull();
  });

  it('id=пустая строка: get → null, set — no-op', () => {
    setStoredBoardOrientation('', 'black');
    expect(getStoredBoardOrientation('')).toBeNull();
  });

  it('битое значение в localStorage (не "white"/"black") → null, как у новой записи', () => {
    localStorage.setItem(`analysis:orientation:${ID_A}`, 'garbage');
    expect(getStoredBoardOrientation(ID_A)).toBeNull();
  });

  it('ключ формируется как analysis:orientation:<id> — backward-compat контракт', () => {
    setStoredBoardOrientation(ID_A, 'black');
    expect(localStorage.getItem(`analysis:orientation:${ID_A}`)).toBe('black');
  });
});
