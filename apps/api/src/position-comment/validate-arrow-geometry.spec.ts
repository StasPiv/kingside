/**
 * KS-4069. Unit-тесты геометрической валидации overlay-стрелок.
 *
 * Покрывает оба сценария из Gherkin задачи:
 *  - фактор называет цель, недостижимую для фигуры → arrow не рисуется;
 *  - цель достижима → arrow рисуется.
 */
import { isArrowGeometryValid } from './validate-arrow-geometry';

describe('isArrowGeometryValid (KS-4069)', () => {
  // ─── Gherkin: цель НЕ достижима для фигуры ────────────────────────

  describe('фактор называет цель, недостижимую для фигуры', () => {
    it('из задачи: слон c4 → h6 (диагональ заблокирована своей d5 и чужой e6)', () => {
      // Минимальный валидный FEN, повторяющий ключевую геометрию из жалобы
      // пользователя (KS-4069): белый слон c4, белая пешка d5, чёрная пешка
      // e6, чёрный конь h6, плюс короли для валидности позиции.
      const fen = '7k/8/4p2n/3P4/2B5/8/8/4K3 w - - 0 1';
      expect(isArrowGeometryValid('c4', 'h6', fen)).toBe(false);
    });

    it('слон c4 → h6 — клетки даже не на одной диагонали (без блока)', () => {
      // Пустая доска, белый слон c4, без блокировок.
      // c4 → h6: разница файлов = 5, разница горизонталей = 2.
      // Геометрически это не диагональ слона.
      const fen = '7k/8/8/8/2B5/8/8/4K3 w - - 0 1';
      expect(isArrowGeometryValid('c4', 'h6', fen)).toBe(false);
    });

    it('ладья a1 → h8 (по диагонали — ладья так не ходит)', () => {
      const fen = '7k/8/8/8/8/8/8/R3K3 w - - 0 1';
      expect(isArrowGeometryValid('a1', 'h8', fen)).toBe(false);
    });

    it('ладья a1 → a8 через свою пешку a4 (блок собственным)', () => {
      const fen = '4k3/8/8/8/P7/8/8/R3K3 w - - 0 1';
      expect(isArrowGeometryValid('a1', 'a8', fen)).toBe(false);
    });

    it('ладья a1 → a8 через чужую пешку a4 (блок чужим)', () => {
      const fen = '4k3/8/8/8/p7/8/8/R3K3 w - - 0 1';
      // Ладья всё-таки атакует пешку a4 — но не a8.
      expect(isArrowGeometryValid('a1', 'a4', fen)).toBe(true);
      expect(isArrowGeometryValid('a1', 'a8', fen)).toBe(false);
    });

    it('конь b1 → d4 (не конский ход)', () => {
      const fen = '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1';
      expect(isArrowGeometryValid('b1', 'd4', fen)).toBe(false);
    });

    it('пустая клетка from → стрелка не рисуется', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(isArrowGeometryValid('e4', 'e5', fen)).toBe(false);
    });

    it('битый FEN → false', () => {
      expect(isArrowGeometryValid('e2', 'e4', 'totally-not-a-fen')).toBe(false);
    });

    it('битые клетки → false', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(isArrowGeometryValid('z9', 'e4', fen)).toBe(false);
      expect(isArrowGeometryValid('e2', 'i9', fen)).toBe(false);
    });

    it('from === to → false', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(isArrowGeometryValid('e2', 'e2', fen)).toBe(false);
    });

    it('пешка e2 → e5 (на 3 клетки) — невалидно', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(isArrowGeometryValid('e2', 'e5', fen)).toBe(false);
    });

    it('пешка e3 → e5 (двойной ход не со стартовой горизонтали)', () => {
      const fen = '4k3/8/8/8/8/4P3/8/4K3 w - - 0 1';
      expect(isArrowGeometryValid('e3', 'e5', fen)).toBe(false);
    });

    it('пешка e2 → e4 через свою фигуру e3', () => {
      const fen = '4k3/8/8/8/8/4N3/4P3/4K3 w - - 0 1';
      expect(isArrowGeometryValid('e2', 'e4', fen)).toBe(false);
    });

    it('пешка e2 → e3 если на e3 чужая фигура — невалидно (пешка вперёд не берёт)', () => {
      const fen = '4k3/8/8/8/8/4p3/4P3/4K3 w - - 0 1';
      expect(isArrowGeometryValid('e2', 'e3', fen)).toBe(false);
    });
  });

  // ─── Gherkin: цель достижима ──────────────────────────────────────

  describe('цель достижима для фигуры', () => {
    it('слон c4 атакует пешку d5 (соседняя клетка по диагонали)', () => {
      const fen = '4k3/8/8/3p4/2B5/8/8/4K3 w - - 0 1';
      expect(isArrowGeometryValid('c4', 'd5', fen)).toBe(true);
    });

    it('слон c4 атакует длинную диагональ до f7 (без блока)', () => {
      const fen = '4k3/5p2/8/8/2B5/8/8/4K3 w - - 0 1';
      expect(isArrowGeometryValid('c4', 'f7', fen)).toBe(true);
    });

    it('ферзь d1 → h5 по диагонали в начальной позиции (без блока)', () => {
      const fen = '4k3/8/8/8/8/8/8/3Q3K w - - 0 1';
      expect(isArrowGeometryValid('d1', 'h5', fen)).toBe(true);
    });

    it('конь b1 → c3 (валидный конский ход)', () => {
      const fen = '4k3/8/8/8/8/8/8/1N2K3 w - - 0 1';
      expect(isArrowGeometryValid('b1', 'c3', fen)).toBe(true);
    });

    it('защита своей фигуры считается валидной стрелкой', () => {
      // Белая ладья a1 «защищает» белую пешку a4 — clear attacker'ы
      // включают a1 при запросе attackedBy=white.
      const fen = '4k3/8/8/8/P7/8/8/R3K3 w - - 0 1';
      expect(isArrowGeometryValid('a1', 'a4', fen)).toBe(true);
    });

    it('пешка e2 → e3 (одиночный ход)', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(isArrowGeometryValid('e2', 'e3', fen)).toBe(true);
    });

    it('пешка e2 → e4 (двойной ход со стартовой горизонтали)', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(isArrowGeometryValid('e2', 'e4', fen)).toBe(true);
    });

    it('пешка e2 атакует d3 (взятие по диагонали)', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      expect(isArrowGeometryValid('e2', 'd3', fen)).toBe(true);
      expect(isArrowGeometryValid('e2', 'f3', fen)).toBe(true);
    });

    it('чёрная пешка e7 → e5 (двойной ход)', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';
      expect(isArrowGeometryValid('e7', 'e5', fen)).toBe(true);
    });

    it('связанная фигура всё равно «атакует» цель (геометрия, не легальность)', () => {
      // Белый слон c4 связан чёрным ферзём по диагонали; геометрически
      // он по-прежнему атакует чёрного коня на d5 — стрелка валидна.
      const fen = '4k3/8/8/3n4/2B5/8/8/3qK3 w - - 0 1';
      expect(isArrowGeometryValid('c4', 'd5', fen)).toBe(true);
    });
  });
});
