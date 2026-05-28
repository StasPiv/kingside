import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import { PromotionPicker } from '../components/PromotionPicker';
import { useBoardSettings, PIECE_SETS } from '../hooks/useBoardSettings';
import type { PieceSetId } from '../hooks/useBoardSettings';

/**
 * KS-3395 — dev-демо: доска + открытое окно превращения в ОДНОМ стиле.
 * Доступно через `/dev/promotion-picker?dev_bypass=secret&set=<pieceSet>`.
 *
 * Назначение: визуально подтвердить, что PromotionPicker рисует фигуры
 * тем же стилем, что доска (react-chessboard) для текущего pieceSet —
 * включая 'standard' (встроенные фигуры библиотеки). Доска и picker
 * берут один источник: `customPieces` из BoardSettingsContext
 * (undefined → defaultPieces для 'standard').
 */

// Позиция со всеми фигурами обоих цветов — видно стиль Q/R/B/N на доске.
const SHOWCASE_FEN = 'rnbqkbnr/8/8/8/8/8/8/RNBQKBNR w - - 0 1';

export function DevPromotionPickerPage() {
  const [params] = useSearchParams();
  const { pieceSet, customPieces, selectPieceSet } = useBoardSettings();

  // Применяем pieceSet из query (?set=standard|chessnut|...).
  const requested = params.get('set') as PieceSetId | null;
  useEffect(() => {
    if (requested && PIECE_SETS.some((s) => s.id === requested) && requested !== pieceSet) {
      selectPieceSet(requested);
    }
  }, [requested, pieceSet, selectPieceSet]);

  return (
    <div style={{ maxWidth: 520, margin: '24px auto', padding: 16 }}>
      <h1>KS-3395 — picker matches board</h1>
      <p style={{ color: '#888', marginBottom: 16 }}>
        pieceSet: <b>{pieceSet}</b>. Доска и окно превращения должны быть в
        одном стиле. Для 'standard' — встроенные фигуры react-chessboard.
      </p>
      <div style={{ width: 360, position: 'relative' }}>
        <Chessboard
          options={{
            position: SHOWCASE_FEN,
            pieces: customPieces,
            allowDragging: false,
            showNotation: false,
            id: 'dev-promo-board',
          }}
        />
        {/* Окно превращения всегда открыто — для скриншота. */}
        <PromotionPicker
          pending={{ from: 'e7', to: 'e8' }}
          color="w"
          onChoice={() => {}}
          onCancel={() => {}}
        />
      </div>
    </div>
  );
}
