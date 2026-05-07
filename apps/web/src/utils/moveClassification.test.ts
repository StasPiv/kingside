/**
 * KS-2504 — тесты `classifyMove`. Покрывают пороги Lichess
 * (50/100/200), приоритет `isBest`, отрицательный cp-loss
 * (позиция улучшилась) и mate-оценки (≈ ±100000).
 */
import { describe, it, expect } from 'vitest';
import { classifyMove } from './moveClassification';

describe('classifyMove KS-2504', () => {
  it('isBest=true → best (даже если cp-loss большой)', () => {
    // Сценарий «лучший ход на edge сравнения» — все дальнейшие
    // пороги обходятся, метка идёт раньше.
    expect(
      classifyMove({ cpBefore: 100, cpAfter: 100, isBest: true }),
    ).toBe('best');
    expect(
      classifyMove({ cpBefore: 100, cpAfter: -500, isBest: true }),
    ).toBe('best');
  });

  it('cp-loss = 0 (не best) → good', () => {
    expect(
      classifyMove({ cpBefore: 50, cpAfter: 50, isBest: false }),
    ).toBe('good');
  });

  it('граница 49 → good', () => {
    expect(
      classifyMove({ cpBefore: 49, cpAfter: 0, isBest: false }),
    ).toBe('good');
  });

  it('граница 50 → inaccuracy', () => {
    expect(
      classifyMove({ cpBefore: 50, cpAfter: 0, isBest: false }),
    ).toBe('inaccuracy');
  });

  it('граница 99 → inaccuracy', () => {
    expect(
      classifyMove({ cpBefore: 99, cpAfter: 0, isBest: false }),
    ).toBe('inaccuracy');
  });

  it('граница 100 → mistake', () => {
    expect(
      classifyMove({ cpBefore: 100, cpAfter: 0, isBest: false }),
    ).toBe('mistake');
  });

  it('граница 199 → mistake', () => {
    expect(
      classifyMove({ cpBefore: 199, cpAfter: 0, isBest: false }),
    ).toBe('mistake');
  });

  it('граница 200 → blunder', () => {
    expect(
      classifyMove({ cpBefore: 200, cpAfter: 0, isBest: false }),
    ).toBe('blunder');
  });

  it('отрицательный cp-loss (позиция улучшилась) → good', () => {
    // Ход вывел в плюс — Lichess считает это good (хорошее решение,
    // не лучшее по PV, но не теряет evaluation).
    expect(
      classifyMove({ cpBefore: 0, cpAfter: 150, isBest: false }),
    ).toBe('good');
    expect(
      classifyMove({ cpBefore: -100, cpAfter: 50, isBest: false }),
    ).toBe('good');
  });

  it('mate-оценка кодируется большим числом → blunder при потере мата', () => {
    // Mate-в-X кодируется ≈ ±100000. Промазали мат — оценка падает,
    // cp-loss огромен, попадаем в blunder.
    expect(
      classifyMove({ cpBefore: 100000, cpAfter: 50, isBest: false }),
    ).toBe('blunder');
    // Зеркальный кейс: позиция была равной, теперь матуют → blunder.
    expect(
      classifyMove({ cpBefore: 0, cpAfter: -100000, isBest: false }),
    ).toBe('blunder');
  });

  it('экстремальные cp-значения не ломают классификацию', () => {
    expect(
      classifyMove({
        cpBefore: Number.MAX_SAFE_INTEGER,
        cpAfter: Number.MIN_SAFE_INTEGER,
        isBest: false,
      }),
    ).toBe('blunder');
  });

  it('isBest имеет приоритет над cp-loss=200 порогом', () => {
    // Защита от регрессии: даже если cpBefore − cpAfter ≥ 200, при
    // isBest=true возвращаем best (лучший ход по движку — он и есть
    // best, оценка после может «упасть» из-за horizon effect, но это
    // не делает ход хуже).
    expect(
      classifyMove({ cpBefore: 500, cpAfter: 0, isBest: true }),
    ).toBe('best');
  });
});
