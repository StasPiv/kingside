import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChessMove } from '../review/types';

export interface VariationChooserProps {
  /** Следующий ход основной линии */
  mainLine: ChessMove;
  /** Альтернативные ветки. Каждая ветка — массив ходов, первый ход — "голова" ветки */
  variations: ChessMove[][];
  /** Выбор основной линии (index 0) или варианта (index >= 1) */
  onSelect: (move: ChessMove) => void;
  /** Закрытие без выбора (Escape / клик по backdrop) */
  onClose: () => void;
}

interface Option {
  label: string;
  move: ChessMove;
}

function formatMoveLabel(move: ChessMove): string {
  const ply = move.ply;
  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;
  return isWhite ? `${moveNumber}.${move.san}` : `${moveNumber}…${move.san}`;
}

export function VariationChooser({
  mainLine,
  variations,
  onSelect,
  onClose,
}: VariationChooserProps) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const options: Option[] = [
    {
      label: `${t('review.variationChooser.mainLine', 'Main line')}: ${formatMoveLabel(mainLine)}`,
      move: mainLine,
    },
    ...variations.map((variation, idx) => ({
      label: `${t('review.variationChooser.variation', 'Variation')} ${idx + 1}: ${formatMoveLabel(variation[0])}`,
      move: variation[0],
    })),
  ];

  const handleSelect = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (opt) onSelect(opt.move);
    },
    // KS-2034: deps — `mainLine`/`variations`, на основе которых строится
    // `options`. Сам `options` мемоизирован через них, и его прямой
    // depend вызовет лишний пересчёт callback'а при той же логической
    // позиции.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSelect, mainLine, variations],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(selectedIndex);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => (prev < options.length - 1 ? prev + 1 : prev));
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const digit = parseInt(e.key, 10);
        const idx = digit - 1;
        if (idx < options.length) {
          e.preventDefault();
          e.stopPropagation();
          handleSelect(idx);
        }
        return;
      }
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'Home' ||
        e.key === 'End'
      ) {
        // Не даём другим обработчикам выполнить навигацию пока открыт чузер
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleSelect, onClose, selectedIndex, options.length]);

  return (
    <div
      className="variation-chooser-overlay"
      onClick={onClose}
      role="presentation"
      data-testid="variation-chooser"
    >
      <div
        className="variation-chooser-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('review.variationChooser.title', 'Choose continuation')}
      >
        <div className="variation-chooser-title">
          {t('review.variationChooser.title', 'Choose continuation')}
        </div>
        <ul className="variation-chooser-list" role="listbox">
          {options.map((opt, idx) => {
            const isActive = idx === selectedIndex;
            return (
              <li
                key={idx}
                role="option"
                aria-selected={isActive}
                className={`variation-chooser-item${isActive ? ' active' : ''}`}
                data-testid={`variation-chooser-item-${idx}`}
                onMouseEnter={() => setSelectedIndex(idx)}
                onClick={() => handleSelect(idx)}
              >
                <span className="variation-chooser-index">{idx + 1}</span>
                <span className="variation-chooser-label">{opt.label}</span>
              </li>
            );
          })}
        </ul>
        <div className="variation-chooser-hint">
          {t(
            'review.variationChooser.hint',
            '↑/↓ or 1–9 · Enter to choose · Esc to cancel',
          )}
        </div>
      </div>
    </div>
  );
}
