/**
 * KS-3725. Регрессионный тест адресации AI-комментариев «Из полного
 * разбора» по `currentGlobalIndex` в дереве разбора с вариантами.
 *
 * Симптом из жалобы пользователя StasPiv:
 *   - на ход 6...Be7 (до любой вариации) — корректно;
 *   - на ход 21.a5?? и 21...h5? (после нескольких вариантов в PGN) —
 *     панель AI показывала «Получить оценку», хотя в PGN комментарии
 *     есть и в `move.comment` они корректно лежат.
 *
 * Причина: `AnalysisPage` читал `history[currentGlobalIndex]?.comment`,
 * а `globalIndex` — сквозной счётчик по mainline + variations
 * (см. `parseAnnotatedPgn` в `PgnDeserializer.ts`). После первой же
 * вариации индексы mainline-ходов перестают совпадать с порядком в
 * массиве `history[]` (вариации тоже инкрементируют счётчик), и
 * array-индекс промахивается.
 *
 * Фикс: `searchInHistory(history, currentGlobalIndex)` — рекурсивная
 * прогулка по дереву (см. `ChessHistoryUtils.ts`), которая находит
 * узел независимо от того, mainline это или ветка.
 */
import { describe, it, expect } from 'vitest';

import { parseAnnotatedPgn } from './PgnDeserializer';
import { searchInHistory } from './ChessHistoryUtils';

// PGN-форма из реальной жалобы (с пробелами после номеров — в этом
// формате его сериализует `PgnSerializer`).
const PGN_WITH_VARIATIONS = `1. c4 e5 2. Nc3 Nf6 3. d3 d5 4. cxd5 Nxd5 5. Nf3 Nc6 6. g3 Be7!
{ Развитие слона на e7 — стандартное решение. }
7. Bg2 Be6 8. O-O O-O 9. a3 ( 9. Bd2 a5 ) 9... Qd7 10. Nxd5 Bxd5 11. b4 f6 12. Bb2 Rfe8 13. b5 Nd4 14. Nxd4 exd4 15. a4 Bxg2 16. Kxg2 Qd5+ 17. Kg1 Bc5 18. Rc1 b6 19. Qc2 ( 19. Rc4 h5 20. Bc1 Re7 21. f3 )
19... Re6 ( 19... Re7 20. Qc4 ) 20. Rfe1 Rae8 21. a5??
{ Продвижение пешки на a5 — серьёзный просчёт. }
( 21. Qc4 Qd7 22. Rc2 g5 23. Bc1 Kg7 24. Qb3 Qd6 )
21... h5?
{ Ход h7-h5 — серьёзная неточность. }
`;

describe('KS-3725: AI-комментарии «Из полного разбора» по дереву разбора', () => {
  it('globalIndex mainline-ходов после вариантов выходит за длину history[]', () => {
    const history = parseAnnotatedPgn(PGN_WITH_VARIATIONS);
    const a5 = history.find((m) => m.san === 'a5')!;
    const h5 = history.find((m) => m.san === 'h5')!;

    // 1) Сами ходы — в mainline, и комментарий у них в PGN есть.
    expect(a5).toBeDefined();
    expect(h5).toBeDefined();
    expect(a5.comment).toContain('Продвижение');
    expect(h5.comment).toContain('h7-h5');

    // 2) Но globalIndex уже выходит за длину mainline-массива — так
    //    случилось из-за вариантов, которые тоже инкрементируют общий
    //    счётчик в `parseAnnotatedPgn`. Это и есть корень бага: старый
    //    callsite `history[currentGlobalIndex]?.comment` промахивался.
    expect(a5.globalIndex).toBeGreaterThanOrEqual(history.length);
    expect(h5.globalIndex).toBeGreaterThanOrEqual(history.length);
    expect(history[a5.globalIndex]).toBeUndefined();
    expect(history[h5.globalIndex]).toBeUndefined();
  });

  it('searchInHistory возвращает узел по globalIndex даже после вариантов', () => {
    const history = parseAnnotatedPgn(PGN_WITH_VARIATIONS);
    const be7 = history.find((m) => m.san === 'Be7')!;
    const a5 = history.find((m) => m.san === 'a5')!;
    const h5 = history.find((m) => m.san === 'h5')!;

    // Комментарий узла, к которому привязан AI-разбор, в дереве лежит
    // под move.comment — `searchInHistory` находит его по globalIndex.
    expect(searchInHistory(history, be7.globalIndex)?.comment).toContain(
      'Развитие слона',
    );
    expect(searchInHistory(history, a5.globalIndex)?.comment).toContain(
      'Продвижение',
    );
    expect(searchInHistory(history, h5.globalIndex)?.comment).toContain(
      'h7-h5',
    );
  });

  it('ход внутри варианта тоже находится по globalIndex (на случай навигации в ветку)', () => {
    const history = parseAnnotatedPgn(PGN_WITH_VARIATIONS);
    // 9. a3 имеет одну вариацию (9. Bd2 a5). Найдём первый ход вариации
    // через дерево и проверим, что searchInHistory находит его по своему
    // globalIndex.
    const a3 = history.find((m) => m.san === 'a3')!;
    expect(a3.variations?.length).toBeGreaterThan(0);
    const bd2 = a3.variations![0][0];
    expect(bd2.san).toBe('Bd2');
    expect(searchInHistory(history, bd2.globalIndex)?.san).toBe('Bd2');
  });
});
