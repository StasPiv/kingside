import { useState } from 'react';

import { NagPalette } from '../review/components/NagPalette';
import { NagPaletteSheet } from '../review/components/NagPaletteSheet';
import { ReviewMoveList } from '../review/components/ReviewMoveList';
import type { ChessMove } from '../review/types';

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
