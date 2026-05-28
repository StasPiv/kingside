import { useEffect, useState } from 'react';
import { WdlChancesBar } from '../components/WdlChancesBar';
import type { WdlDistribution } from '../utils/engineAdapter';

/**
 * KS-3391: симуляция «живого» уточнения оценки по мере роста глубины
 * Stockfish (как реальный analyzeLive поток). Каждый шаг — следующая
 * глубина; полоса плавно перетекает (CSS transition). Зациклено — для
 * записи GIF-демо. В проде те же setLatestWdl вызывает onUpdate из
 * `analyzeLive`, пока игрок думает над ходом.
 */
const LIVE_SIM_STEPS: Array<{ depth: number; wdl: WdlDistribution }> = [
  { depth: 1, wdl: { w: 410, d: 470, l: 120 } },
  { depth: 4, wdl: { w: 480, d: 420, l: 100 } },
  { depth: 8, wdl: { w: 545, d: 365, l: 90 } },
  { depth: 12, wdl: { w: 610, d: 315, l: 75 } },
  { depth: 16, wdl: { w: 668, d: 270, l: 62 } },
  { depth: 20, wdl: { w: 712, d: 235, l: 53 } },
  { depth: 24, wdl: { w: 740, d: 212, l: 48 } },
  { depth: 28, wdl: { w: 758, d: 198, l: 44 } },
];

function LiveSimDemo() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => {
      setIdx((i) => (i + 1) % (LIVE_SIM_STEPS.length + 2));
    }, 550);
    return () => window.clearInterval(t);
  }, []);
  // Последние 2 «такта» цикла держим финальную глубину (пауза перед
  // рестартом), чтобы в GIF было видно устоявшееся значение.
  const step = LIVE_SIM_STEPS[Math.min(idx, LIVE_SIM_STEPS.length - 1)];
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>
        Живое уточнение по мере роста глубины SF — depth {step.depth} (W{' '}
        {Math.round(step.wdl.w / 10)} / D {Math.round(step.wdl.d / 10)} / L{' '}
        {Math.round(step.wdl.l / 10)})
      </div>
      <div style={{ maxWidth: 560 }}>
        <WdlChancesBar wdl={step.wdl} testId="dev-wdl-live-sim" />
      </div>
    </div>
  );
}

/**
 * KS-3391 — dev-демо трёхцветной полосы шансов W/D/L (PlayVsEngineRunner).
 * Доступно локально через `/dev/wdl-chances?dev_bypass=secret`.
 *
 * Назначение: снять скриншоты полосы без полного прохождения пазла
 * (требует WASM Stockfish + drag&drop + секунды на анализ), и дать
 * layout-агенту изолированную песочницу для полировки контраста/тёмной
 * темы. WDL — в промилле POV решателя (как `latestWdl` в раннере).
 */

interface Row {
  title: string;
  wdl: WdlDistribution | null;
}

const ROWS: Row[] = [
  { title: 'Loading (оценка ещё не получена, wdl=null)', wdl: null },
  { title: 'Решатель уверенно выигрывает (W 78 / D 17 / L 5)', wdl: { w: 780, d: 170, l: 50 } },
  { title: 'Небольшой перевес решателя (W 52 / D 38 / L 10)', wdl: { w: 520, d: 380, l: 100 } },
  { title: 'Равная позиция (W 30 / D 45 / L 25)', wdl: { w: 300, d: 450, l: 250 } },
  { title: 'Решатель проигрывает (W 8 / D 22 / L 70)', wdl: { w: 80, d: 220, l: 700 } },
  { title: 'Почти мат за решателя (W 96 / D 3 / L 1)', wdl: { w: 960, d: 30, l: 10 } },
];

export function DevWdlChancesBarPage() {
  return (
    <div style={{ maxWidth: 620, margin: '24px auto', padding: 16 }}>
      <h1>KS-3391 — WDL chances bar demo</h1>
      <p style={{ color: '#888', marginBottom: 24 }}>
        Трёхцветная горизонтальная полоса шансов W/D/L (зелёный/серый/красный),
        POV решателя. Заменяет вертикальный градусник (EvalBar) на /precision.
        Данные — промилле, как `latestWdl` в PlayVsEngineRunner.
      </p>

      {/* KS-3391: «живое» уточнение — главная демонстрация реалтайма. */}
      <h2 style={{ marginTop: 0, marginBottom: 12 }}>
        Реалтайм: уточнение оценки по мере анализа (зациклено)
      </h2>
      <LiveSimDemo />

      {/* KS-3391: реплика desktop-grid раскладки PlayVsEngineRunner —
          проверка, что полоса корректно встаёт над доской в колонке 1
          (grid-row 1), а «доска» уходит на row 2/-1. */}
      <h2 style={{ marginTop: 0, marginBottom: 12 }}>
        Размещение в раскладке раннера (над доской)
      </h2>
      <div className="puzzle-engine-runner" data-state="thinking" style={{ marginBottom: 32 }}>
        <div className="puzzle-engine-runner__layout">
          <div className="puzzle-engine-runner__board-col">
            <WdlChancesBar wdl={{ w: 640, d: 280, l: 80 }} testId="dev-wdl-runner" />
            <div
              className="board-container"
              style={{ aspectRatio: '1 / 1', background: '#769656', borderRadius: 4 }}
            />
            <div className="puzzle-engine-runner__progress">
              <div className="puzzle-engine-runner__progress-title">Task progress</div>
              <div className="puzzle-engine-runner__progress-bar">
                <div className="puzzle-engine-runner__progress-fill" style={{ width: '40%' }} />
              </div>
              <div className="puzzle-engine-runner__progress-label">6 half-moves left</div>
            </div>
          </div>
        </div>
      </div>

      {ROWS.map((row) => (
        <div key={row.title} style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>
            {row.title}
          </div>
          {/* Ширина контейнера ≈ ширине доски на /precision (560px). */}
          <div style={{ maxWidth: 560 }}>
            <WdlChancesBar wdl={row.wdl} testId={`dev-wdl-${row.wdl ? row.wdl.w : 'loading'}`} />
          </div>
        </div>
      ))}
    </div>
  );
}
