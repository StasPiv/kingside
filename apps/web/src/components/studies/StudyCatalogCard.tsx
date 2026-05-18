import { Link } from 'react-router-dom';
import type { StudyDto, ToggleLikeResponse } from '@kingside/shared';

import { LikeButton } from './LikeButton';

/**
 * KS-2887 / ADR-060 §3.4 K5 (FC2) — карточка студии в каталоге.
 *
 * Состав:
 *   • миниатюра-доска 80×80 (лёгкий SVG, без MemoChessboard);
 *   • имя студии (заголовок);
 *   • описание (truncate в 2 строки через CSS line-clamp);
 *   • метаданные: автор `@username`, кол-во глав, лайки с сердечком;
 *   • topics-chips (lower-case, max 5 на бэке).
 *
 * Вся карточка — нативный `<Link>` на `/studies/:slug`, чтобы:
 *   • Cmd/Ctrl+click открывал в новой вкладке;
 *   • tap на mobile срабатывал без «мёртвых зон»;
 *   • Enter с клавиатуры активировал переход.
 *
 * Превью использует `previewFen` (опционально, родитель может передать
 * FEN первой главы), иначе — стандартная стартовая позиция. StudyDto в
 * каталоге сам по себе не содержит ни ownerUsername, ни startFen главы:
 * родитель (StudiesPage / list-loader) подбирает их в join-запросе.
 */

const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Unicode-glyph'ы фигур. Используются как `<text>` внутри SVG —
 * не тянет внешние ассеты, превью весит ~2KB. Заглавные = белые,
 * строчные = чёрные (FEN-конвенция).
 */
const PIECE_GLYPH: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

const LIGHT_SQUARE = '#f0d9b5';
const DARK_SQUARE = '#b58863';
const WHITE_PIECE_FILL = '#ffffff';
const WHITE_PIECE_STROKE = '#1a1a1a';
const BLACK_PIECE_FILL = '#1a1a1a';

/**
 * Парсит board-секцию FEN ("rnbq.../PPPP...") в матрицу 8×8.
 * Цифры разворачиваются в `null`-ячейки.
 */
function parseFenBoard(fen: string): (string | null)[][] {
  const rows = fen.split(' ')[0].split('/');
  if (rows.length !== 8) {
    // Безопасный фолбэк на стартпоз — превью никогда не должно крашиться
    // из-за некорректного FEN в БД.
    return parseFenBoard(START_FEN);
  }
  return rows.map((row) => {
    const cells: (string | null)[] = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < Number(ch); i += 1) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    // Если строка получилась не 8 — снова безопасный фолбэк.
    return cells.length === 8 ? cells : Array<string | null>(8).fill(null);
  });
}

export interface StudyCatalogCardProps {
  study: StudyDto;
  /**
   * Имя владельца. StudyDto не содержит username (только ownerId);
   * родитель резолвит batch'ем и пробрасывает сюда. Если undefined —
   * рендерим короткий `ownerId.slice(0, 8)` как fallback.
   */
  ownerUsername?: string;
  /**
   * FEN первой главы для превью. Если undefined — стартпоз. Родитель
   * берёт из `StudyWithChaptersResponse.chapters[0].startFen` либо
   * парсит первый PGN.
   */
  previewFen?: string;
  /**
   * KS-2888: уведомление родителя о смене лайка (для обновления списка
   * после успешного toggle).
   */
  onLikeChange?: (state: ToggleLikeResponse) => void;
}

export function StudyCatalogCard({
  study,
  ownerUsername,
  previewFen,
  onLikeChange,
}: StudyCatalogCardProps) {
  const board = parseFenBoard(previewFen ?? START_FEN);
  const author = ownerUsername ?? study.ownerId.slice(0, 8);
  return (
    <Link
      to={`/studies/${study.slug}`}
      className="study-catalog-card"
      data-testid="study-catalog-card"
      data-study-id={study.id}
      data-study-slug={study.slug}
    >
      <div
        className="study-catalog-card__preview"
        data-testid="study-catalog-card-preview"
      >
        <svg
          width="80"
          height="80"
          viewBox="0 0 80 80"
          role="img"
          aria-label={`Preview of ${study.name}`}
        >
          {board.map((row, r) =>
            row.map((piece, c) => {
              const isLight = (r + c) % 2 === 0;
              const x = c * 10;
              const y = r * 10;
              return (
                <g key={`sq-${r}-${c}`}>
                  <rect
                    x={x}
                    y={y}
                    width="10"
                    height="10"
                    fill={isLight ? LIGHT_SQUARE : DARK_SQUARE}
                  />
                  {piece && (
                    <text
                      x={x + 5}
                      y={y + 8.5}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight="bold"
                      fill={
                        piece === piece.toUpperCase()
                          ? WHITE_PIECE_FILL
                          : BLACK_PIECE_FILL
                      }
                      stroke={
                        piece === piece.toUpperCase()
                          ? WHITE_PIECE_STROKE
                          : 'none'
                      }
                      strokeWidth={0.4}
                      style={{ userSelect: 'none' }}
                    >
                      {PIECE_GLYPH[piece]}
                    </text>
                  )}
                </g>
              );
            }),
          )}
        </svg>
      </div>
      <div className="study-catalog-card__body">
        <h3
          className="study-catalog-card__name"
          data-testid="study-catalog-card-name"
        >
          {study.name}
        </h3>
        {study.description && (
          <p
            className="study-catalog-card__description"
            data-testid="study-catalog-card-description"
          >
            {study.description}
          </p>
        )}
        <div className="study-catalog-card__meta">
          <span
            className="study-catalog-card__author"
            data-testid="study-catalog-card-author"
          >
            @{author}
          </span>
          <span
            className="study-catalog-card__chapters"
            data-testid="study-catalog-card-chapters"
          >
            {study.chaptersCount} ch
          </span>
          {/* KS-2888 (FC3): like-кнопка вместо статического span. Клик
              перехватывает preventDefault/stopPropagation внутри
              LikeButton, чтобы Link не уводил на страницу студии. */}
          <span
            className="study-catalog-card__likes"
            data-testid="study-catalog-card-likes"
          >
            <LikeButton
              slug={study.slug}
              studyId={study.id}
              likes={study.likes}
              liked={study.likedByMe}
              onChange={onLikeChange}
            />
          </span>
        </div>
        {study.topics.length > 0 && (
          <div
            className="study-catalog-card__topics"
            data-testid="study-catalog-card-topics"
          >
            {study.topics.map((topic) => (
              <span key={topic} className="study-catalog-card__chip">
                {topic}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
