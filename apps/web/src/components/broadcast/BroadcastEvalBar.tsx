import type { EvalSnapshot } from '../../hooks/useBroadcastEvalQueue';

/**
 * KS-2708. Вертикальный eval-bar для мини-доски broadcast-страницы.
 * Тонкий (8px desktop / 12px mobile через CSS), высотой как доска,
 * слева от неё.
 *
 * Преобразование cp → процент белых:
 *   pct = 50 + 50 * (2 / (1 + exp(-cp/400)) - 1)
 * — стандартная сигмоида Lichess (clamp 2..98 чтобы у краёв оставалась
 * полоска другого цвета и было видно знак).
 *
 * mate → 100% той стороне (mate>0 — белые матуют, 100% white).
 *
 * Если оценки нет (`evalSnap === null`) — серый бар без подписи. На
 * завершившейся партии родитель может не передавать evalSnap —
 * выводим серый.
 */

export interface BroadcastEvalBarProps {
  evalSnap: EvalSnapshot | null | undefined;
  /** Если партия завершена — bar показывает 100% победившей стороне. */
  finalResult?: '1-0' | '0-1' | '1/2-1/2' | null;
}

function evalToWhitePct(snap: EvalSnapshot): number {
  if (snap.mate != null) {
    return snap.mate > 0 ? 100 : 0;
  }
  if (snap.cp == null) return 50;
  const pct = 50 + 50 * (2 / (1 + Math.exp(-snap.cp / 400)) - 1);
  return Math.max(2, Math.min(98, pct));
}

function formatEvalText(snap: EvalSnapshot): string {
  if (snap.mate != null) {
    const m = Math.abs(snap.mate);
    return `${snap.mate > 0 ? 'M' : '-M'}${m}`;
  }
  if (snap.cp == null) return '';
  const v = snap.cp / 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

export function BroadcastEvalBar({
  evalSnap,
  finalResult,
}: BroadcastEvalBarProps) {
  let whitePct: number;
  let label: string;
  let className = 'broadcast-eval-bar';

  if (finalResult === '1-0') {
    whitePct = 100;
    label = '1-0';
    className += ' broadcast-eval-bar--final';
  } else if (finalResult === '0-1') {
    whitePct = 0;
    label = '0-1';
    className += ' broadcast-eval-bar--final';
  } else if (finalResult === '1/2-1/2') {
    whitePct = 50;
    label = '½';
    className += ' broadcast-eval-bar--final';
  } else if (evalSnap) {
    whitePct = evalToWhitePct(evalSnap);
    label = formatEvalText(evalSnap);
  } else {
    // Анализа ещё нет — серый бар без подписи.
    return (
      <div
        className="broadcast-eval-bar broadcast-eval-bar--pending"
        data-testid="broadcast-eval-bar"
        aria-hidden="true"
      />
    );
  }

  // SVG с двумя прямоугольниками — белый снизу, чёрный сверху,
  // граница тонкая. Высота наследуется от CSS контейнера через 100%.
  // Подпись — текст в углу (сверху если white > 50, внизу если < 50).
  const blackHeight = 100 - whitePct;
  const labelOnTop = whitePct < 50;
  return (
    <div
      className={className}
      data-testid="broadcast-eval-bar"
      title={label}
      aria-label={label}
    >
      <div className="broadcast-eval-bar__track">
        <div
          className="broadcast-eval-bar__black"
          style={{ height: `${blackHeight}%` }}
        />
        <div
          className="broadcast-eval-bar__white"
          style={{ height: `${whitePct}%` }}
        />
      </div>
      {label && (
        <div
          className={`broadcast-eval-bar__label${labelOnTop ? ' broadcast-eval-bar__label--top' : ''}`}
        >
          {label}
        </div>
      )}
    </div>
  );
}
