interface WinDrawLossBarProps {
  whitePct: number;
  drawPct: number;
  blackPct: number;
}

/**
 * Horizontal 100% bar showing white win / draw / black win percentages.
 * Colors (white/gray/black) are applied via CSS classes — styling belongs to KS-1583.
 */
export function WinDrawLossBar({ whitePct, drawPct, blackPct }: WinDrawLossBarProps) {
  const w = Math.max(0, Math.min(100, whitePct));
  const d = Math.max(0, Math.min(100, drawPct));
  const b = Math.max(0, Math.min(100, blackPct));

  const title = `W ${Math.round(w)}% · D ${Math.round(d)}% · B ${Math.round(b)}%`;

  return (
    <div className="wdl-bar" title={title} role="img" aria-label={title}>
      <div className="wdl-bar__segment wdl-bar__segment--white" style={{ width: `${w}%` }}>
        <span className="wdl-bar__label">{w >= 10 ? `${Math.round(w)}%` : ''}</span>
      </div>
      <div className="wdl-bar__segment wdl-bar__segment--draw" style={{ width: `${d}%` }}>
        <span className="wdl-bar__label">{d >= 10 ? `${Math.round(d)}%` : ''}</span>
      </div>
      <div className="wdl-bar__segment wdl-bar__segment--black" style={{ width: `${b}%` }}>
        <span className="wdl-bar__label">{b >= 10 ? `${Math.round(b)}%` : ''}</span>
      </div>
    </div>
  );
}
