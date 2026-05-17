import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
// KS-3068: единая классификация хода — теперь через `@kingside/shared`
// (ADR-066, WDL-loss primary с cp-fallback). До этого PostGameReview
// использовал устаревший cp-only вариант из `utils/moveClassification`,
// что приводило к ложным `??` в выигранных позициях (Nd2 100/0/0→100/0/0
// помечался `blunder`, потому что cp прыгал, хотя WDL не менялся).
// Источник истины — та же функция, что выводит `classification` на
// backend'е для `PrecisionMoveDto`, поэтому drill-down и история теперь
// совпадают по NAG.
import { classifyMove, type MoveClass } from '@kingside/shared';
import { permilleToPercent } from '../../utils/chessFormat';
import type { WdlDistribution } from '../../utils/engineAdapter';
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

/**
 * KS-2686. Метаданные оценки, отображаемые рядом с user-ходом и его
 * вариантом: WDL после фактически сыгранного user-хода, WDL после
 * лучшего хода (по pre-analyze) и глубина анализа. Все поля
 * опциональные — если данных нет (старый движок без UCI_ShowWDL,
 * pre/post-analyze упал), просто не рендерим этот фрагмент.
 */
export type ReviewEvalMeta = {
  /** Глубина анализа Stockfish (одинаковая в pre и post-analyze). */
  depth: number | null;
  /** WDL POV user после сыгранного user-хода (per-mille). */
  wdlPlayed: WdlDistribution | null;
  /** WDL POV user после лучшего хода (PV1 от движка, per-mille). */
  wdlBest: WdlDistribution | null;
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
      /** KS-2686: meta показывается только для inaccuracy/mistake/blunder. */
      meta: ReviewEvalMeta | null;
    }
  | {
      kind: 'variation';
      text: string;
      fenBefore: string;
      halfIndex: number;
      /** KS-2686: meta варианта (best WDL + depth). */
      meta: ReviewEvalMeta | null;
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
    let moveMeta: ReviewEvalMeta | null = null;
    let variationMeta: ReviewEvalMeta | null = null;

    if (isUser) {
      const log = userBestLog[userIdx];
      if (log && (log.wdlBefore || log.cpBefore != null) && (log.wdlAfter || log.cpAfter != null)) {
        const isBest = log.playedUci === log.bestUci;
        // KS-3068: WDL primary (ADR-066). cp передаём как fallback —
        // если pre/post-analyze не успел снять WDL (старые сборки
        // Stockfish без UCI_ShowWDL), классификатор сам перейдёт
        // на cp через winPctFromCp.
        cls = classifyMove({
          wdlBefore: log.wdlBefore,
          wdlAfter: log.wdlAfter,
          cpBefore: log.cpBefore,
          cpAfter: log.cpAfter,
          isBestMove: isBest,
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
          // KS-2686: meta для плохого хода и его варианта. wdlBest и
          // wdlPlayed — POV user, depth — общий.
          moveMeta = {
            depth: log.depth,
            wdlPlayed: log.wdlAfter,
            wdlBest: log.wdlBefore,
          };
          variationMeta = moveMeta;
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
      meta: moveMeta,
    });
    if (variationText) {
      tokens.push({
        kind: 'variation',
        text: variationText,
        fenBefore,
        halfIndex: i,
        meta: variationMeta,
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

  /**
   * KS-2686. Компактный inline-формат WDL — три числа через `/`,
   * например «12/40/48%». null-пол поля → возвращаем null (вызывающий
   * скрывает фрагмент целиком).
   */
  const fmtWdl = (wdl: WdlDistribution | null): string | null => {
    if (!wdl) return null;
    return `${permilleToPercent(wdl.w)}/${permilleToPercent(wdl.d)}/${permilleToPercent(wdl.l)}%`;
  };

  /**
   * KS-2686. Тултип с расшифровкой «W/D/L%» — на hover показывается
   * длинный текст «Win X% · Draw Y% · Loss Z%». Браузерный native
   * title — без лишнего JS.
   */
  const titleWdl = (wdl: WdlDistribution | null): string | undefined => {
    if (!wdl) return undefined;
    return `${t('puzzle.engine.summary.win', 'Win')} ${permilleToPercent(wdl.w)}% · ${t('puzzle.engine.summary.draw', 'Draw')} ${permilleToPercent(wdl.d)}% · ${t('puzzle.engine.summary.loss', 'Loss')} ${permilleToPercent(wdl.l)}%`;
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
            // KS-2686: к варианту с лучшим ходом добавляем оценку:
            //   «(35... Nf4!) [Best W/D/L% · d=14]»
            const wdlBestText = fmtWdl(tok.meta?.wdlBest ?? null);
            const depthText =
              tok.meta?.depth != null
                ? t('puzzle.engine.review.depthShort', 'd={{depth}}', {
                    depth: tok.meta.depth,
                  })
                : null;
            const metaParts = [
              wdlBestText
                ? t(
                    'puzzle.engine.review.bestWdl',
                    'Best {{wdl}}',
                    { wdl: wdlBestText },
                  )
                : null,
              depthText,
            ].filter(Boolean) as string[];
            const metaText = metaParts.length
              ? ` [${metaParts.join(' · ')}]`
              : '';
            const metaTitle = titleWdl(tok.meta?.wdlBest ?? null);
            const variationContent = (
              <>
                {tok.text}
                {metaText && (
                  <span
                    className="post-game-review__eval-meta"
                    data-testid={`post-game-review-variation-meta-${tok.halfIndex}`}
                    data-depth={tok.meta?.depth ?? ''}
                    data-wdl-best={
                      tok.meta?.wdlBest
                        ? `${tok.meta.wdlBest.w},${tok.meta.wdlBest.d},${tok.meta.wdlBest.l}`
                        : ''
                    }
                    title={metaTitle}
                  >
                    {metaText}
                  </span>
                )}{' '}
              </>
            );
            return cb ? (
              <button
                key={`var-${i}`}
                type="button"
                className="post-game-review__variation"
                data-testid={`post-game-review-variation-${tok.halfIndex}`}
                onClick={cb}
              >
                {variationContent}
              </button>
            ) : (
              <span
                key={`var-${i}`}
                className="post-game-review__variation"
                data-testid={`post-game-review-variation-${tok.halfIndex}`}
              >
                {variationContent}
              </span>
            );
          }
          // move token
          const cls = tok.cls ?? 'engine';
          const className = `post-game-review__move post-game-review__move--${cls}${tok.isUser ? ' post-game-review__move--user' : ''}`;
          const cb = onSelectMove
            ? () => handleSelect(tok.fenBefore)
            : undefined;
          // KS-2686: для user-хода с meta показываем WDL после
          // фактически сыгранного хода: «d3? [Played W/D/L%]».
          const wdlPlayedText = fmtWdl(tok.meta?.wdlPlayed ?? null);
          const playedMetaText = wdlPlayedText
            ? ` [${t(
                'puzzle.engine.review.playedWdl',
                'Played {{wdl}}',
                { wdl: wdlPlayedText },
              )}]`
            : '';
          const playedMetaTitle = titleWdl(tok.meta?.wdlPlayed ?? null);
          const content = (
            <>
              {tok.san}
              {tok.nag && (
                <span className="post-game-review__nag">{tok.nag}</span>
              )}
              {playedMetaText && (
                <span
                  className="post-game-review__eval-meta"
                  data-testid={`post-game-review-move-meta-${tok.halfIndex}`}
                  data-wdl-played={
                    tok.meta?.wdlPlayed
                      ? `${tok.meta.wdlPlayed.w},${tok.meta.wdlPlayed.d},${tok.meta.wdlPlayed.l}`
                      : ''
                  }
                  title={playedMetaTitle}
                >
                  {playedMetaText}
                </span>
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
