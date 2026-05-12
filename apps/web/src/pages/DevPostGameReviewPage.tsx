import { useTranslation } from 'react-i18next';
import { PostGameReview } from '../components/puzzle/PostGameReview';
import type { UserBestSnapshot } from '../components/puzzle/PlayVsEngineRunner';
import { permilleToPercent } from '../utils/chessFormat';

/**
 * KS-2686 — dev-демо итогового экрана режима «Тренировка точности».
 * Доступно локально через `/dev/post-game-review?dev_bypass=secret`.
 *
 * Назначение: снять скриншоты до/после правок KS-2686 без полного
 * прохождения партии (требует WASM Stockfish, drag-and-drop через
 * Playwright и нескольких секунд ожидания на каждый ход). Моки —
 * реалистичные данные WDL/cp в формате Stockfish.
 *
 * Покрывает три сценария задачи:
 *  1. WDL в трёх строках Win/Draw/Loss с дельтами (вместо одной цифры).
 *  2. PostGameReview с meta «played W/D/L%» рядом с ходом и
 *     «best W/D/L% · d=N» рядом с вариантом.
 *  3. Заголовок «Преимущество потеряно/удержано» — ровно один раз
 *     (внешний reasonLabel; внутренний lostHeader/preservedHeader удалён).
 */

const STARTING_FEN_W =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FEN_AFTER_E4_E5 =
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

const FEN_AFTER_NF3_NC6 =
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';

const SAMPLE_USER_BEST_LOG: UserBestSnapshot[] = [
  // halfMove=1 — белые играют 1.e4 (best).
  {
    halfMove: 1,
    fenBefore: STARTING_FEN_W,
    playedUci: 'e2e4',
    bestUci: 'e2e4',
    cpBefore: 30,
    cpAfter: 30,
    wdlBefore: { w: 480, d: 460, l: 60 },
    wdlAfter: { w: 480, d: 460, l: 60 },
    depth: 14,
  },
  // halfMove=3 — белые играют 2.Nf3 (best).
  {
    halfMove: 3,
    fenBefore: FEN_AFTER_E4_E5,
    playedUci: 'g1f3',
    bestUci: 'g1f3',
    cpBefore: 35,
    cpAfter: 30,
    wdlBefore: { w: 490, d: 450, l: 60 },
    wdlAfter: { w: 480, d: 460, l: 60 },
    depth: 14,
  },
  // halfMove=5 — белые играют 3.Nh4? (blunder, best — 3.Bb5).
  {
    halfMove: 5,
    fenBefore: FEN_AFTER_NF3_NC6,
    playedUci: 'f3h4',
    bestUci: 'f1b5',
    cpBefore: 30,
    cpAfter: -340,
    wdlBefore: { w: 480, d: 460, l: 60 },
    wdlAfter: { w: 30, d: 320, l: 650 },
    depth: 14,
  },
];

const SAMPLE_PLAYED_SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Nh4', 'd6'];

interface DemoCardProps {
  title: string;
  reasonLabel: string;
  state: 'win' | 'lose';
  startWdl: { w: number; d: number; l: number };
  finalWdl: { w: number; d: number; l: number };
}

function signedFmt(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
}

function DemoSummaryCard({
  title,
  reasonLabel,
  state,
  startWdl,
  finalWdl,
}: DemoCardProps) {
  const { t } = useTranslation();
  const start = {
    w: permilleToPercent(startWdl.w),
    d: permilleToPercent(startWdl.d),
    l: permilleToPercent(startWdl.l),
  };
  const final = {
    w: permilleToPercent(finalWdl.w),
    d: permilleToPercent(finalWdl.d),
    l: permilleToPercent(finalWdl.l),
  };
  const dW = final.w - start.w;
  const dD = final.d - start.d;
  const dL = final.l - start.l;
  const preserved = state === 'win';
  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ marginBottom: 12 }}>{title}</h2>
      <div className="puzzle-engine-runner__result">
        <div
          className={`puzzle-engine-runner__result-label puzzle-engine-runner__result-label--${state}`}
        >
          {reasonLabel}
        </div>
        <div
          className={`puzzle-engine-runner__wdl-summary puzzle-engine-runner__wdl-summary--${preserved ? 'preserved' : 'lost'}`}
          data-mode="permille"
        >
          <div className="puzzle-engine-runner__wdl-summary-line">
            <div
              data-testid="puzzle-engine-wdl-row-win"
              className="puzzle-engine-runner__wdl-row--win"
            >
              {t('puzzle.engine.summary.win', 'Win')}: {start.w}% → {final.w}% (
              {signedFmt(dW)}%)
            </div>
            <div
              data-testid="puzzle-engine-wdl-row-draw"
              className="puzzle-engine-runner__wdl-row--draw"
            >
              {t('puzzle.engine.summary.draw', 'Draw')}: {start.d}% → {final.d}%
              ({signedFmt(dD)}%)
            </div>
            <div
              data-testid="puzzle-engine-wdl-row-loss"
              className="puzzle-engine-runner__wdl-row--loss"
            >
              {t('puzzle.engine.summary.loss', 'Loss')}: {start.l}% → {final.l}%
              ({signedFmt(dL)}%)
            </div>
          </div>
        </div>
        <PostGameReview
          initialFen={STARTING_FEN_W}
          playedSans={SAMPLE_PLAYED_SANS}
          userBestLog={SAMPLE_USER_BEST_LOG}
          userSide="w"
        />
      </div>
    </div>
  );
}

export function DevPostGameReviewPage() {
  const { t } = useTranslation();

  return (
    <div style={{ maxWidth: 720, margin: '24px auto', padding: 16 }}>
      <h1>KS-2686 — Post-game review demo</h1>
      <p style={{ color: '#666', marginBottom: 24 }}>
        Замоканные данные итогового экрана «Тренировка точности».
        Реалистичные WDL/cp в формате Stockfish (UCI_ShowWDL=true).
      </p>

      {/* KS-2922: визуальная sanity-проверка прогресс-бара и кнопки
          «Открыть в мастерской». Логика не запускается — только разметка
          с классами/data-* нужными для CSS. */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ marginBottom: 12 }}>Сценарий: прогресс и действие</h2>
        <div className="puzzle-engine-runner" data-testid="puzzle-engine-runner">
          <div className="puzzle-engine-runner__board-col">
            <div className="puzzle-engine-runner__progress">
              <div className="puzzle-engine-runner__progress-bar">
                <div
                  className="puzzle-engine-runner__progress-fill"
                  style={{ width: '50%' }}
                />
              </div>
              <div className="puzzle-engine-runner__progress-label">
                {t('puzzle.engine.halfMovesLeft', '{{count}} half-moves left', {
                  count: 3,
                })}
              </div>
            </div>
            <div
              className="puzzle-engine-runner__actions"
              data-testid="puzzle-engine-actions"
            >
              <a
                className="puzzle-engine-runner__workshop-link"
                href="#"
                onClick={(e) => e.preventDefault()}
              >
                {t('puzzle.engine.openInWorkshop', 'Open in Workshop')}
              </a>
            </div>
          </div>
        </div>
      </div>

      <DemoSummaryCard
        title="Сценарий: преимущество потеряно"
        reasonLabel={t('puzzle.engine.loseWdl', 'You lost the advantage')}
        state="lose"
        startWdl={{ w: 850, d: 130, l: 20 }}
        finalWdl={{ w: 20, d: 200, l: 780 }}
      />
      <DemoSummaryCard
        title="Сценарий: преимущество удержано"
        reasonLabel={t('puzzle.engine.win', 'You held the advantage')}
        state="win"
        startWdl={{ w: 850, d: 130, l: 20 }}
        finalWdl={{ w: 900, d: 80, l: 20 }}
      />
    </div>
  );
}
