import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';
import type { CSSProperties } from 'react';
import { renderWithProviders, screen } from '../../test/test-utils';

// Мок MemoChessboard — fire-buttons по клеткам.
vi.mock('../MemoChessboard', () => ({
  MemoChessboard: ({
    options,
  }: {
    options: {
      position?: string;
      onSquareClick?: (a: { piece: unknown; square: string }) => void;
      squareStyles?: Record<string, CSSProperties>;
    };
  }) => {
    const SQUARES = ['e1', 'e2', 'e8', 'd1', 'd8', 'h5', 'h8', 'a1', 'b1', 'c1', 'd5', 'h1'];
    return (
      <div data-testid="mock-board" data-position={options.position}>
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

// useFastDrag — runner на drag не полагается в этих тестах, простой no-op.
vi.mock('../../hooks/useFastDrag', () => ({
  useFastDrag: () => ({ suppressAnimationRef: { current: false } }),
}));

import { FindAllChecksRunner } from './FindAllChecksRunner';

// Позиция из methodology §11 примера: ладья d1 vs король e8 — есть
// ходы Rd8+ (mate) и движение по 1-й линии. Используем простой сценарий
// с двумя ожидаемыми шахами.
const DRILL = {
  id: 'd-facr',
  drillType: 'find-all-checks' as const,
  // Простая позиция: ладья d1, ферзь h5, белые на ходу. Шахи: Rd8+ (d1d8), Qh8+ (h5h8).
  // Используем условную FEN — chess.js валидирует только legality, важно
  // чтобы expectedMoves совпадали с легальными.
  fen: '4k3/8/8/7Q/8/8/4K3/3R4 w - - 0 1',
  sideToMove: 'w' as const,
  answerShape: 'squares' as const,
  difficulty: 3,
  meta: {
    expectedCount: 2,
    expectedMoves: ['d1d8', 'h5h8'],
  },
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => vi.restoreAllMocks());

describe('<FindAllChecksRunner> KS-2326', () => {
  it('mount → idle, HUD «0 / 2», expected/found data-attrs', () => {
    const submit = vi.fn();
    renderWithProviders(<FindAllChecksRunner drill={DRILL} submitAnswer={submit} />);
    const root = screen.getByTestId('find-all-checks-runner');
    expect(root.getAttribute('data-state')).toBe('idle');
    expect(root.getAttribute('data-found')).toBe('0');
    expect(root.getAttribute('data-expected')).toBe('2');
    expect(screen.getByTestId('facr-hud').textContent).toBe('0 / 2');
  });

  it('правильный ход (d1→d8) → state=feedback-correct, HUD «1 / 2»', async () => {
    const submit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<FindAllChecksRunner drill={DRILL} submitAnswer={submit} />);
    // Click-click flow: click d1 → click d8.
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-d8'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('feedback-correct'),
    );
    expect(screen.getByTestId('facr-hud').textContent).toBe('1 / 2');
    expect(screen.getByTestId('drill-feedback').getAttribute('data-result')).toBe(
      'correct',
    );
  });

  it('повторный правильный ход (d1→d8 второй раз) → feedback-already, HUD остаётся 1', async () => {
    const submit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FindAllChecksRunner
        drill={DRILL}
        submitAnswer={submit}
        // Уменьшаем delay чтобы быстро вернуться в idle.
        correctFlashMs={20}
        alreadyFlashMs={20}
      />,
    );
    // 1-й правильный ход.
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-d8'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('feedback-correct'),
    );
    // Дожидаемся возврата в idle.
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('idle'),
    );
    // Тот же ход → already.
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-d8'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('feedback-already'),
    );
    // HUD остаётся 1/2 (already не инкрементит found).
    expect(screen.getByTestId('facr-hud').textContent).toBe('1 / 2');
  });

  it('ход НЕ из expected (d1→a1) → feedback-wrong, attempts++', async () => {
    const submit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FindAllChecksRunner drill={DRILL} submitAnswer={submit} wrongFlashMs={20} />,
    );
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-a1'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('feedback-wrong'),
    );
    expect(
      screen.getByTestId('find-all-checks-runner').getAttribute('data-attempts'),
    ).toBe('1');
    expect(screen.getByTestId('drill-feedback').getAttribute('data-result')).toBe(
      'incorrect',
    );
  });

  it('после wrong-feedback state возвращается в idle (auto-undo через timer)', async () => {
    const submit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FindAllChecksRunner drill={DRILL} submitAnswer={submit} wrongFlashMs={20} />,
    );
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-a1'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('feedback-wrong'),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('idle'),
    );
  });

  it('auto-submit: found.size===expected → submitAnswer вызван c shape="squares" + onComplete', async () => {
    const submit = vi.fn(async () => ({
      attemptId: 'a1',
      solved: true,
      correctAnswer: { shape: 'squares', squares: ['d8', 'h8'] },
    }));
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <FindAllChecksRunner
        drill={DRILL}
        submitAnswer={submit}
        onComplete={onComplete}
        correctFlashMs={20}
      />,
    );
    // 1-й шах: d1→d8.
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-d8'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('idle'),
    );
    // 2-й шах: h5→h8 — должен триггернуть auto-submit.
    await user.click(screen.getByTestId('fire-square-h5'));
    await user.click(screen.getByTestId('fire-square-h8'));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const call = submit.mock.calls[0][0] as {
      drillId: string;
      userAnswer: { shape: string; squares: string[] };
    };
    expect(call.drillId).toBe('d-facr');
    expect(call.userAnswer.shape).toBe('squares');
    // Squares — TO-клетки правильных шахов (порядок неважен).
    expect(call.userAnswer.squares.sort()).toEqual(['d8', 'h8']);
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({ solved: true, foundCount: 2 }),
    );
  });

  it('кнопка «Готово» появляется при found > 0 < expected, дёргает submit', async () => {
    const submit = vi.fn(async () => ({
      attemptId: 'a',
      solved: false,
      correctAnswer: { shape: 'squares', squares: ['d8', 'h8'] },
    }));
    const user = userEvent.setup();
    renderWithProviders(
      <FindAllChecksRunner drill={DRILL} submitAnswer={submit} correctFlashMs={20} />,
    );
    // По умолчанию facr-finish скрыт (found=0).
    expect(screen.queryByTestId('facr-finish')).not.toBeInTheDocument();
    // 1 шах → кнопка появляется.
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-d8'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('idle'),
    );
    expect(screen.getByTestId('facr-finish')).toBeInTheDocument();
    // Click → submit.
    await user.click(screen.getByTestId('facr-finish'));
    await waitFor(() => expect(submit).toHaveBeenCalled());
  });

  it('expectedMoves пуст → state=error с missingData', () => {
    const drill = { ...DRILL, meta: { ...DRILL.meta, expectedMoves: [] } };
    const submit = vi.fn();
    renderWithProviders(<FindAllChecksRunner drill={drill} submitAnswer={submit} />);
    const root = screen.getByTestId('find-all-checks-runner');
    expect(root.getAttribute('data-state')).toBe('error');
  });

  // KS-2460: финальный экран с DrillExplanationPanel.
  describe('KS-2460 — финальный экран с разбором', () => {
    it('solved=true: после auto-submit рендерится panel data-result="correct"', async () => {
      const submit = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'squares', squares: ['d8', 'h8'] },
      }));
      const onComplete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <FindAllChecksRunner
          drill={DRILL}
          submitAnswer={submit}
          onComplete={onComplete}
          correctFlashMs={20}
          // Длинный auto-next, чтобы успеть проверить panel до перехода.
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      await user.click(screen.getByTestId('fire-square-d1'));
      await user.click(screen.getByTestId('fire-square-d8'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('idle'),
      );
      await user.click(screen.getByTestId('fire-square-h5'));
      await user.click(screen.getByTestId('fire-square-h8'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('done'),
      );
      const panel = screen.getByTestId('drill-explanation-panel');
      expect(panel.getAttribute('data-result')).toBe('correct');
      expect(screen.getByTestId('drill-explanation-next')).toBeInTheDocument();
      // onComplete ещё не вызван — таймер 60с.
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('manual «Дальше» прерывает auto-next и сразу вызывает onComplete', async () => {
      const submit = vi.fn(async () => ({
        attemptId: 'a1',
        solved: true,
        correctAnswer: { shape: 'squares', squares: ['d8', 'h8'] },
      }));
      const onComplete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <FindAllChecksRunner
          drill={DRILL}
          submitAnswer={submit}
          onComplete={onComplete}
          correctFlashMs={20}
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      // Найти все шахи → done.
      await user.click(screen.getByTestId('fire-square-d1'));
      await user.click(screen.getByTestId('fire-square-d8'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('idle'),
      );
      await user.click(screen.getByTestId('fire-square-h5'));
      await user.click(screen.getByTestId('fire-square-h8'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('done'),
      );
      // Manual click — onComplete должен быть вызван моментально.
      await user.click(screen.getByTestId('drill-explanation-next'));
      expect(onComplete).toHaveBeenCalledWith({ solved: true, foundCount: 2 });
    });

    it('solved=false (через «Готово» с одним шахом): panel data-result="incorrect" + missed-стрелка для пропущенного', async () => {
      const submit = vi.fn(async () => ({
        attemptId: 'a1',
        solved: false,
        correctAnswer: { shape: 'squares', squares: ['d8', 'h8'] },
      }));
      const onComplete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <FindAllChecksRunner
          drill={DRILL}
          submitAnswer={submit}
          onComplete={onComplete}
          correctFlashMs={20}
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      // Только один шах.
      await user.click(screen.getByTestId('fire-square-d1'));
      await user.click(screen.getByTestId('fire-square-d8'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('idle'),
      );
      // Финишируем через «Готово».
      await user.click(screen.getByTestId('facr-finish'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('done'),
      );
      const panel = screen.getByTestId('drill-explanation-panel');
      expect(panel.getAttribute('data-result')).toBe('incorrect');
      // На длинном auto-next-таймере onComplete пока не вызвался.
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('FP-клик на не-шах накапливает wrongTos для финального разбора', async () => {
      const submit = vi.fn(async () => ({
        attemptId: 'a1',
        solved: false,
        correctAnswer: { shape: 'squares', squares: ['d8', 'h8'] },
      }));
      const onComplete = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <FindAllChecksRunner
          drill={DRILL}
          submitAnswer={submit}
          onComplete={onComplete}
          correctFlashMs={20}
          alreadyFlashMs={20}
          wrongFlashMs={20}
          autoNextDelayCorrectMs={60_000}
          autoNextDelayIncorrectMs={60_000}
        />,
      );
      // FP-ход d1→a1: легальный, но не шах.
      await user.click(screen.getByTestId('fire-square-d1'));
      await user.click(screen.getByTestId('fire-square-a1'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('idle'),
      );
      // Корректный шах + finish → done.
      await user.click(screen.getByTestId('fire-square-d1'));
      await user.click(screen.getByTestId('fire-square-d8'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('idle'),
      );
      await user.click(screen.getByTestId('facr-finish'));
      await waitFor(() =>
        expect(
          screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
        ).toBe('done'),
      );
      // В панели должен быть wrong-note (engine видит a1 в userAnswer
      // как не входящую в correctSquares).
      const wrongNote = screen
        .getAllByTestId('drill-explanation-note')
        .find((n) => n.getAttribute('data-tone') === 'wrong');
      expect(wrongNote).toBeDefined();
    });
  });

  it('expectedMoves в формате object (не UCI-string) — нормализуется', async () => {
    const drill = {
      ...DRILL,
      meta: {
        ...DRILL.meta,
        expectedMoves: [
          { from: 'd1', to: 'd8' },
          { from: 'h5', to: 'h8' },
        ],
      },
    };
    const submit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<FindAllChecksRunner drill={drill} submitAnswer={submit} />);
    await user.click(screen.getByTestId('fire-square-d1'));
    await user.click(screen.getByTestId('fire-square-d8'));
    await waitFor(() =>
      expect(
        screen.getByTestId('find-all-checks-runner').getAttribute('data-state'),
      ).toBe('feedback-correct'),
    );
  });
});
