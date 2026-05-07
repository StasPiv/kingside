import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { classifyMove, type MoveClass } from '../../utils/moveClassification';
import type { UserBestSnapshot } from './PlayVsEngineRunner';

/**
 * KS-2534 / ADR-047. Полная переработка «Разбор партии» из карточек в
 * стандартную PGN-нотацию с NAG-знаками к user-ходам и вариантом с
 * лучшим ходом в скобках после плохого хода. Источники:
 *  - `playedSans` — все полуходы (user + engine) в порядке игры.
 *  - `userBestLog` — классификация и bestUci по каждому user-ходу.
 *  - `initialFen` + `userSide` — для расчёта move-number / fenBefore.
 *
 * Engine-ходы рендерятся без знаков. По клику на ход родитель
 * получает `fenBefore` для подсветки позиции на доске (KS-2510).
 */

const NAG_BY_CLASS: Record<MoveClass, string> = {
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
      cls: MoveClass | null;
      fenBefore: string;
      halfIndex: number;
    }
  | {
      kind: 'variation';
      text: string;
      fenBefore: string;
      halfIndex: number;
    };

interface BuildArgs {
  initialFen: string;
  playedSans: string[];
  userBestLog: UserBestSnapshot[];
  userSide: 'w' | 'b';
}

/**
 * Собирает токены для рендера: префиксы номеров полных ходов,
 * пользовательские/движковые ходы с правильным NAG, и в варианте «(N. SAN!)»
 * с лучшим ходом — там, где user'ский ход хуже good. Все вычисления
 * локальные, без React (можно тестировать отдельно).
 */
export function buildPgnReviewTokens({
  initialFen,
  playedSans,
  userBestLog,
  userSide,
}: BuildArgs): Token[] {
  const c = new Chess(initialFen);
  let userIdx = 0;
  const tokens: Token[] = [];

  for (let i = 0; i < playedSans.length; i++) {
    const fenBefore = c.fen();
    const parts = fenBefore.split(' ');
    const mvNum = parseInt(parts[5] || '1', 10);
    const isWhite = parts[1] === 'w';
    const isUser = (isWhite ? 'w' : 'b') === userSide;

    // Префикс номера полного хода (стандарт PGN).
    if (isWhite) {
      tokens.push({ kind: 'movenum', text: `${mvNum}.` });
    } else if (i === 0) {
      tokens.push({ kind: 'movenum', text: `${mvNum}...` });
    }

    let nag = '';
    let cls: MoveClass | null = null;
    let variationText: string | null = null;

    if (isUser) {
      const log = userBestLog[userIdx];
      if (log && log.cpBefore != null && log.cpAfter != null) {
        const isBest = log.playedUci === log.bestUci;
        cls = classifyMove({
          cpBefore: log.cpBefore,
          cpAfter: log.cpAfter,
          isBest,
        });
        nag = NAG_BY_CLASS[cls];
        if (
          cls === 'inaccuracy' ||
          cls === 'mistake' ||
          cls === 'blunder'
        ) {
          // Лучший ход в SAN — играем bestUci на копии fenBefore.
          try {
            const c2 = new Chess(fenBefore);
            const mv = c2.move({
              from: log.bestUci.slice(0, 2),
              to: log.bestUci.slice(2, 4),
              promotion:
                log.bestUci.length > 4 ? log.bestUci[4] : undefined,
            });
            if (mv) {
              const prefix = isWhite ? `${mvNum}.` : `${mvNum}...`;
              variationText = `(${prefix} ${mv.san}!)`;
            }
          } catch {
            /* ignore — невалидный bestUci, вариант не показываем */
          }
        }
      } else if (log && log.playedUci === log.bestUci) {
        // нет cp-данных но played==best → !
        cls = 'best';
        nag = NAG_BY_CLASS.best;
      }
      userIdx++;
    }

    tokens.push({
      kind: 'move',
      san: playedSans[i],
      nag,
      isUser,
      cls,
      fenBefore,
      halfIndex: i,
    });
    if (variationText) {
      tokens.push({
        kind: 'variation',
        text: variationText,
        fenBefore,
        halfIndex: i,
      });
    }

    // Применяем фактический ход к Chess-инстансу.
    try {
      c.move(playedSans[i]);
    } catch {
      // Если SAN невалиден на текущей позиции — прерываем парсинг,
      // дальнейшие токены могут быть некорректными. Лучше показать
      // что собралось, чем падать.
      break;
    }
  }

  return tokens;
}

export interface PostGameReviewProps {
  /** Начальная позиция партии (puzzle.fen). */
  initialFen: string;
  /** Все полуходы (user + engine) в SAN, в порядке игры. */
  playedSans: string[];
  /** Pre/post-analyze snapshots для каждого user-хода. */
  userBestLog: UserBestSnapshot[];
  /** Чьим цветом играет user (по puzzle.fen side-to-move). */
  userSide: 'w' | 'b';
  /**
   * KS-2510 / KS-2534. Клик по ходу/варианту передаёт fenBefore —
   * родитель показывает позицию на доске. Не передан → токены не
   * кликабельны.
   */
  onSelectMove?: (info: { fenBefore: string }) => void;
}

export function PostGameReview({
  initialFen,
  playedSans,
  userBestLog,
  userSide,
  onSelectMove,
}: PostGameReviewProps) {
  const { t } = useTranslation();
  if (!playedSans.length) return null;

  const tokens = buildPgnReviewTokens({
    initialFen,
    playedSans,
    userBestLog,
    userSide,
  });

  const handleSelect = (fenBefore: string) => {
    if (onSelectMove) onSelectMove({ fenBefore });
  };

  return (
    <div className="post-game-review" data-testid="post-game-review">
      <h3 className="post-game-review__title">
        {t('puzzle.engine.review.headerLabel', 'Game review')}
      </h3>
      <div className="post-game-review__pgn" data-testid="post-game-review-pgn">
        {tokens.map((tok, i) => {
          if (tok.kind === 'movenum') {
            return (
              <span
                key={`mn-${i}`}
                className="post-game-review__movenum"
              >
                {tok.text}{' '}
              </span>
            );
          }
          if (tok.kind === 'variation') {
            const cb = onSelectMove
              ? () => handleSelect(tok.fenBefore)
              : undefined;
            return cb ? (
              <button
                key={`var-${i}`}
                type="button"
                className="post-game-review__variation"
                data-testid={`post-game-review-variation-${tok.halfIndex}`}
                onClick={cb}
              >
                {tok.text}{' '}
              </button>
            ) : (
              <span
                key={`var-${i}`}
                className="post-game-review__variation"
                data-testid={`post-game-review-variation-${tok.halfIndex}`}
              >
                {tok.text}{' '}
              </span>
            );
          }
          // move token
          const cls = tok.cls ?? 'engine';
          const className = `post-game-review__move post-game-review__move--${cls}${tok.isUser ? ' post-game-review__move--user' : ''}`;
          const cb = onSelectMove
            ? () => handleSelect(tok.fenBefore)
            : undefined;
          const content = (
            <>
              {tok.san}
              {tok.nag && (
                <span className="post-game-review__nag">{tok.nag}</span>
              )}
              {' '}
            </>
          );
          return cb ? (
            <button
              key={`mv-${i}`}
              type="button"
              className={className}
              data-testid={`post-game-review-move-${tok.halfIndex}`}
              data-class={tok.cls ?? ''}
              data-is-user={tok.isUser ? 'true' : 'false'}
              onClick={cb}
            >
              {content}
            </button>
          ) : (
            <span
              key={`mv-${i}`}
              className={className}
              data-testid={`post-game-review-move-${tok.halfIndex}`}
              data-class={tok.cls ?? ''}
              data-is-user={tok.isUser ? 'true' : 'false'}
            >
              {content}
            </span>
          );
        })}
      </div>
    </div>
  );
}
