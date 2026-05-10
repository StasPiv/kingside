import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  PrecisionAttemptDetail,
  PrecisionMoveDto,
  PuzzleDto,
} from '@kingside/shared';
import { api } from '../api';
import { puzzleApi } from '../api-puzzle';
import { PuzzleBoard } from '../components/PuzzleBoard';
import {
  PostGameReview,
  type PostGameReviewProps,
} from '../components/puzzle/PostGameReview';
import type { UserBestSnapshot } from '../components/puzzle/PlayVsEngineRunner';
import type { MoveClass } from '../utils/moveClassification';

/**
 * KS-2719 F4 / KS-2741 / ADR-056 §3.4 + §5. Detail-страница одной
 * precision-попытки.
 *
 * Источник:
 *  - `GET /precision/attempts/:attemptId` — основной snapshot
 *    (KS-2718, контракт `PrecisionAttemptDetail` из @kingside/shared).
 *  - `GET /puzzles/:id` — дополнительно тянем стартовый `fen` пазла:
 *    backend KS-2718 НЕ возвращает `initialFen` в детали попытки, а
 *    `PostGameReview` от него зависит. KS-2741: до фикса фронт ожидал
 *    `data.initialFen/playedSans/userSide` и падал на `data.playedSans
 *    is undefined` в `useMemo finalFen` после `setData(res)`.
 *
 * # Реконструкция playedSans / userSide
 *  - `userSide` — берём из FEN'а пазла (side-to-move на старте после
 *    blunder'а соперника = решатель).
 *  - `playedSans` — реконструируем из `moves[].playedUci` (только
 *    user-ходы; engine-ходы не приходят, поэтому SAN-нотация показывает
 *    только полуходы решающего, без ответных). Это ОК для PostGameReview
 *    в режиме detail-страницы — основная цель видеть свои ходы и их
 *    оценки. Лучше иметь частичный список, чем краш.
 *
 * # Состояния
 *  - loading: skeleton (спиннер).
 *  - error: 404/401/5xx → блок «попытка не найдена».
 *  - ready: summary + sparkline + bar-chart classifications + PostGameReview.
 */

type PageState = 'loading' | 'ready' | 'error';

const CLASS_COLORS: Record<MoveClass, string> = {
  best: '#27ae60',
  good: '#7fbf7f',
  inaccuracy: '#f1c40f',
  mistake: '#e67e22',
  blunder: '#c0392b',
};

const CLASS_ORDER: MoveClass[] = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
];

/**
 * KS-2741. Реконструкция SAN-последовательности из user-only `moves[]`.
 * Backend в `PrecisionAttemptDetail` НЕ присылает движковые ответы, но
 * каждый user-ход содержит `fenBefore` и `playedUci`. Применяем UCI к
 * `fenBefore` через chess.js — получаем SAN. Engine-полуходы между
 * user-ходами реконструировать без бэка нельзя (`fenBefore` следующего
 * user-хода уже после ответа движка), поэтому пропускаем.
 *
 * Возвращает только user-SAN'ы — этого достаточно для PostGameReview,
 * который работает по индексам user-ходов.
 */
function reconstructUserSans(moves: PrecisionMoveDto[]): string[] {
  const sans: string[] = [];
  for (const m of moves) {
    try {
      const c = new Chess(m.fenBefore);
      const move = c.move({
        from: m.playedUci.slice(0, 2),
        to: m.playedUci.slice(2, 4),
        promotion: m.playedUci.length > 4 ? m.playedUci[4] : undefined,
      });
      sans.push(move?.san ?? m.playedUci);
    } catch {
      sans.push(m.playedUci);
    }
  }
  return sans;
}

function sideFromFen(fen: string): 'w' | 'b' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'b' : 'w';
}

export function PrecisionAttemptPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();

  const [state, setState] = useState<PageState>('loading');
  const [data, setData] = useState<PrecisionAttemptDetail | null>(null);
  const [puzzle, setPuzzle] = useState<PuzzleDto | null>(null);
  const [reviewFen, setReviewFen] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!id) {
      setState('error');
      return;
    }
    setState('loading');
    try {
      const detail = await api.get<PrecisionAttemptDetail>(
        `/precision/attempts/${encodeURIComponent(id)}`,
      );
      // Дальше тянем puzzle для FEN/userSide. Если 404/5xx — деградируем
      // до error-state. Запрос отдельный, ошибка не должна валить весь
      // экран если detail успел.
      const pz = await puzzleApi
        .getById(detail.puzzleId)
        .catch(() => null as PuzzleDto | null);
      setData(detail);
      setPuzzle(pz);
      setState('ready');
    } catch {
      setData(null);
      setPuzzle(null);
      setState('error');
    }
  }, [id]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  /** Маппинг `moves[]` → `UserBestSnapshot[]` для PostGameReview. */
  const userBestLog = useMemo<UserBestSnapshot[]>(() => {
    if (!data) return [];
    return data.moves.map((m) => ({
      halfMove: m.ply,
      fenBefore: m.fenBefore,
      playedUci: m.playedUci,
      bestUci: m.bestUci,
      cpBefore: m.cpBefore ?? null,
      cpAfter: m.cpAfter ?? null,
      // KS-2741: backend хранит wdl как signed scalar (−1..+1), а
      // PostGameReview ожидает `WdlDistribution {w,d,l}` per-mille.
      // Без распределения `w/d/l` индивидуально его не воссоздать
      // (потерянная информация в server-trust пересчёте). Передаём null
      // — PostGameReview грейсфолит и не показывает W/D/L строки, но
      // SAN/cp-классификацию рисует нормально.
      wdlBefore: null,
      wdlAfter: null,
      depth: m.depth ?? null,
    }));
  }, [data]);

  // playedSans (только user) реконструируем из UCI'шек.
  const playedSans = useMemo<string[]>(() => {
    if (!data) return [];
    return reconstructUserSans(data.moves);
  }, [data]);

  const initialFen = puzzle?.fen ?? '';
  const userSide: 'w' | 'b' = puzzle ? sideFromFen(puzzle.fen) : 'w';

  // Доска: при выбранном reviewFen — он, иначе финальная позиция
  // (играем user-SAN'ы от стартовой позиции; промежуточные ходы движка
  // в snapshot'е лежат в `fenBefore` следующего user-хода — мы их не
  // воспроизводим, но финальная позиция = последний `fenBefore + last
  // user move`).
  const finalFen = useMemo<string>(() => {
    if (!data || data.moves.length === 0) return initialFen;
    const last = data.moves[data.moves.length - 1];
    try {
      const c = new Chess(last.fenBefore);
      c.move({
        from: last.playedUci.slice(0, 2),
        to: last.playedUci.slice(2, 4),
        promotion:
          last.playedUci.length > 4 ? last.playedUci[4] : undefined,
      });
      return c.fen();
    } catch {
      return last.fenBefore;
    }
  }, [data, initialFen]);

  if (state === 'loading') {
    return (
      <div
        className="precision-attempt-page"
        data-testid="precision-attempt-page"
        data-state="loading"
      >
        <p>{t('common.loading', 'Loading…')}</p>
      </div>
    );
  }

  if (state === 'error' || !data) {
    return (
      <div
        className="precision-attempt-page"
        data-testid="precision-attempt-page"
        data-state="error"
      >
        <p>
          {t(
            'precisionAttempt.notFound',
            'Attempt not found or no longer available.',
          )}
        </p>
        <Link to="/precision" data-testid="precision-attempt-back">
          ← {t('precision.backToAll', 'All puzzles')}
        </Link>
      </div>
    );
  }

  const orientation: 'white' | 'black' = userSide === 'w' ? 'white' : 'black';
  const accuracyText = `${Math.round(data.accuracyPercent)}%`;
  const wdlLeakText = data.wdlLeakSum.toFixed(2);

  // KS-2741: верстаем result-чип из shared-контракта `solved + endReason`.
  // Старый код использовал собственный `result: 'preserved'|'lost'|'aborted'`
  // — этого поля backend не присылает. Маппим:
  //   solved=true            → preserved
  //   solved=false           → lost
  //   endReason='aborted'    → aborted (даже если solved=false)
  const resultKey: 'preserved' | 'lost' | 'aborted' =
    data.endReason === 'aborted'
      ? 'aborted'
      : data.solved
        ? 'preserved'
        : 'lost';

  // Sparkline точек: wdl_user после каждого user-хода.
  // Backend хранит signed −1..+1; нормируем в [0..1] для отображения
  // «сверху=победа, снизу=поражение».
  const sparkPoints = data.moves.map((m, idx) => ({
    x: idx + 1,
    y:
      typeof m.wdlAfter === 'number'
        ? Math.max(0, Math.min(1, (m.wdlAfter + 1) / 2))
        : null,
  }));

  // Bar-chart distribution: shared-контракт = `classCounts`.
  const totalClassified = CLASS_ORDER.reduce(
    (sum, c) => sum + (data.classCounts[c] ?? 0),
    0,
  );

  const handleSelect: PostGameReviewProps['onSelectMove'] = ({ fenBefore }) =>
    setReviewFen(fenBefore);

  return (
    <div
      className="precision-attempt-page"
      data-testid="precision-attempt-page"
      data-state="ready"
      data-result={resultKey}
      data-half-moves={String(data.halfMovesPlayed)}
    >
      <header className="precision-attempt-page__header">
        <Link
          to="/precision"
          className="precision-attempt-page__back"
          data-testid="precision-attempt-back"
        >
          ← {t('precision.backToAll', 'All puzzles')}
        </Link>
        <h1>
          {t('precisionAttempt.title', 'Attempt #{{id}}', {
            id: data.attemptId.slice(0, 8),
          })}
        </h1>
      </header>

      <section
        className="precision-attempt-page__summary"
        data-testid="precision-attempt-summary"
      >
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.result', 'Result')}
          </div>
          <div
            className={`precision-attempt-page__summary-value precision-attempt-page__summary-value--${resultKey}`}
          >
            {resultKey === 'preserved'
              ? t('precisionAttempt.result.preserved', 'Preserved')
              : resultKey === 'lost'
                ? t('precisionAttempt.result.lost', 'Lost')
                : t('precisionAttempt.result.aborted', 'Aborted')}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.halfMoves', 'Half-moves')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {data.halfMovesPlayed}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.accuracy', 'Accuracy')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {accuracyText}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.wdlLeakSum', 'WDL leak total')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {wdlLeakText}
          </div>
        </div>
      </section>

      {sparkPoints.length > 0 && (
        <section
          className="precision-attempt-page__chart"
          data-testid="precision-attempt-sparkline"
        >
          <h2 className="precision-attempt-page__chart-title">
            {t('precisionAttempt.sparkline.title', 'WDL trajectory')}
          </h2>
          <svg
            className="precision-attempt-page__sparkline"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            role="img"
            aria-label={t(
              'precisionAttempt.sparkline.aria',
              'WDL trajectory across half-moves',
            )}
          >
            <line
              x1="0"
              y1="20"
              x2="100"
              y2="20"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="0.5"
            />
            {(() => {
              const segs: string[] = [];
              let path = '';
              const n = Math.max(1, sparkPoints.length);
              sparkPoints.forEach((p, i) => {
                if (p.y == null) {
                  if (path) segs.push(path);
                  path = '';
                  return;
                }
                const x = (i / (n - 1 || 1)) * 100;
                const y = 40 - p.y * 40;
                path += path
                  ? ` L ${x.toFixed(2)} ${y.toFixed(2)}`
                  : `M ${x.toFixed(2)} ${y.toFixed(2)}`;
              });
              if (path) segs.push(path);
              return segs.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke="#4ea1f7"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              ));
            })()}
          </svg>
        </section>
      )}

      {totalClassified > 0 && (
        <section
          className="precision-attempt-page__chart"
          data-testid="precision-attempt-bars"
        >
          <h2 className="precision-attempt-page__chart-title">
            {t(
              'precisionAttempt.classifications.title',
              'Move classifications',
            )}
          </h2>
          <ul className="precision-attempt-page__bars">
            {CLASS_ORDER.map((cls) => {
              const count = data.classCounts[cls] ?? 0;
              const pct = (count / totalClassified) * 100;
              return (
                <li
                  key={cls}
                  className="precision-attempt-page__bars-row"
                  data-testid={`precision-attempt-bar-${cls}`}
                  data-count={String(count)}
                >
                  <span className="precision-attempt-page__bars-label">
                    {t(
                      `precisionAttempt.classifications.${cls}`,
                      cls.charAt(0).toUpperCase() + cls.slice(1),
                    )}
                  </span>
                  <span className="precision-attempt-page__bars-track">
                    <span
                      className="precision-attempt-page__bars-fill"
                      style={{
                        width: `${pct.toFixed(1)}%`,
                        background: CLASS_COLORS[cls],
                      }}
                    />
                  </span>
                  <span className="precision-attempt-page__bars-count">
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="precision-attempt-page__review">
        <PuzzleBoard
          game={new Chess(reviewFen ?? finalFen ?? initialFen)}
          boardOrientation={orientation}
          enabled={false}
          onPieceDrop={() => false}
          lastMoveUci={null}
          status={resultKey === 'preserved' ? 'correct' : 'incorrect'}
        />
        {/* PostGameReview работает только когда есть initialFen
            (получили из puzzleApi.getById). Без него скрываем — не
            падаем. */}
        {initialFen && playedSans.length > 0 && (
          <PostGameReview
            initialFen={initialFen}
            playedSans={playedSans}
            userBestLog={userBestLog}
            userSide={userSide}
            onSelectMove={handleSelect}
          />
        )}
      </section>
    </div>
  );
}
