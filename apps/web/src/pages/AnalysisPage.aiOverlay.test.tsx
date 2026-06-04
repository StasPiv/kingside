/**
 * KS-3691 / ADR-108b §7. Тесты порядка слоёв AI overlay в AnalysisPage.
 *
 * Сам AnalysisPage слишком тяжёлый, чтобы поднимать его в jsdom —
 * фактическая логика мерджа вынесена в чистый модуль
 * `apps/web/src/pages/analysis/aiOverlayMerge.ts`. Здесь проверяем:
 *   - порядок наложения стилей: system → AI → user, последний выигрывает
 *     по background-color;
 *   - порядок стрелок: system → AI → user, react-chessboard рисует в этом
 *     же порядке;
 *   - стабильность ключей при добавлении/удалении overlay (важно для
 *     `annotationsKey` AnalysisPage — он зависит от того, что массивы
 *     различаются по содержимому).
 */
import { describe, it, expect } from 'vitest';

import {
  composeArrowLayers,
  mergeSquareStyleLayers,
  omitLastMoveIfAiOverlayActive,
  type AiArrowRender,
} from './analysis/aiOverlayMerge';
import { LAST_MOVE_COLOR } from '../hooks/useBoardHighlights';

describe('mergeSquareStyleLayers — порядок слоёв (KS-3691)', () => {
  it('пустые слои → пустой результат', () => {
    expect(mergeSquareStyleLayers({}, {}, {})).toEqual({});
  });

  it('system+AI без пересечений → объединение', () => {
    const merged = mergeSquareStyleLayers(
      { e2: { backgroundColor: 'sys-last-move' } },
      { d5: { backgroundColor: 'ai-green' } },
      {},
    );
    expect(merged).toEqual({
      e2: { backgroundColor: 'sys-last-move' },
      d5: { backgroundColor: 'ai-green' },
    });
  });

  it('AI перекрывает system на одной клетке', () => {
    const merged = mergeSquareStyleLayers(
      { d5: { backgroundColor: 'sys' } },
      { d5: { backgroundColor: 'ai' } },
      {},
    );
    expect(merged.d5).toEqual({ backgroundColor: 'ai' });
  });

  it('user перекрывает AI на одной клетке (system → AI → user)', () => {
    const merged = mergeSquareStyleLayers(
      { d5: { backgroundColor: 'sys' } },
      { d5: { backgroundColor: 'ai' } },
      { d5: { backgroundColor: 'user' } },
    );
    expect(merged.d5).toEqual({ backgroundColor: 'user' });
  });

  it('у каждого слоя свой набор полей — merge, не replace по клетке', () => {
    const merged = mergeSquareStyleLayers(
      { d5: { backgroundColor: 'sys', boxShadow: 'sys-shadow' } },
      { d5: { backgroundColor: 'ai' } }, // не трогает boxShadow
      {},
    );
    expect(merged.d5).toEqual({
      backgroundColor: 'ai',
      boxShadow: 'sys-shadow',
    });
  });

  it('AI слой пустой → системные стили проходят как есть', () => {
    const sys = { e2: { backgroundColor: 'sys' } };
    expect(mergeSquareStyleLayers(sys, {}, {})).toEqual(sys);
  });
});

describe('composeArrowLayers — порядок стрелок (KS-3691)', () => {
  function arr(start: string, end: string, color: string): AiArrowRender {
    return { startSquare: start, endSquare: end, color };
  }

  it('пустые → пустой массив', () => {
    expect(composeArrowLayers([], [], [])).toEqual([]);
  });

  it('порядок system → AI → user сохраняется', () => {
    const result = composeArrowLayers(
      [arr('e2', 'e4', 'sys')],
      [arr('g1', 'f3', 'ai')],
      [arr('a2', 'a4', 'user')],
    );
    expect(result.map((a) => a.color)).toEqual(['sys', 'ai', 'user']);
  });

  it('массивы конкатенируются (не дедуплицируются по ключу)', () => {
    const result = composeArrowLayers(
      [arr('e2', 'e4', 'sys')],
      [arr('e2', 'e4', 'ai')],
      [arr('e2', 'e4', 'user')],
    );
    expect(result).toHaveLength(3);
  });

  it('AI слой пустой → system+user в порядке вставки', () => {
    const result = composeArrowLayers(
      [arr('e2', 'e4', 'sys')],
      [],
      [arr('a2', 'a4', 'user')],
    );
    expect(result).toEqual([
      arr('e2', 'e4', 'sys'),
      arr('a2', 'a4', 'user'),
    ]);
  });
});

// --- KS-3695: фильтр last-move под AI overlay ----------------------------

describe('omitLastMoveIfAiOverlayActive (KS-3695)', () => {
  it('AI overlay выключен → системные стили проходят как есть, last-move сохранён', () => {
    const sys = {
      e2: { backgroundColor: LAST_MOVE_COLOR },
      e4: { backgroundColor: LAST_MOVE_COLOR },
    };
    const out = omitLastMoveIfAiOverlayActive(
      sys,
      { from: 'e2', to: 'e4' },
      LAST_MOVE_COLOR,
      false,
    );
    expect(out).toEqual(sys);
  });

  it('AI overlay включён → клетки last-move удаляются', () => {
    const sys = {
      e2: { backgroundColor: LAST_MOVE_COLOR },
      e4: { backgroundColor: LAST_MOVE_COLOR },
    };
    const out = omitLastMoveIfAiOverlayActive(
      sys,
      { from: 'e2', to: 'e4' },
      LAST_MOVE_COLOR,
      true,
    );
    expect(out).toEqual({});
  });

  it('AI overlay включён, но клетка перекрыта selected-цветом → НЕ удаляется', () => {
    const sys = {
      // last-move from
      e2: { backgroundColor: LAST_MOVE_COLOR },
      // last-move to уже стал selected (пользователь кликнул на e4)
      e4: { backgroundColor: 'rgba(255, 213, 0, 0.55)' },
    };
    const out = omitLastMoveIfAiOverlayActive(
      sys,
      { from: 'e2', to: 'e4' },
      LAST_MOVE_COLOR,
      true,
    );
    expect(out).toEqual({
      e4: { backgroundColor: 'rgba(255, 213, 0, 0.55)' },
    });
  });

  it('AI overlay включён, lastMoveSquares=null → системные стили без изменений', () => {
    const sys = { a1: { backgroundColor: 'sys' } };
    expect(
      omitLastMoveIfAiOverlayActive(sys, null, LAST_MOVE_COLOR, true),
    ).toEqual(sys);
  });

  it('переключение AI overlay → last-move возвращается синхронно', () => {
    const sys = {
      e2: { backgroundColor: LAST_MOVE_COLOR },
      e4: { backgroundColor: LAST_MOVE_COLOR },
    };
    const lm = { from: 'e2', to: 'e4' };
    // AI overlay включён → пусто
    const hidden = omitLastMoveIfAiOverlayActive(
      sys,
      lm,
      LAST_MOVE_COLOR,
      true,
    );
    expect(hidden).toEqual({});
    // AI overlay выключен → клетки last-move обратно
    const shown = omitLastMoveIfAiOverlayActive(
      sys,
      lm,
      LAST_MOVE_COLOR,
      false,
    );
    expect(shown).toEqual(sys);
  });

  it('возвращает новый объект, не мутирует входной', () => {
    const sys = {
      e2: { backgroundColor: LAST_MOVE_COLOR },
      e4: { backgroundColor: LAST_MOVE_COLOR },
    };
    const before = JSON.stringify(sys);
    omitLastMoveIfAiOverlayActive(
      sys,
      { from: 'e2', to: 'e4' },
      LAST_MOVE_COLOR,
      true,
    );
    expect(JSON.stringify(sys)).toBe(before);
  });

  it('интеграция с mergeSquareStyleLayers — AI overlay поверх отфильтрованного системного слоя', () => {
    const sys = {
      e2: { backgroundColor: LAST_MOVE_COLOR },
      e4: { backgroundColor: LAST_MOVE_COLOR },
    };
    const ai = { d5: { backgroundColor: 'rgba(82, 184, 72, 0.8)' } };
    const user = {};
    const effective = omitLastMoveIfAiOverlayActive(
      sys,
      { from: 'e2', to: 'e4' },
      LAST_MOVE_COLOR,
      true,
    );
    const merged = mergeSquareStyleLayers(effective, ai, user);
    expect(merged).toEqual({
      d5: { backgroundColor: 'rgba(82, 184, 72, 0.8)' },
    });
  });
});

describe('annotationsKey-эквивалент: JSON.stringify(aiArrows)', () => {
  // KS-3691: annotationsKey AnalysisPage включает `JSON.stringify(aiArrows)`,
  // чтобы react-chessboard ремоунтился при смене overlay (показ/скрытие/
  // обновление). Проверяем минимальную инварианту: два разных набора
  // стрелок дают разные стабильные строки, один и тот же набор — равные.
  it('одинаковые массивы → одинаковая стабильная строка', () => {
    const a = [{ from: 'e2', to: 'e4', color: 'red' }];
    const b = [{ from: 'e2', to: 'e4', color: 'red' }];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('разные массивы → разные строки', () => {
    const a = [{ from: 'e2', to: 'e4', color: 'red' }];
    const b = [{ from: 'd2', to: 'd4', color: 'green' }];
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('пустой массив отличается от непустого', () => {
    expect(JSON.stringify([])).not.toBe(
      JSON.stringify([{ from: 'e2', to: 'e4', color: 'red' }]),
    );
  });
});
