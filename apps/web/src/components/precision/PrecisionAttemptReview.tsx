import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { PrecisionMoveDto } from '@kingside/shared';

/**
 * KS-2754. «Разбор партии» на странице `/precision/attempts/:id`.
 *
 * Зачем отдельный компонент (не переиспользуем `PostGameReview`):
 *  - PostGameReview ждёт `WdlDistribution {w,d,l}` per-mille, которого в
 *    PrecisionMoveDto нет (backend хранит signed scalar; см. KS-2741).
 *  - Здесь у нас другие исходные данные: НЕ полный `playedSans`, а
 *    `moves: PrecisionMoveDto[]` (только user-полуходы) + `engineUci`
 *    с ответом движка прямо в DTO (KS-2754 backend).
 *
 * Что показываем (по ADR-057 / KS-2754):
 *  1. Полная партия: user → engine → user → engine → … в стандартной
 *     SAN-нотации с правильной нумерацией полных ходов (`22... g6`,
 *     `23. f5`, `23... h5`, и т.д.). Нумерация и сторона берутся
 *     напрямую из `fenBefore` каждого полухода — без зависимости от
 *     auto-tracking chess.js, чтобы не сломаться, если где-то выпал
 *     engine-полуход.
 *  2. Каждый ход кликабельный — `onSelectMove(fenBefore)` родителю
 *     для подсветки позиции на доске.
 *  3. Для user-хода: NAG по classification (! / ?! / ? / ??) и, если
 *     ход НЕ best, инлайн-аннотация «Лучше было: <SAN>, <eval>».
 *  4. Engine-ходы рендерим как SAN без аннотаций.
 *
 * Источник engine-SAN: только `engineUci` из DTO (KS-2754 backend).
 * Применяем его на позицию `apply(playedUci, fenBefore)`, получаем SAN.
 * Без `engineUci` (legacy-attempt'ы / fallback-движок) engine-полуход
 * не рисуется — реконструкции на фронте намеренно нет, чтобы не было
 * скрытых расхождений с реальной партией.
 *
 * Источник WDL-оценки в «Лучше: …»: `m.wdlBefore` (POV user). Без
 * distribution annotation не рисуем (cp без распределения для
 * пользователя информационно неполноценный).
 */

const NAG_BY_CLASS: Record<PrecisionMoveDto['classification'], string> = {
  best: '!',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

type Token =
  | { kind: 'movenum'; text: string }
  | {
      kind: 'move';
      san: string;
      nag: string;
      isUser: boolean;
      classification: PrecisionMoveDto['classification'] | null;
      fenBefore: string;
      halfIndex: number;
      /** Для не-best user-ходов: SAN сильнейшего хода + cp-eval, оба
       *  готовые к рендеру. `null` если ход best или данных не хватило. */
      best: { san: string; evalText: string } | null;
    };

interface BuildArgs {
  initialFen: string;
  moves: PrecisionMoveDto[];
}

/**
 * Per-mille → процент: `730` → `73%`. На случай некратных 10 — округляем.
 */
function permilleToPct(n: number): number {
  return Math.round(n / 10);
}

/**
 * KS-2754. Основная метрика проекта — WDL вероятностные шансы.
 * Распределение приходит POV сделавшего ход (user). Формат `W/D/L%`,
 * например `73/20/7%`. Если distribution отсутствует — annotation не
 * рисуем (без cp-фоллбэка: cp без распределения для пользователя
 * информационно бесполезен).
 */
function formatWdl(wdl: { w: number; d: number; l: number }): string {
  return `${permilleToPct(wdl.w)}/${permilleToPct(wdl.d)}/${permilleToPct(wdl.l)}%`;
}

/** Применить UCI к FEN через chess.js. Возвращает {fenAfter, san} или null. */
function applyUci(
  fen: string,
  uci: string,
): { fenAfter: string; san: string } | null {
  try {
    const c = new Chess(fen);
    const mv = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    if (!mv) return null;
    return { fenAfter: c.fen(), san: mv.san };
  } catch {
    return null;
  }
}

export function buildAttemptReviewTokens({
  initialFen: _initialFen,
  moves,
}: BuildArgs): Token[] {
  const tokens: Token[] = [];
  let halfIndex = 0;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const userFen = m.fenBefore;
    const parts = userFen.split(' ');
    const mvNum = parseInt(parts[5] || '1', 10);
    const isWhite = parts[1] === 'w';

    // Префикс полного номера хода для user-полухода.
    if (isWhite) {
      tokens.push({ kind: 'movenum', text: `${mvNum}.` });
    } else if (halfIndex === 0) {
      // На первом полуходе чёрных — стандартный `N...`.
      tokens.push({ kind: 'movenum', text: `${mvNum}...` });
    }

    // 1) User-ход. Если UCI невалиден на текущем FEN — обрываем.
    const userApply = applyUci(userFen, m.playedUci);
    if (!userApply) break;

    const isBest = m.playedUci === m.bestUci;
    let bestSlot: Token extends { kind: 'move' } ? Token['best'] : never;
    bestSlot = null as never;
    if (!isBest && m.bestUci && m.wdlBefore) {
      // wdlBefore — POV user (делает ход). Best маршрут сохраняет эту
      // оценку. Если distribution нет (legacy / движок без UCI_ShowWDL)
      // — annotation не рисуем (без cp-фоллбэка).
      const bestApply = applyUci(userFen, m.bestUci);
      if (bestApply) {
        bestSlot = {
          san: bestApply.san,
          evalText: formatWdl(m.wdlBefore),
        } as never;
      }
    }

    tokens.push({
      kind: 'move',
      san: userApply.san,
      nag: NAG_BY_CLASS[m.classification],
      isUser: true,
      classification: m.classification,
      fenBefore: userFen,
      halfIndex,
      best: bestSlot as { san: string; evalText: string } | null,
    });
    halfIndex += 1;

    // 2) Engine-ответ. Только из `engineUci` (без реконструкции для
    // legacy: ненадёжно). Нет UCI — engine-полуход не рисуем.
    const fenAfterUser = userApply.fenAfter;
    let engineSan: string | null = null;
    if (m.engineUci) {
      const engineApply = applyUci(fenAfterUser, m.engineUci);
      if (engineApply) engineSan = engineApply.san;
    }

    if (engineSan) {
      // Engine-полуход: нумерацию читаем из `fenAfterUser`, а не из
      // chess.js-state, потому что нам не важен счётчик ходов — важна
      // сторона и movenum, и оба корректно лежат в FEN.
      const engineParts = fenAfterUser.split(' ');
      const engineMvNum = parseInt(engineParts[5] || '1', 10);
      const engineIsWhite = engineParts[1] === 'w';
      if (engineIsWhite) {
        tokens.push({ kind: 'movenum', text: `${engineMvNum}.` });
      } else if (halfIndex === 0) {
        // Маловероятно (engine ходит первым только если user пропустил
        // первый ход), но на всякий случай.
        tokens.push({ kind: 'movenum', text: `${engineMvNum}...` });
      }
      tokens.push({
        kind: 'move',
        san: engineSan,
        nag: '',
        isUser: false,
        classification: null,
        fenBefore: fenAfterUser,
        halfIndex,
        best: null,
      });
      halfIndex += 1;
    }
  }

  return tokens;
}

export interface PrecisionAttemptReviewProps {
  /** Начальная позиция пазла (`puzzle.fen`). */
  initialFen: string;
  /** Массив user-ходов из `PrecisionAttemptDetail.moves`. */
  moves: PrecisionMoveDto[];
  /** Чьим цветом играл user (по side-to-move в `initialFen`). */
  userSide: 'w' | 'b';
  /** Клик по ходу → родителю передаём fenBefore для подсветки доски. */
  onSelectMove?: (info: { fenBefore: string }) => void;
}

export function PrecisionAttemptReview({
  initialFen,
  moves,
  userSide: _userSide,
  onSelectMove,
}: PrecisionAttemptReviewProps) {
  const { t } = useTranslation();
  const tokens = useMemo(
    () => buildAttemptReviewTokens({ initialFen, moves }),
    [initialFen, moves],
  );

  if (!moves.length || !tokens.length) return null;

  const handleClick = (fenBefore: string) => {
    if (onSelectMove) onSelectMove({ fenBefore });
  };

  return (
    <div
      className="precision-attempt-review"
      data-testid="precision-attempt-review"
    >
      <h3 className="precision-attempt-review__title">
        {t('precisionAttempt.review.title', 'Game review')}
      </h3>
      <div
        className="precision-attempt-review__pgn"
        data-testid="precision-attempt-review-pgn"
      >
        {tokens.map((tok, i) => {
          if (tok.kind === 'movenum') {
            return (
              <span
                key={`mn-${i}`}
                className="precision-attempt-review__movenum"
              >
                {tok.text}{' '}
              </span>
            );
          }
          // KS-2754 follow-up: ходы — обычным inline-текстом, без кнопок
          // с рамкой; NAG (! ?! ? ??) рядом с SAN несёт классификацию.
          // Оценка хода и «Лучше: …» убраны — оценка живёт на sparkline
          // вверху страницы (KS-2754 «Динамика WDL»). Клик по ходу
          // по-прежнему показывает позицию на доске.
          const classModifier = tok.classification
            ? ` precision-attempt-review__move--${tok.classification}`
            : '';
          const userModifier = tok.isUser
            ? ' precision-attempt-review__move--user'
            : ' precision-attempt-review__move--engine';
          return (
            <span
              key={`mv-${i}`}
              role={tok.isUser ? 'button' : undefined}
              tabIndex={tok.isUser ? 0 : undefined}
              onClick={
                tok.isUser ? () => handleClick(tok.fenBefore) : undefined
              }
              onKeyDown={
                tok.isUser
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleClick(tok.fenBefore);
                      }
                    }
                  : undefined
              }
              className={`precision-attempt-review__move${userModifier}${classModifier}`}
              data-testid={`precision-attempt-review-move-${tok.halfIndex}`}
              data-user={tok.isUser ? 'true' : 'false'}
              data-classification={tok.classification ?? ''}
              style={tok.isUser ? { cursor: 'pointer' } : undefined}
            >
              {tok.san}
              {tok.nag}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
}
