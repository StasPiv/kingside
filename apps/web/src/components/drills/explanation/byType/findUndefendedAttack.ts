/**
 * KS-2456 §5.6 + KS-2454. Explanation для `find-undefended-attack`.
 *
 * shape='move'. После хода `correctAnswer.from→to` появляется новая
 * атака на вражескую фигуру, у которой нет защитников.
 *
 * KS-2455: `computeNewThreatsAfterMove` из `@kingside/shared` —
 * pure-функция, возвращает массив клеток новых висящих угроз
 * (король исключён по определению).
 *
 * # Три мотива (KS-2618)
 *
 * Predicate `find-undefended-attack` под одним выходом
 * (`correctAnswer.from→to` + `newThreats[]`) объединяет три разных
 * шахматных мотива. Различаем их по `chess.attackers(victimSquare, our)`
 * до и после хода:
 *
 *  1. **Прямая атака** — наша фигура встаёт на клетку, с которой сама
 *     бьёт жертву. Признак: `attackersAfter.includes(correctAnswer.to)`.
 *     Текст: «{san}: атакует {piece}({square}), защитников нет».
 *  2. **Снятие защитника** — жертва уже была атакована до хода (другой
 *     нашей фигурой), но имела защитников; ход уводит/разменивает
 *     защитника, и теперь жертва висит. Признак: `attackersAfter ⊆
 *     attackersBefore`, т. е. атаки были и до хода (correctAnswer.to не
 *     среди attackers'ов после хода). Текст: «{san}: убирает защитника,
 *     теперь {piece}({square}) под боем без защиты».
 *  3. **Вскрытая атака** — наша уходящая фигура закрывала линию
 *     дальнобойной нашей же фигуры; после ухода эта дальнобойная видит
 *     жертву. Признак: `attackersBefore` пуст, `attackersAfter`
 *     содержит клетку, не равную `correctAnswer.to`. Текст:
 *     «{san}: уходит с линии — {attackerPiece}({attackerSq}) бьёт
 *     {piece}({square}); защитников нет».
 *
 * Регрессионный кейс (KS-2618 / жалоба пользователя 2026-05-09):
 * `k2q4/8/5n2/6B1/8/8/8/4K3 b` — Nf6→g8 открывает ферзю d8 атаку на
 * слона g5. До хода `attackers('g5','b') = []`, после — `['d8']`,
 * `correctAnswer.to = 'g8' ≠ 'd8'` → discovered.
 *
 * Стрелки:
 *  - `correct-move` от correctAnswer.from → correctAnswer.to (сам ход).
 *  - `threat-target` от РЕАЛЬНОГО атакующего → каждая жертва. Для
 *    direct это совпадает с `correctAnswer.to`; для remove-defender и
 *    discovered — это другая клетка (стрелка пойдёт от d8, а не от g8).
 *
 * Подсветки:
 *  - `target` = клетка жертвы (если несколько — все).
 *  - `correct` = correctAnswer.to (приземление ходящей фигуры).
 *  - `context` = correctAnswer.from + клетки жертв + клетки реальных
 *    атакующих (если они отличаются от correctAnswer.to — для
 *    discovered/remove-defender это нужно, чтобы пользователь видел
 *    откуда удар).
 *  - `wrong` = userAnswer.to при ошибке.
 *
 * Notes:
 *  - Один из `correctDirect` / `correctRemoveDefender` /
 *    `correctDiscovered` (одна жертва) или `correctMulti` (несколько).
 *  - `wrong` — ошибка пользователя.
 */
import { Chess, type Color, type Square } from 'chess.js';
import { computeNewThreatsAfterMove } from '@kingside/shared';
import type {
  DrillExplanation,
  DrillExplanationArrow,
  DrillExplanationHighlight,
  DrillExplanationNote,
  ExplainDrillInput,
} from '../types';
import { EMPTY_EXPLANATION } from '../types';
import { formatSquareList, moveToSan } from '../helpers';

/**
 * Тип мотива угрозы. Под `direct` подходит и тот случай, когда
 * наша фигура одновременно встаёт И снимает защитника — приоритет за
 * прямой атакой, она яснее формулируется.
 */
type ThreatMotif = 'direct' | 'removeDefender' | 'discovered';

interface MotifResolution {
  motif: ThreatMotif;
  /** Клетка реального атакующего ПОСЛЕ хода (та, что бьёт жертву). */
  attackerSq: Square;
}

/**
 * Определить мотив угрозы. Контракт: `before` — позиция до хода,
 * `after` — после, `our` — цвет ходящей стороны, `victimSq` — клетка
 * новой висящей жертвы. Если `attackers(victim, our)` после хода пуст
 * (что для drill'а — аномалия), возвращаем `null`, вызывающее место
 * откатится на multi-форму.
 */
function resolveMotif(
  before: Chess,
  after: Chess,
  our: Color,
  moveTo: Square,
  victimSq: Square,
): MotifResolution | null {
  const attackersBefore = before.attackers(victimSq, our);
  const attackersAfter = after.attackers(victimSq, our);
  if (attackersAfter.length === 0) return null;

  if (attackersAfter.includes(moveTo)) {
    return { motif: 'direct', attackerSq: moveTo };
  }
  // Дальше moveTo не среди attackers — значит жертву бьёт другая
  // (стационарная) наша фигура.
  const stationaryAttacker = attackersAfter.find((sq) => sq !== moveTo);
  if (!stationaryAttacker) return null;

  // Если ATAKA уже была до хода (победитель бил, но был защитник) —
  // это снятие защитника. Иначе атаки до хода не было, появилась
  // только после освобождения линии — это вскрытая.
  const isRemoveDefender = attackersBefore.length > 0;
  return {
    motif: isRemoveDefender ? 'removeDefender' : 'discovered',
    attackerSq: stationaryAttacker as Square,
  };
}

export function explainFindUndefendedAttack(
  input: ExplainDrillInput,
): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'move') return EMPTY_EXPLANATION;

  const { newThreats } = computeNewThreatsAfterMove(drill.fen, {
    from: correctAnswer.from,
    to: correctAnswer.to,
    promotion: correctAnswer.promotion,
  });

  // Пробег по `before`/`after`-доскам — нужны типы жертв и
  // существование атакующего, плюс `attackers()` API для определения
  // мотива (KS-2618).
  let before: Chess;
  let after: Chess;
  try {
    before = new Chess(drill.fen);
    after = new Chess(drill.fen);
    after.move({
      from: correctAnswer.from,
      to: correctAnswer.to,
      ...(correctAnswer.promotion ? { promotion: correctAnswer.promotion } : {}),
    });
  } catch {
    return EMPTY_EXPLANATION;
  }
  if (!after.get(correctAnswer.to as Square)) return EMPTY_EXPLANATION;
  const ourColor = before.turn();

  // KS-2482: ход выводим в SAN (Bb2, Nf3xe5) — пользователь читает
  // натуральную алгебраику, а не UCI-склейку.
  const correctSan = moveToSan(
    drill.fen,
    correctAnswer.from,
    correctAnswer.to,
    correctAnswer.promotion,
  );

  // ---- Сборка стрелок и подсветок ----

  const arrows: DrillExplanationArrow[] = [
    {
      from: correctAnswer.from,
      to: correctAnswer.to,
      role: 'correct-move',
    },
  ];
  const highlights: DrillExplanationHighlight[] = [
    { square: correctAnswer.from, role: 'context' },
    { square: correctAnswer.to, role: 'correct' },
  ];

  // Для каждой жертвы определяем мотив, ставим стрелку от реального
  // атакующего (а не от moveTo, как было до KS-2618 — это вводило в
  // заблуждение в discovered/removeDefender случаях). Параллельно
  // запоминаем мотив первой жертвы — он используется для одиночного
  // note (multi-кейс остаётся с общим текстом).
  const resolutions = newThreats.map((sq) =>
    resolveMotif(before, after, ourColor, correctAnswer.to as Square, sq as Square),
  );

  for (let i = 0; i < newThreats.length; i += 1) {
    const sq = newThreats[i];
    const res = resolutions[i];
    const arrowFrom: Square = res ? res.attackerSq : (correctAnswer.to as Square);
    arrows.push({ from: arrowFrom, to: sq, role: 'threat-target' });
    highlights.push({ square: sq, role: 'target' });
    highlights.push({ square: sq, role: 'context' });
    // Для discovered/removeDefender реальный атакующий не совпадает с
    // moveTo — подсветим его как `context`, чтобы пользователь видел
    // откуда летит удар.
    if (res && res.attackerSq !== correctAnswer.to) {
      highlights.push({ square: res.attackerSq, role: 'context' });
    }
  }

  // ---- Note для одиночной жертвы: motif-aware текст ----

  const notes: DrillExplanationNote[] = [];
  if (newThreats.length === 1) {
    const sq = newThreats[0] as Square;
    const victim = after.get(sq);
    const res = resolutions[0];
    const baseParams = {
      san: correctSan,
      piece: victim?.type ?? '?',
      pieceKey: victim ? `chess.pieces.${victim.type}` : 'chess.pieces.unknown',
      square: sq,
    } as const;

    if (res?.motif === 'direct' || !res) {
      // `!res` — fallback на direct-формулировку (новых висящих helper
      // нашёл одну, но мотив определить не удалось — крайний edge).
      notes.push({
        key: 'drills.explanation.findUndefendedAttack.correctDirect',
        params: { ...baseParams },
        tone: solved ? 'success' : 'info',
      });
    } else {
      const attacker = after.get(res.attackerSq);
      const attackerParams = {
        ...baseParams,
        attackerPiece: attacker?.type ?? '?',
        // i18n-словарь `chess.pieces.*` использует буквенные ключи
        // (`p,n,b,r,q,k`) — оставляем тот же стиль, что и для `pieceKey`
        // выше. DrillExplanationPanel переведёт `chess.pieces.q` → «ферзь».
        attackerPieceKey: attacker
          ? `chess.pieces.${attacker.type}`
          : 'chess.pieces.unknown',
        attackerSq: res.attackerSq,
      };
      const key =
        res.motif === 'removeDefender'
          ? 'drills.explanation.findUndefendedAttack.correctRemoveDefender'
          : 'drills.explanation.findUndefendedAttack.correctDiscovered';
      notes.push({
        key,
        params: attackerParams,
        tone: solved ? 'success' : 'info',
      });
    }
  } else if (newThreats.length > 1) {
    notes.push({
      key: 'drills.explanation.findUndefendedAttack.correctMulti',
      params: {
        san: correctSan,
        count: newThreats.length,
        squares: formatSquareList(newThreats),
      },
      tone: solved ? 'success' : 'info',
    });
  } else {
    // Edge: drill утверждает «есть угроза», но helper не нашёл — fallback
    // на минимальное note, чтобы не оставить пустой explanation.
    notes.push({
      key: 'drills.explanation.findUndefendedAttack.correctMulti',
      params: {
        san: correctSan,
        count: 0,
        squares: '',
      },
      tone: solved ? 'success' : 'info',
    });
  }

  if (userAnswer && userAnswer.shape === 'move' && !solved) {
    const wrongTo = userAnswer.to as Square;
    if (wrongTo !== correctAnswer.to) {
      highlights.push({ square: wrongTo, role: 'wrong' });
    }
    const wrongSan = moveToSan(
      drill.fen,
      userAnswer.from,
      userAnswer.to,
      userAnswer.promotion,
    );
    notes.push({
      key: 'drills.explanation.findUndefendedAttack.wrong',
      params: { san: wrongSan },
      tone: 'wrong',
    });
  }

  return { arrows, highlights, notes };
}
