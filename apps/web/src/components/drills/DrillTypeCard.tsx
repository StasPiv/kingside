import type { ReactNode } from 'react';
import {
  PuzzleMiniBoard,
  type MiniBoardArrow,
  type MiniBoardSquare,
} from '../puzzle/PuzzleMiniBoard';

/**
 * KS-2234 (ADR-035 §7.3, E3) — карточка drill-типа в лобби `/drills`.
 *
 * Кликабельная плитка с заголовком, кратким описанием и опциональными
 * иконкой/badge. Используется как элемент сетки в `DrillLobbyPage`
 * (KS-DRILL-LOBBY).
 *
 * # Контракт DOM
 *
 *   <button class="drill-type-card"
 *           type="button"
 *           data-testid="drill-type-card"
 *           data-disabled="true|false"
 *           disabled?>
 *     {icon && <span class="drill-type-card__icon" aria-hidden="true">…</span>}
 *     <span class="drill-type-card__title">{title}</span>
 *     {description && <span class="drill-type-card__desc">{description}</span>}
 *     {badge && <span class="drill-type-card__badge">{badge}</span>}
 *   </button>
 *
 * Кнопка, не div: keyboard-accessible (Enter/Space) + читается как
 * action для screen reader. `aria-label` собирается из title + description
 * (если есть), чтобы скринридер озвучивал суть, а не только заголовок.
 */
/**
 * KS-2685: иллюстративная мини-доска (FEN + arrows + squares) внутри
 * карточки тренажёра. Если не передана — карточка остаётся как раньше
 * (только текст), без регрессии для неpenpicked типов.
 */
export interface DrillTypeCardPreview {
  fen: string;
  arrows?: MiniBoardArrow[];
  squares?: MiniBoardSquare[];
  orientation?: 'white' | 'black';
}

export interface DrillTypeCardProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  preview?: DrillTypeCardPreview;
}

export function DrillTypeCard({
  title,
  description,
  icon,
  badge,
  disabled = false,
  onClick,
  preview,
}: DrillTypeCardProps) {
  const ariaLabel = description ? `${title}. ${description}` : title;
  return (
    <button
      type="button"
      className="drill-type-card"
      data-testid="drill-type-card"
      data-disabled={disabled ? 'true' : 'false'}
      data-has-preview={preview ? 'true' : 'false'}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {preview && (
        <span
          className="drill-type-card__preview"
          aria-hidden="true"
          data-testid="drill-type-card-preview"
        >
          <PuzzleMiniBoard
            fen={preview.fen}
            arrows={preview.arrows}
            squares={preview.squares}
            orientation={preview.orientation ?? 'white'}
          />
        </span>
      )}
      {icon && (
        <span className="drill-type-card__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="drill-type-card__title">{title}</span>
      {description && (
        <span className="drill-type-card__desc">{description}</span>
      )}
      {badge && <span className="drill-type-card__badge">{badge}</span>}
    </button>
  );
}
