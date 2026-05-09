/**
 * KS-2456 §5.6 + KS-2618. Тесты `explainFindUndefendedAttack`:
 * — три мотива (direct / removeDefender / discovered);
 * — стрелка `threat-target` идёт от РЕАЛЬНОГО атакующего, а не от
 *   `correctAnswer.to` (важно для discovered/removeDefender);
 * — ошибка пользователя.
 */
import { describe, expect, it } from 'vitest';
import type { TacticDrillDto, AnswerData } from '@kingside/shared';
import { explainFindUndefendedAttack } from './findUndefendedAttack';

function drill(over: Partial<TacticDrillDto>): TacticDrillDto {
  return {
    id: 'd-test',
    drillType: 'find-undefended-attack',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    answerShape: 'move',
    difficulty: 1,
    ...over,
  };
}

describe('explainFindUndefendedAttack', () => {
  describe('прямая атака (direct)', () => {
    // Bc1-b2: до хода чёрный конь e5 не атакован, защитников нет.
    // После Bb2 — слон с b2 атакует e5, защитников по-прежнему нет →
    // новая висящая угроза.
    const fen = '4k3/8/8/4n3/8/8/8/2B1K3 w - - 0 1';

    it('correct-move + threat-target от moveTo + correctDirect note', () => {
      const correct: AnswerData = { shape: 'move', from: 'c1', to: 'b2' };
      const result = explainFindUndefendedAttack({
        drill: drill({ fen }),
        correctAnswer: correct,
        userAnswer: correct,
        solved: true,
      });
      expect(result.arrows).toContainEqual({
        from: 'c1',
        to: 'b2',
        role: 'correct-move',
      });
      // Прямая атака: стрелка идёт от moveTo (b2), потому что атакует
      // именно ходящая фигура.
      expect(result.arrows).toContainEqual({
        from: 'b2',
        to: 'e5',
        role: 'threat-target',
      });
      expect(result.highlights).toContainEqual({ square: 'b2', role: 'correct' });
      expect(result.highlights).toContainEqual({ square: 'c1', role: 'context' });
      expect(result.highlights).toContainEqual({ square: 'e5', role: 'target' });
      expect(result.notes[0].key).toBe(
        'drills.explanation.findUndefendedAttack.correctDirect',
      );
      // KS-2482: ход correctAnswer выводится как SAN — Bb2.
      expect(result.notes[0].params).toMatchObject({
        square: 'e5',
        piece: 'n',
        san: 'Bb2',
      });
      expect(result.notes[0].tone).toBe('success');
    });

    it('неверный ход: wrong highlight + wrong note', () => {
      const correct: AnswerData = { shape: 'move', from: 'c1', to: 'b2' };
      const user: AnswerData = { shape: 'move', from: 'c1', to: 'a3' };
      const result = explainFindUndefendedAttack({
        drill: drill({ fen }),
        correctAnswer: correct,
        userAnswer: user,
        solved: false,
      });
      expect(result.highlights).toContainEqual({ square: 'a3', role: 'wrong' });
      const wrongNote = result.notes.find((n) => n.key.endsWith('.wrong'));
      expect(wrongNote?.tone).toBe('wrong');
      // KS-2482: SAN-нотация ошибочного хода.
      expect(wrongNote?.params).toMatchObject({ san: 'Ba3' });
    });
  });

  describe('вскрытая атака (discovered) — KS-2618', () => {
    // Регрессионный FEN из жалобы пользователя 2026-05-09 (Telegram
    // /tmp/telegram/326129609_0.jpg). Минимизировал backend в KS-2617:
    // конь f6 закрывает диагональ d8–h4 для чёрного ферзя, белый слон
    // на g5 защитников не имеет.
    //
    // Nf6→g8: до хода attackers('g5','b') = [], после — ['d8'].
    // moveTo = g8 ≠ d8 → discovered.
    const fen = 'k2q4/8/5n2/6B1/8/8/8/4K3 b - - 0 1';

    it('threat-target идёт от реального атакующего (d8), а не от moveTo (g8)', () => {
      const correct: AnswerData = { shape: 'move', from: 'f6', to: 'g8' };
      const result = explainFindUndefendedAttack({
        drill: drill({ fen, sideToMove: 'b' }),
        correctAnswer: correct,
        userAnswer: correct,
        solved: true,
      });
      // Стрелка хода — от f6 к g8 (это сам ход коня).
      expect(result.arrows).toContainEqual({
        from: 'f6',
        to: 'g8',
        role: 'correct-move',
      });
      // Атакующая стрелка — от ферзя d8 к слону g5, а НЕ от g8.
      expect(result.arrows).toContainEqual({
        from: 'd8',
        to: 'g5',
        role: 'threat-target',
      });
      expect(result.arrows).not.toContainEqual({
        from: 'g8',
        to: 'g5',
        role: 'threat-target',
      });
    });

    it('correctDiscovered note с attackerPiece=q, attackerSq=d8, square=g5', () => {
      const correct: AnswerData = { shape: 'move', from: 'f6', to: 'g8' };
      const result = explainFindUndefendedAttack({
        drill: drill({ fen, sideToMove: 'b' }),
        correctAnswer: correct,
        userAnswer: correct,
        solved: true,
      });
      const correctNote = result.notes.find((n) =>
        n.key.endsWith('.correctDiscovered'),
      );
      expect(correctNote).toBeDefined();
      expect(correctNote?.params).toMatchObject({
        san: 'Ng8',
        piece: 'b',
        square: 'g5',
        attackerPiece: 'q',
        attackerSq: 'd8',
      });
      expect(correctNote?.tone).toBe('success');
    });

    it('реальный атакующий (d8) подсвечен как context', () => {
      const correct: AnswerData = { shape: 'move', from: 'f6', to: 'g8' };
      const result = explainFindUndefendedAttack({
        drill: drill({ fen, sideToMove: 'b' }),
        correctAnswer: correct,
        userAnswer: correct,
        solved: true,
      });
      expect(result.highlights).toContainEqual({ square: 'd8', role: 'context' });
      expect(result.highlights).toContainEqual({ square: 'g5', role: 'target' });
    });
  });

  describe('снятие защитника (removeDefender)', () => {
    // Белая ладья d1 атакует чёрную пешку d7 по открытой d-вертикали.
    // Чёрный слон c8 защищает d7 (по диагонали c8-d7). Белая ладья c1
    // ходом Rxc8 убирает защитника. Ладья d1 продолжает атаковать d7,
    // защитников у пешки больше нет.
    //
    // Важно для теста: ходящая ладья после прихода на c8 НЕ атакует
    // d7 (с c8 — c-вертикаль и 8-горизонталь, d7 ни в одной из них) —
    // поэтому `moveTo` не среди attackersAfter, и мотив honest
    // removeDefender, а не direct.
    //
    // attackers('d7','w') до хода = ['d1'], после Rxc8 = ['d1'].
    // moveTo = c8 ≠ d1 → removeDefender (атака была и до хода).
    // Король на f8, не на e8 — иначе он сам защищал бы d7.
    const fen = '2b2k2/3p4/8/8/8/8/8/2RRK3 w - - 0 1';

    it('threat-target от стационарного атакующего (d1), не от moveTo (c8)', () => {
      const correct: AnswerData = { shape: 'move', from: 'c1', to: 'c8' };
      const result = explainFindUndefendedAttack({
        drill: drill({ fen }),
        correctAnswer: correct,
        userAnswer: correct,
        solved: true,
      });
      expect(result.arrows).toContainEqual({
        from: 'c1',
        to: 'c8',
        role: 'correct-move',
      });
      expect(result.arrows).toContainEqual({
        from: 'd1',
        to: 'd7',
        role: 'threat-target',
      });
      expect(result.arrows).not.toContainEqual({
        from: 'c8',
        to: 'd7',
        role: 'threat-target',
      });
    });

    it('correctRemoveDefender note', () => {
      const correct: AnswerData = { shape: 'move', from: 'c1', to: 'c8' };
      const result = explainFindUndefendedAttack({
        drill: drill({ fen }),
        correctAnswer: correct,
        userAnswer: correct,
        solved: true,
      });
      const correctNote = result.notes.find((n) =>
        n.key.endsWith('.correctRemoveDefender'),
      );
      expect(correctNote).toBeDefined();
      expect(correctNote?.params).toMatchObject({
        san: 'Rxc8+',
        piece: 'p',
        square: 'd7',
      });
      expect(correctNote?.tone).toBe('success');
    });
  });
});
