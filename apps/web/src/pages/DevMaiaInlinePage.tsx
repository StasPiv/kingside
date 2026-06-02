/**
 * KS-3589 dev-page: визуальная проверка нового inline-Maia UX (ADR-097).
 *
 * Имитирует engine-panel с MaiaEloSelect в шапке и
 * `<span class="stockfish-maia-prob">` внутри каждой .stockfish-line.
 * Без рантайма Stockfish/Maia — статические данные для скриншотов
 * layout-агента (urls: /dev/maia-inline).
 */
import '../styles/engine.css';
import '../styles/analysis.css';

interface Row {
  eval: string;
  prob: string;
  pv: string;
  best?: boolean;
}

const ROWS: Row[] = [
  { eval: '+0.32', prob: '47.1%', pv: '1. e4 e5 2. Nf3 Nc6 3. Bb5', best: true },
  { eval: '+0.18', prob: '23.4%', pv: '1. d4 d5 2. c4 e6 3. Nc3' },
  { eval: '+0.11', prob: '14.8%', pv: '1. Nf3 Nf6 2. g3 g6 3. Bg2' },
];

function Panel({
  label,
  staleProb = false,
  showWarning = false,
  emptyProb = false,
}: {
  label: string;
  staleProb?: boolean;
  showWarning?: boolean;
  emptyProb?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
      <div className="analysis-panel" style={{ width: 360 }}>
        <div className="analysis-panel-header">
          <div className="analysis-panel-header-left">
            <span className="analysis-panel-icon">⚙</span>
            <span className="analysis-panel-title">Stockfish 17 · d28</span>
          </div>
          <div className="analysis-panel-header-right">
            <div className="maia-elo-controls">
              <span className="maia-elo-controls__label">Maia</span>
              <select className="maia-elo-select" defaultValue="1500">
                <option value="1100">1100</option>
                <option value="1300">1300</option>
                <option value="1500">1500</option>
                <option value="1700">1700</option>
                <option value="1900">1900</option>
              </select>
              {showWarning && (
                <span
                  className="maia-elo-warning"
                  title="Не удалось получить ходы Maia"
                  aria-label="Maia error"
                >
                  ⚠
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="analysis-panel-body" style={{ maxHeight: 'none' }}>
          {/* KS-3594: заголовок-сортировка над .stockfish-lines. */}
          <div className="stockfish-lines-header">
            <button
              type="button"
              className="stockfish-lines-header__col stockfish-lines-header__col--eval stockfish-lines-header__col--active"
            >
              Eval <span className="stockfish-lines-header__arrow">↓</span>
            </button>
            <button
              type="button"
              className="stockfish-lines-header__col stockfish-lines-header__col--maia"
            >
              Maia%
            </button>
            <span className="stockfish-lines-header__col stockfish-lines-header__col--label">
              Line
            </span>
          </div>
          <div className="stockfish-lines">
            {ROWS.map((r, i) => (
              <div className="stockfish-line" key={i}>
                <span
                  className={`stockfish-eval${r.best ? ' best' : ''}`}
                >
                  {r.eval}
                </span>
                <span
                  className={`stockfish-maia-prob${staleProb ? ' stockfish-maia-prob--stale' : ''}`}
                >
                  {emptyProb ? '' : r.prob}
                </span>
                <span className="stockfish-pv">{r.pv}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DevMaiaInlinePage() {
  return (
    <div
      style={{
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        maxWidth: 720,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 16 }}>KS-3589 — Maia inline в Stockfish-линиях</h2>
      <Panel label="idle — данные есть" />
      <Panel label="stale — старые данные пока считается новая позиция" staleProb />
      <Panel label="empty — Maia ещё не считала / отключена" emptyProb />
      <Panel label="error — иконка ⚠ рядом с селектом" showWarning />
    </div>
  );
}
