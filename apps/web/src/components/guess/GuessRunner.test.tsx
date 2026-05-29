import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { GuessRunner } from './GuessRunner';
import type {
  EngineAdapter,
  AnalysisResult,
  InfoLine,
} from '../../utils/engineAdapter';
import type { Wdl } from '@kingside/shared';

/**
 * KS-3410 (ADR-086 §9, F1) — guess-runner. Движок и доска замоканы:
 *   - ScriptedEngine отдаёт заранее заданные WDL/PV по очереди analyze;
 *   - MemoChessboard → кнопки fire-square для click-ввода хода
 *     (как в PlayVsEngineRunner.test); раскрывает options.arrows в data-attr.
 */

vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      arrows?: Array<{ startSquare: string; endSquare: string; color: string }>;
      onSquareClick?: (a: { piece: unknown; square: string }) => void;
      squareStyles?: Record<string, CSSProperties>;
    };
  }) => {
    const SQUARES = [
      'a2', 'a3', 'd2', 'd4', 'e2', 'e4', 'e7', 'e5', 'g1', 'f3',
    ];
    return (
      <div
        data-testid="mock-board"
        data-position={options.position}
        data-arrows={(options.arrows ?? []).length}
      >
        {SQUARES.map((sq) => (
          <button
            key={sq}
            type="button"
            data-testid={`fire-square-${sq}`}
            onClick={() => options.onSquareClick?.({ piece: null, square: sq })}
          >
            {sq}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock('../../hooks/useFastDrag', () => ({
  useFastDrag: () => ({ suppressAnimationRef: { current: false } }),
}));

function line(pv: string[], wdl: Wdl, cp = 30): InfoLine {
  return { depth: 16, multipv: 1, score: { type: 'cp', value: cp }, pv, wdl };
}
function result(infoLine: InfoLine): AnalysisResult {
  return {
    lines: [infoLine],
    bestByDepth: new Map([[infoLine.depth, infoLine.pv[0]]]),
    evalByDepth: new Map([[infoLine.depth, infoLine.score.value]]),
    firstAppearance: 1,
  };
}

class ScriptedEngine implements EngineAdapter {
  private q: AnalysisResult[];
  constructor(q: AnalysisResult[]) {
    this.q = [...q];
  }
  async init(): Promise<void> {}
  setOption(): void {}
  async analyze(): Promise<AnalysisResult> {
    return (
      this.q.shift() ?? {
        lines: [],
        bestByDepth: new Map(),
        evalByDepth: new Map(),
        firstAppearance: 0,
      }
    );
  }
  async analyzeLive(): Promise<void> {}
  stop(): void {}
  destroy(): void {}
}

// 1.e4 e5 2.Nf3 — white = guessing side; ply1 (e4) — guess.
const PGN = '[Event "Test"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *';

afterEach(() => vi.restoreAllMocks());

describe('<GuessRunner> KS-3410', () => {
  it('первый guess-полуход: после префетча — awaitGuess + prompt', async () => {
    // ply1 (e4): analyze(fenBefore=start) → pv d2d4, wdl; analyze(fenAfter e4).
    const engine = new ScriptedEngine([
      result(line(['d2d4'], { w: 500, d: 300, l: 200 })), // before (POV white)
      result(line(['e7e5'], { w: 300, d: 300, l: 400 })), // after e4 (POV black raw)
    ]);
    renderWithProviders(
      <GuessRunner pgn={PGN} side="white" engineFactory={() => engine} />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('guess-runner').getAttribute('data-phase'),
      ).toBe('awaitGuess'),
    );
    expect(screen.getByTestId('guess-runner-prompt')).toBeTruthy();
  });

  it('совпал с реальным ходом (e4) → reaction asPlayer + короткий вердикт «Равно» + автопереход без кнопки (KS-3424)', async () => {
    const engine = new ScriptedEngine([
      result(line(['d2d4'], { w: 500, d: 300, l: 200 })), // before
      result(line(['e7e5'], { w: 300, d: 300, l: 400 })), // after played e4
    ]);
    renderWithProviders(
      // reactionHoldMs побольше, чтобы успеть проверить verdict, а
      // автопереход — отдельным waitFor с реальным таймером.
      <GuessRunner
        pgn={PGN}
        side="white"
        engineFactory={() => engine}
        reactionHoldMs={150}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-runner').getAttribute('data-phase')).toBe(
        'awaitGuess',
      ),
    );
    // Играем реальный ход e2-e4 (click e2 → click e4).
    (screen.getByTestId('fire-square-e2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-e4') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(screen.getByTestId('guess-runner').getAttribute('data-verdict')).toBe(
        'asPlayer',
      ),
    );
    // Короткий вердикт «Равно» / "Same" (asPlayer → tone=equal).
    expect(
      screen.getByTestId('guess-runner-verdict-short').getAttribute('data-tone'),
    ).toBe('equal');
    // Кнопки «Дальше» больше нет.
    expect(screen.queryByTestId('guess-runner-continue')).toBeNull();
    // Автопереход после reactionHoldMs.
    await waitFor(
      () => {
        const ph = screen.getByTestId('guess-runner').getAttribute('data-phase');
        expect(['autoplay', 'prefetch', 'awaitGuess', 'init']).toContain(ph);
      },
      { timeout: 2000 },
    );
  });

  it('слабее реального → вердикт weaker, стрелок реакции на доске НЕТ (KS-3424)', async () => {
    const engine = new ScriptedEngine([
      result(line(['d2d4'], { w: 500, d: 300, l: 200 })), // before, best=d2d4
      result(line(['e7e5'], { w: 300, d: 300, l: 400 })), // after played e4 (lossPlayer~0.10)
      result(line(['x'], { w: 500, d: 300, l: 200 })), // after user a3 (lossUser~0.30)
    ]);
    renderWithProviders(
      <GuessRunner
        pgn={PGN}
        side="white"
        engineFactory={() => engine}
        reactionHoldMs={5000}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('guess-runner').getAttribute('data-phase')).toBe(
        'awaitGuess',
      ),
    );
    // Играем слабый ход a2-a3 (≠ played e4, ≠ best d4).
    (screen.getByTestId('fire-square-a2') as HTMLButtonElement).click();
    (screen.getByTestId('fire-square-a3') as HTMLButtonElement).click();
    await waitFor(() =>
      expect(screen.getByTestId('guess-runner-reaction')).toBeTruthy(),
    );
    expect(screen.getByTestId('guess-runner').getAttribute('data-verdict')).toBe(
      'weaker',
    );
    // Короткий вердикт «Хуже» / "Worse" (weaker → tone=worse).
    expect(
      screen.getByTestId('guess-runner-verdict-short').getAttribute('data-tone'),
    ).toBe('worse');
    // KS-3424: стрелки реакции убраны → data-arrows=0 (только internal
    // подсветка last-move от useBoardHighlights, кастомных нет).
    expect(screen.getByTestId('mock-board').getAttribute('data-arrows')).toBe('0');
    // WDL-шкала отрисована и показывает live-значение.
    expect(screen.getByTestId('guess-runner-wdl')).toBeTruthy();
  });
});
