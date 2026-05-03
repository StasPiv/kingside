import { useState } from 'react';

import { NagPalette } from '../review/components/NagPalette';
import { NagPaletteSheet } from '../review/components/NagPaletteSheet';

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
