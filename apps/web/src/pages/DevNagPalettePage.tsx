import { useEffect, useRef, useState } from 'react';

import { NagPalette } from '../review/components/NagPalette';
import { NagPaletteSheet } from '../review/components/NagPaletteSheet';
import { ReviewMoveList } from '../review/components/ReviewMoveList';
import type { ChessMove } from '../review/types';
import { useReviewState } from '../review/useReviewState';
import { parseAnnotatedPgn } from '../review/utils/PgnDeserializer';
import { serializeToAnnotatedPgn } from '../review/utils/PgnSerializer';
import { useAdHocAnalysisAutosave } from '../hooks/useAdHocAnalysisAutosave';

/**
 * KS-2269 — dev-демо для `NagPalette` / `NagPaletteSheet`. Доступно
 * локально через `/dev/nag-palette?dev_bypass=secret`.
 *
 * Назначение: layout-агенту (KS-2270) удобно снимать скриншоты
 * light/dark, desktop/mobile с разными комбинациями active-NAG'ов
 * без необходимости играть партию и открывать context-menu в
 * AnalysisPage.
 */

interface DemoState {
  label: string;
  initial: number[];
}

const DEMO_STATES: DemoState[] = [
  { label: 'empty (no NAG)', initial: [] },
  { label: 'quality only — `!`', initial: [1] },
  { label: 'quality only — `!!`', initial: [3] },
  { label: 'positionEval only — `⩲`', initial: [14] },
  { label: 'quality + positionEval — `!` + `⩲`', initial: [1, 14] },
  {
    label: 'all categories: `!!` + `±` + legacy `7 □`',
    initial: [3, 16, 7],
  },
];

export function DevNagPalettePage() {
  return (
    <div className="dev-nag-palette-page" style={{ padding: 16 }}>
      <h1>NagPalette / NagPaletteSheet — demo</h1>
      <p style={{ opacity: 0.7, maxWidth: 720 }}>
        KS-2269 (E2 component) + KS-2270 (CSS). Контракт DOM зафиксирован
        в JSDoc <code>NagPalette.tsx</code> / <code>NagPaletteSheet.tsx</code>.
      </p>

      <h2>Desktop popup (`NagPalette`)</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: 24,
          marginTop: 16,
        }}
      >
        {DEMO_STATES.map((demo, i) => (
          <DesktopDemo key={i} label={demo.label} initial={demo.initial} />
        ))}
      </div>

      <h2 style={{ marginTop: 32 }}>Mobile bottom-sheet (`NagPaletteSheet`)</h2>
      <SheetDemo />

      <h2 style={{ marginTop: 32 }}>ReviewMoveList integration (KS-2283 / e2e)</h2>
      <ReviewMoveListDemo />

      <h2 style={{ marginTop: 32 }}>
        Variation color demo (KS-2294 / VC E3 e2e)
      </h2>
      <VariationColorDemo />
    </div>
  );
}

function DesktopDemo({ label, initial }: { label: string; initial: number[] }) {
  const [nags, setNags] = useState<number[]>(initial);
  return (
    <div
      style={{
        border: '1px solid var(--c-border, #444)',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{label}</div>
      <NagPalette nags={nags} onChange={setNags} />
      <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 12 }}>
        nags = [{nags.join(', ')}]
      </div>
    </div>
  );
}

/**
 * KS-2272 (e2e) — фиктивный список ходов с готовыми `ChessMove`-объектами.
 * Используется в e2e для теста интеграции NagPalette в `ReviewMoveList`
 * (right-click / long-press / read-only) без необходимости играть партию
 * в `AnalysisPage`.
 */
function makeDemoMove(globalIndex: number, san: string): ChessMove {
  return {
    san,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    from: 'e2',
    to: 'e4',
    piece: 'p',
    flags: 'b',
    lan: 'e2e4',
    before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    after: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    globalIndex,
    ply: globalIndex,
  };
}

function ReviewMoveListDemo() {
  const [editableMoves, setEditableMoves] = useState<ChessMove[]>(() => [
    makeDemoMove(1, 'e4'),
    makeDemoMove(2, 'e5'),
    makeDemoMove(3, 'Nf3'),
  ]);

  const handleSetNag = (globalIndex: number, nags: number[]) => {
    setEditableMoves((prev) =>
      prev.map((m) => (m.globalIndex === globalIndex ? { ...m, nags } : m)),
    );
  };

  const readOnlyMoves: ChessMove[] = [
    { ...makeDemoMove(1, 'e4'), nags: [1] },
    { ...makeDemoMove(2, 'e5'), nags: [14] },
  ];

  // KS-2297 (regression-target): этот инстанс ИМЕЕТ редактирующие
  // колбэки (promote/delete/truncate) — `editable=true`, long-press
  // открывает context-menu, — но не имеет `onSetNag`. До фикса
  // KS-2297 sheet рендерился с NagPalette, клик по NAG молча
  // терялся. Теперь NagPaletteSheet НЕ рендерится без onSetNag,
  // вместо него появляется простой actions-popup.
  const noNagMoves: ChessMove[] = [
    makeDemoMove(1, 'e4'),
    makeDemoMove(2, 'e5'),
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: 24,
        marginTop: 16,
      }}
    >
      <div
        data-testid="review-move-list-demo-editable"
        style={{
          border: '1px solid var(--c-border, #444)',
          borderRadius: 8,
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          editable — right-click / long-press открывают палитру
        </div>
        <ReviewMoveList
          history={editableMoves}
          currentGlobalIndex={1}
          onMoveClick={() => {}}
          onSetNag={handleSetNag}
        />
      </div>
      <div
        data-testid="review-move-list-demo-no-nag"
        style={{
          border: '1px solid var(--c-border, #444)',
          borderRadius: 8,
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          KS-2297: editable БЕЗ onSetNag → sheet НЕ открывается, fallback на actions-popup
        </div>
        <ReviewMoveList
          history={noNagMoves}
          currentGlobalIndex={1}
          onMoveClick={() => {}}
          onPromoteVariation={() => {}}
          onDeleteVariation={() => {}}
          onTruncateRemaining={() => {}}
        />
      </div>
      <div
        data-testid="review-move-list-demo-readonly"
        style={{
          border: '1px solid var(--c-border, #444)',
          borderRadius: 8,
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          readOnly — палитра НЕ открывается (e2e read-only сценарий)
        </div>
        <ReviewMoveList
          history={readOnlyMoves}
          currentGlobalIndex={1}
          onMoveClick={() => {}}
          readOnly
        />
      </div>
    </div>
  );
}

function SheetDemo() {
  const [open, setOpen] = useState(false);
  const [nags, setNags] = useState<number[]>([1, 14]);
  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <span style={{ marginLeft: 12, fontFamily: 'monospace' }}>
        nags = [{nags.join(', ')}]
      </span>
      <NagPaletteSheet
        open={open}
        nags={nags}
        onChange={setNags}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

/**
 * KS-2294 (VC E3 e2e) — demo с реальной вариацией для проверки секции
 * «Variation color» в палитре.
 *
 * Использует `useReviewState` (а не локальный useState с фиктивными
 * `ChessMove`-объектами как в `ReviewMoveListDemo`) — чтобы:
 *   1. `setVariationColor` (KS-2287) реально работал и обновлял
 *      `move.variationColor` через reducer.
 *   2. `useAdHocAnalysisAutosave` (KS-2281) сохранял PGN в localStorage
 *      после throttle. e2e может через `page.evaluate(localStorage)`
 *      проверить, что в storage появился `[%cvc G]` после клика green.
 *
 * PGN: `1. e4 e5 (1... c5 2. Nf3) 2. Nf3` — стандартный пример с
 * одной вариацией. e5 — main, c5 — head вариации, Nf3 (вариант) —
 * не-head вариации.
 *
 * Без `onRestore` autosave — иначе при reload restore затрёт initial
 * loadFromPgn непредсказуемо. e2e проверяет storage напрямую через
 * page.evaluate.
 */
const VARIATION_DEMO_PGN = '1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *';

function VariationColorDemo() {
  const review = useReviewState();
  const loadedRef = useRef(false);

  // Один раз грузим initial PGN. После клика variation-color reducer
  // мутирует state, autosave throttle пишет в localStorage.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    review.loadFromPgn(parseAnnotatedPgn(VARIATION_DEMO_PGN));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave (KS-2281) — для e2e-проверки `[%cvc G]` в localStorage.
  useAdHocAnalysisAutosave({
    enabled: true,
    initialFen: review.initialFen,
    history: review.history,
    initialAnnotations: review.initialAnnotations,
    annotationsByIndex: review.annotationsByIndex,
  });

  // Текущий PGN — для удобной визуальной проверки в demo-странице.
  const currentPgn = serializeToAnnotatedPgn(
    review.history,
    review.initialAnnotations,
    review.annotationsByIndex,
  );

  return (
    <div
      data-testid="variation-color-demo"
      style={{
        border: '1px solid var(--c-border, #444)',
        borderRadius: 8,
        padding: 12,
        marginTop: 16,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        e4 — main, e5 — main (имеет вариацию), c5 — head вариации, Nf3 — её 2-й ход.
        Right-click на главных ходах → секция Variation color скрыта; на ходах
        вариации → видна (4 swatch + Clear). Изменения автосохраняются в
        localStorage (KS-2281), e2e проверяет PGN на наличие [%cvc].
      </div>
      <ReviewMoveList
        history={review.history}
        currentGlobalIndex={review.currentGlobalIndex}
        onMoveClick={review.gotoMove}
        onSetNag={review.setNag}
        onSetComment={review.setComment}
        onPromoteVariation={review.promoteVariation}
        onDeleteVariation={review.removeVariation}
        onTruncateRemaining={review.truncateRemaining}
        onSetVariationColor={review.setVariationColor}
      />
      <pre
        data-testid="variation-color-demo-pgn"
        style={{
          marginTop: 12,
          padding: 8,
          background: 'rgba(0,0,0,0.05)',
          borderRadius: 4,
          fontSize: 11,
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {currentPgn}
      </pre>
    </div>
  );
}
