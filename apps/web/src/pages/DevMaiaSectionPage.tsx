/**
 * KS-3585 dev-page: визуальная проверка .maia-section в обеих темах.
 *
 * Имитирует engine-panel (без рантайма Stockfish/Maia) — рендерит
 * .analysis-panel-body → .stockfish-lines → .maia-section с разными
 * состояниями: idle (с данными), stale, loading, error.
 * Используется только layout-агентом для скриншотов (urls: /dev/maia-section).
 */
import '../styles/engine.css';
import '../styles/analysis.css';

interface Line {
  prob: string;
  move: string;
}

const LINES: Line[] = [
  { prob: '47.1%', move: 'Nf3' },
  { prob: '23.4%', move: 'e4' },
  { prob: '14.8%', move: 'd4' },
  { prob: '8.2%', move: 'c4' },
  { prob: '3.7%', move: 'g3' },
];

function PanelShell({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
      <div
        className="analysis-panel-body"
        /* dev-only: убираем max-height: 132px у engine-panel-body, чтобы
           секция Maia была видна целиком на скриншоте — в реальной
           интеграции frontend применит --scroll-modifier (KS-3584). */
        style={{ width: 320, borderRadius: 6, padding: 10, maxHeight: 'none' }}
      >
        <div className="stockfish-lines">
          <div className="stockfish-line">
            <span className="stockfish-eval best">+0.32</span>
            <span className="stockfish-pv">1. e4 e5 2. Nf3 Nc6 3. Bb5</span>
          </div>
          <div className="stockfish-line">
            <span className="stockfish-eval">+0.18</span>
            <span className="stockfish-pv">1. d4 d5 2. c4 e6 3. Nc3</span>
          </div>
          <div className="stockfish-line">
            <span className="stockfish-eval">+0.11</span>
            <span className="stockfish-pv">1. Nf3 Nf6 2. g3 g6 3. Bg2</span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function MaiaSection({
  state,
}: {
  state: 'data' | 'stale' | 'loading' | 'error';
}) {
  const modifier =
    state === 'stale'
      ? ' maia-section--stale'
      : state === 'loading'
        ? ' maia-section--loading'
        : state === 'error'
          ? ' maia-section--error'
          : '';
  return (
    <div className={`maia-section${modifier}`}>
      <div className="maia-section-header">
        <span className="maia-section-title">Human moves (Maia)</span>
        <div className="maia-section-controls">
          <select className="maia-elo-select" defaultValue="1500">
            <option value="1100">Maia 1100</option>
            <option value="1300">Maia 1300</option>
            <option value="1500">Maia 1500</option>
            <option value="1700">Maia 1700</option>
            <option value="1900">Maia 1900</option>
          </select>
        </div>
      </div>

      {state === 'loading' && (
        <div className="maia-section__loading">Считаем…</div>
      )}

      {state === 'error' && (
        <div className="maia-section__error">
          <span>Не удалось получить ходы Maia</span>
          <button type="button" className="maia-error-retry">
            Повторить
          </button>
        </div>
      )}

      {(state === 'data' || state === 'stale') && (
        <div className="maia-lines">
          {LINES.map((l, i) => (
            <div
              key={l.move}
              className={`maia-line${i === 0 ? ' maia-line--top' : ''}`}
            >
              <span className="maia-prob">{l.prob}</span>
              <span className="maia-move">{l.move}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DevMaiaSectionPage() {
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
      <h2 style={{ margin: 0, fontSize: 16 }}>KS-3585 — .maia-section</h2>
      <PanelShell label="data (idle)">
        <MaiaSection state="data" />
      </PanelShell>
      <PanelShell label="stale (opacity 0.5)">
        <MaiaSection state="stale" />
      </PanelShell>
      <PanelShell label="loading">
        <MaiaSection state="loading" />
      </PanelShell>
      <PanelShell label="error">
        <MaiaSection state="error" />
      </PanelShell>
    </div>
  );
}
