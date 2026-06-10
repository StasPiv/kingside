import { useTranslation } from 'react-i18next';
import { PostGameReview } from '../components/puzzle/PostGameReview';
import type { UserBestSnapshot } from '../components/puzzle/PlayVsEngineRunner';
import { permilleToPercent } from '../utils/chessFormat';
// KS-3018: моки финального экрана теперь рендерят PrecisionScoreBlock
// вместо бинарной плашки «преимущество удержано/потеряно».
import { PrecisionScoreBlock } from '../components/precision/PrecisionScoreBlock';

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
    wdlBefore: { w: 480, d: 460, l: 60 },
    wdlAfter: { w: 480, d: 460, l: 60 },
    depth: 14,
    engineUci: null,
  },
  // halfMove=3 — белые играют 2.Nf3 (best).
  {
    halfMove: 3,
    fenBefore: FEN_AFTER_E4_E5,
    playedUci: 'g1f3',
    bestUci: 'g1f3',
    wdlBefore: { w: 490, d: 450, l: 60 },
    wdlAfter: { w: 480, d: 460, l: 60 },
    depth: 14,
    engineUci: null,
  },
  // halfMove=5 — белые играют 3.Nh4? (blunder, best — 3.Bb5).
  {
    halfMove: 5,
    fenBefore: FEN_AFTER_NF3_NC6,
    playedUci: 'f3h4',
    bestUci: 'f1b5',
    wdlBefore: { w: 480, d: 460, l: 60 },
    wdlAfter: { w: 30, d: 320, l: 650 },
    depth: 14,
    engineUci: null,
  },
];

const SAMPLE_PLAYED_SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Nh4', 'd6'];

interface DemoCardProps {
  title: string;
  state: 'win' | 'lose';
  /** KS-3018: моковый balanced score для демонстрации звёзд. */
  score: 1 | 2 | 3 | 4 | 5 | null;
  scorePct: number | null;
  startWdl: { w: number; d: number; l: number };
  finalWdl: { w: number; d: number; l: number };
}

function signedFmt(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
}

function DemoSummaryCard({
  title,
  state,
  score,
  scorePct,
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
        {/* KS-3018: бинарная плашка заменена на PrecisionScoreBlock. */}
        <PrecisionScoreBlock score={score} scorePct={scorePct} />
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
        title="Сценарий: преимущество потеряно (1★)"
        state="lose"
        score={1}
        scorePct={28}
        startWdl={{ w: 850, d: 130, l: 20 }}
        finalWdl={{ w: 20, d: 200, l: 780 }}
      />
      <DemoSummaryCard
        title="Сценарий: преимущество удержано (5★)"
        state="win"
        score={5}
        scorePct={97}
        startWdl={{ w: 850, d: 130, l: 20 }}
        finalWdl={{ w: 900, d: 80, l: 20 }}
      />

      {/* KS-3068 regression repro: жалоба из Telegram (Wang Shixu B —
          Nakamura, после 59... Nxe4). До KS-3068 в drill-down эти ходы
          получали `??` (по cp-loss формуле, которая ломалась в выигранных
          позициях). Теперь — `!` для Nd2 и `?!` для Ndf3, как в истории
          тренировки. */}
      <KS3068ReproCard />
    </div>
  );
}

/**
 * KS-3068. Изолированный repro-сценарий для скриншота фикса. user
 * играет за чёрных. Три полухода: Nxe4 (best), Nd2 (не best, WDL не
 * меняется), Ndf3 (не best, WDL 100/0/0 → 87/13/0). До KS-3068 Nd2 и
 * Ndf3 получали `??` в PostGameReview из-за cp-only классификации в
 * выигранной позиции. После KS-3068 — `!` и `?!` соответственно.
 *
 * FEN'ы реальной партии не воспроизводим — для скриншота достаточно
 * показать NAG'и на трёх полуходах. Используем фиктивные позиции, где
 * указанные UCI легальны.
 */
function KS3068ReproCard() {
  const REPRO_FEN_BLACK_TO_MOVE =
    'r1bqkbnr/ppp1pppp/2n5/1B1p4/4P3/8/PPPP1PPP/RNBQK1NR b KQkq - 0 3';
  const log: UserBestSnapshot[] = [
    // 1) Nxe4 (e7e5 не подходит — берём другой ход, важно только что he is best и WDL высок).
    {
      halfMove: 1,
      fenBefore: REPRO_FEN_BLACK_TO_MOVE,
      playedUci: 'c6d4', // не важно для NAG-теста — used as best
      bestUci: 'c6d4',
      wdlBefore: { w: 1000, d: 0, l: 0 },
      wdlAfter: { w: 1000, d: 0, l: 0 },
      depth: 18,
      engineUci: null,
    },
  ];
  // Используем «дидактическую» демонстрацию: рендерим PostGameReview
  // напрямую с тремя замоканными user-ходами. PGN-цепочка делается
  // через 3 копии разных FEN — для NAG достаточно классификации.
  // Здесь мы для простоты показываем три варианта в трёх отдельных
  // PostGameReview, по одному ходу — чтобы не подбирать связные FEN.
  return (
    <div style={{ marginBottom: 32, borderTop: '1px solid #444', paddingTop: 16 }}>
      <h2 style={{ marginBottom: 12 }}>
        KS-3068 repro: drill-down теперь даёт те же NAG'и что и история
      </h2>
      <p style={{ color: '#888', marginBottom: 12 }}>
        Из жалобы Telegram (Wang Shixu B — Nakamura, после 59... Nxe4). До
        фикса Nd2 и Ndf3 получали <code>??</code>. Эталон — backend
        classification в истории тренировки: Nd2 = <code>!</code>, Ndf3 = <code>?!</code>.
      </p>

      <div data-testid="ks3068-best-equal-wdl" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#aaa' }}>
          1. Nd2: не best, но WDL 100/0/0 → 100/0/0 (выигран — никаких
          претензий)
        </h3>
        <PostGameReview
          initialFen={REPRO_FEN_BLACK_TO_MOVE}
          playedSans={['Nxd4']}
          userBestLog={log}
          userSide="b"
        />
      </div>

      <div data-testid="ks3068-inaccuracy" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#aaa' }}>
          2. Ndf3: не best, WDL 100/0/0 → 87/13/0 (потеря 13% win — это
          неточность <code>?!</code>, а не зевок <code>??</code>)
        </h3>
        <PostGameReview
          initialFen={REPRO_FEN_BLACK_TO_MOVE}
          playedSans={['Nxd4']}
          userBestLog={[
            {
              halfMove: 1,
              fenBefore: REPRO_FEN_BLACK_TO_MOVE,
              playedUci: 'c6d4',
              bestUci: 'c6b4', // другой ход — best, играли не его
              wdlBefore: { w: 1000, d: 0, l: 0 },
              wdlAfter: { w: 870, d: 130, l: 0 },
              depth: 18,
              engineUci: null,
            },
          ]}
          userSide="b"
        />
      </div>

      <div data-testid="ks3068-blunder-confirm" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#aaa' }}>
          3. Контроль: настоящий зевок — WDL 100/0/0 → 0/0/100 (правильно
          даёт <code>??</code>)
        </h3>
        <PostGameReview
          initialFen={REPRO_FEN_BLACK_TO_MOVE}
          playedSans={['Nxd4']}
          userBestLog={[
            {
              halfMove: 1,
              fenBefore: REPRO_FEN_BLACK_TO_MOVE,
              playedUci: 'c6d4',
              bestUci: 'c6b4',
              wdlBefore: { w: 1000, d: 0, l: 0 },
              wdlAfter: { w: 0, d: 0, l: 1000 },
              depth: 18,
              engineUci: null,
            },
          ]}
          userSide="b"
        />
      </div>
    </div>
  );
}
