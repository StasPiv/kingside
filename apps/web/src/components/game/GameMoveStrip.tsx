import { useEffect, useRef } from 'react';

/**
 * KS-4291 / ADR-134 §3: компактная горизонтальная полоска ходов под
 * доской для мобильной вёрстки страницы игры (≤899px). Заменяет
 * вертикальную панель `.move-list` в боковой панели, которая на mobile
 * выдавливала действия партии за пределы экрана.
 *
 * - Одна строка, без заголовка «Ходы», без панели/фона.
 * - Горизонтальная прокрутка содержимого, скроллбар скрыт.
 * - Последний ход подсвечивается классом `.current` (тот же класс, что
 *   у элемента в `.move-list`, чтобы переиспользовать существующий CSS,
 *   если когда-нибудь стили унифицируют).
 * - При появлении нового хода компонент сам прокручивает полоску в
 *   конец через `scrollIntoView({ behavior: 'smooth', inline: 'end' })`.
 *
 * На desktop ≥900px компонент CSS-правилом скрыт (`.game-move-strip`
 * по умолчанию `display: none`, включается в @media `max-width: 899px`).
 *
 * Тап по ходу пока не реализован — десктопная `.move-list` тоже не
 * предоставляет такой навигации в `GameShell.tsx`. Слот для коллбэка
 * `onMoveClick` оставлен для будущего расширения.
 */

export interface GameMoveStripProps {
  /**
   * Список SAN-ходов в порядке от первого. Тот же массив, что
   * передаётся в `GameShell.moves`.
   */
  moves: string[];
  /**
   * Опционально: коллбэк на тап по ходу. Index — 0-based номер
   * полу-хода в `moves`. Сейчас не используется, оставлен на будущее.
   */
  onMoveClick?: (index: number) => void;
}

export function GameMoveStrip({ moves, onMoveClick }: GameMoveStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMoveRef = useRef<HTMLSpanElement>(null);

  // Автопрокрутка к последнему ходу при появлении нового.
  useEffect(() => {
    if (!lastMoveRef.current) return;
    lastMoveRef.current.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'end',
    });
  }, [moves.length]);

  return (
    <div
      className="game-move-strip"
      data-testid="game-move-strip"
      ref={containerRef}
      role="list"
    >
      {moves.map((san, i) => {
        const isWhite = i % 2 === 0;
        const moveNumber = Math.floor(i / 2) + 1;
        const display = isWhite ? `${moveNumber}.${san}` : san;
        const isLast = i === moves.length - 1;
        return (
          <span
            key={i}
            ref={isLast ? lastMoveRef : undefined}
            role="listitem"
            data-testid={`game-move-strip-item-${i}`}
            className={`game-move-strip__item${isLast ? ' current' : ''}`}
            onClick={onMoveClick ? () => onMoveClick(i) : undefined}
          >
            {display}
          </span>
        );
      })}
    </div>
  );
}
