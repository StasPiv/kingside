import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';

/**
 * KS-3084. Компактный индикатор активного FEN-фильтра в архиве.
 *
 * До KS-3084 страница `/archive?fen=...` рендерила полноценный
 * `ArchiveGamesByPositionPage` с большой доской и сокращённым набором
 * фильтров — это давало два разных UI под один URL. Жалоба
 * пользователя — должно быть одно окно, FEN — обычный фильтр.
 *
 * Чип:
 *  - мини-доска 56×56 (boardOrientation по side-to-move в FEN);
 *  - короткий хеш FEN (первые 32 символа) — чтобы было видно, что
 *    позиция активна, но не растягивать ряд;
 *  - кнопка «×» / «Clear» — убирает fen из фильтра через onClear.
 */

export interface ArchiveFenChipProps {
  fen: string;
  onClear: () => void;
}

function sideFromFen(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

function shortFen(fen: string): string {
  const trimmed = fen.trim();
  if (trimmed.length <= 32) return trimmed;
  return `${trimmed.slice(0, 32)}…`;
}

export function ArchiveFenChip({ fen, onClear }: ArchiveFenChipProps) {
  const { t } = useTranslation();
  const orientation = sideFromFen(fen);
  return (
    <div
      className="archive-games-metadata__fen-chip"
      data-testid="archive-games-metadata-fen-chip"
    >
      {/* KS-3084 hotfix: span с display:block для chessboard ломал рендер
          фигур (react-chessboard v5 на узком контейнере 56×56 показывал
          пустую доску). Заменили на div + увеличили min-size до 80×80,
          передаём ПОЛНЫЙ fen (а не только board-part) — react-chessboard
          v5 корректнее парсит полный FEN и не зависит от трактовки
          board-only варианта. */}
      <div className="archive-games-metadata__fen-chip-board">
        <Chessboard
          options={{
            position: fen,
            boardOrientation: orientation,
            allowDragging: false,
            showNotation: false,
            animationDurationInMs: 0,
          }}
        />
      </div>
      <span className="archive-games-metadata__fen-chip-info">
        <span className="archive-games-metadata__fen-chip-label">
          {t('archive.games.fenFilter', 'Position filter')}
        </span>
        <code
          className="archive-games-metadata__fen-chip-value"
          title={fen}
          data-testid="archive-games-metadata-fen-chip-value"
        >
          {shortFen(fen)}
        </code>
      </span>
      <button
        type="button"
        className="archive-games-metadata__fen-chip-clear"
        onClick={onClear}
        aria-label={t('common.clear', 'Clear')}
        data-testid="archive-games-metadata-fen-chip-clear"
      >
        ×
      </button>
    </div>
  );
}
