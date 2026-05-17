import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import {
  recognizeBoard,
  type BoardRecognitionResponse,
} from '../api/boardRecognition';
import './BoardImageDropzone.css';

/**
 * KS-2365 / ADR-040 §7. Drag&drop / paste / file-input для скриншота
 * шахматной доски → FEN. Превью на доске рядом, кнопки flip / side-to-move /
 * «править FEN вручную».
 *
 * Backend KS-2363 ещё не задеплоен — `recognizeBoard` отдаёт мок при
 * 404/network, поэтому компонент работоспособен прямо сейчас. После
 * закрытия KS-2363 переключения фронта не требуется.
 *
 * Props:
 *  - `onAccept(fen)` — пользователь подтвердил FEN кнопкой Apply.
 *  - `onCancel` — необязательная отмена (для модалок).
 *  - `initialFen` — если родитель хочет показать стартовую позицию до
 *    загрузки картинки.
 *  - `recognizer` — DI для тестов, по умолчанию `recognizeBoard`.
 */

const EMPTY_FEN_BOARD = '8/8/8/8/8/8/8/8';
const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

type Side = 'w' | 'b';

export interface BoardImageDropzoneProps {
  initialFen?: string;
  onAccept: (fen: string) => void;
  onCancel?: () => void;
  recognizer?: (file: File | Blob) => Promise<BoardRecognitionResponse>;
}

function composeFen(
  fenBoard: string,
  side: Side,
  rest: { castling: string; enPassant: string; halfmove: number; fullmove: number },
): string {
  return `${fenBoard} ${side} ${rest.castling} ${rest.enPassant} ${rest.halfmove} ${rest.fullmove}`;
}

interface FenRest {
  castling: string;
  enPassant: string;
  halfmove: number;
  fullmove: number;
}

function parseFenRest(fen: string): FenRest {
  const parts = fen.split(' ');
  return {
    castling: parts[2] ?? '-',
    enPassant: parts[3] ?? '-',
    halfmove: Number.isFinite(Number(parts[4])) ? Number(parts[4]) : 0,
    fullmove: Number.isFinite(Number(parts[5])) ? Number(parts[5]) : 1,
  };
}

function safeFenBoard(fenFull: string): string {
  return fenFull.split(' ')[0] || EMPTY_FEN_BOARD;
}

function validateFen(fen: string): string | null {
  try {
    new Chess(fen);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid FEN';
  }
}

export function BoardImageDropzone({
  initialFen,
  onAccept,
  onCancel,
  recognizer = recognizeBoard,
}: BoardImageDropzoneProps) {
  const { t } = useTranslation();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BoardRecognitionResponse | null>(null);
  const [fenBoard, setFenBoard] = useState<string>(
    initialFen ? safeFenBoard(initialFen) : EMPTY_FEN_BOARD,
  );
  const [side, setSide] = useState<Side>('w');
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [manualMode, setManualMode] = useState(false);
  const [manualFen, setManualFen] = useState<string>(initialFen ?? STARTING_FEN);
  const [warnings, setWarnings] = useState<string[]>([]);
  // KS-2365: сохраняем «хвост» FEN'а от recognizer'а (castling, en-passant,
  // halfmove, fullmove), чтобы не терять их при ручном переключении side-to-
  // move. Изначально нейтральный — обновится при первом успешном fetch'е.
  const [fenRest, setFenRest] = useState<FenRest>(
    initialFen ? parseFenRest(initialFen) : { castling: '-', enPassant: '-', halfmove: 0, fullmove: 1 },
  );

  // Cleanup для object URL'ов превью.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const handleFile = useCallback(
    async (file: File | Blob) => {
      setError(null);
      setWarnings([]);
      setBusy(true);
      const url = URL.createObjectURL(file);
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      try {
        const res = await recognizer(file);
        setResult(res);
        setFenBoard(res.fenBoard);
        setOrientation(res.orientation);
        const parts = res.fen.split(' ');
        const s = parts[1] === 'b' ? 'b' : 'w';
        setSide(s);
        setFenRest(parseFenRest(res.fen));
        setManualFen(res.fen);
        setWarnings(res.warnings ?? []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('boardImage.errorGeneric', 'Failed to recognize board.'),
        );
      } finally {
        setBusy(false);
      }
    },
    [recognizer, t],
  );

  // Drag & drop через `dataTransfer.files`.
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) {
        void handleFile(file);
      } else {
        setError(t('boardImage.errorNotImage', 'Drop an image file (PNG/JPEG).'));
      }
    },
    [handleFile, t],
  );

  // Paste из clipboard — слушаем на корневом div'е, активном по фокусу,
  // плюс window-fallback пока компонент на экране.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            void handleFile(f);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFile]);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) void handleFile(f);
    },
    [handleFile],
  );

  const previewFen = manualMode ? manualFen : composeFen(fenBoard, side, fenRest);
  const previewError = manualMode ? validateFen(manualFen) : validateFen(previewFen);
  const canApply = !previewError && !busy;

  const handleApply = useCallback(() => {
    if (!canApply) return;
    onAccept(manualMode ? manualFen.trim() : previewFen);
  }, [canApply, onAccept, manualMode, manualFen, previewFen]);

  return (
    <div
      className="board-image-dropzone"
      data-testid="board-image-dropzone"
      role="region"
      aria-label={t('boardImage.regionLabel', 'Board image recognition')}
    >
      <div className="board-image-dropzone__columns">
        <div
          ref={dropRef}
          className={`board-image-dropzone__drop${busy ? ' is-busy' : ''}${imageUrl ? ' has-image' : ''}`}
          onDragOver={onDragOver}
          onDrop={onDrop}
          data-testid="board-image-dropzone-drop"
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={t('boardImage.uploadedAlt', 'Uploaded board')}
              className="board-image-dropzone__preview"
            />
          ) : (
            <>
              <div className="board-image-dropzone__hint-main">
                {t('boardImage.dropHint', 'Drop screenshot here')}
              </div>
              <div className="board-image-dropzone__hint-sub">
                {t(
                  'boardImage.dropHintSub',
                  'or paste from clipboard (Ctrl+V), or pick a file',
                )}
              </div>
            </>
          )}
          <label
            htmlFor={fileInputId}
            className="board-image-dropzone__file-label"
          >
            {imageUrl
              ? t('boardImage.replaceFile', 'Replace image')
              : t('boardImage.pickFile', 'Choose file…')}
          </label>
          <input
            id={fileInputId}
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="board-image-dropzone__file-input"
            onChange={onFileInputChange}
            data-testid="board-image-dropzone-file-input"
          />
          {busy && (
            <div className="board-image-dropzone__busy" data-testid="board-image-dropzone-busy">
              {t('boardImage.recognizing', 'Recognizing…')}
            </div>
          )}
        </div>

        <div className="board-image-dropzone__board-col">
          <div className="board-image-dropzone__board" data-testid="board-image-dropzone-board">
            <Chessboard
              options={{
                position: previewError ? EMPTY_FEN_BOARD : previewFen.split(' ')[0],
                boardOrientation: orientation,
                animationDurationInMs: 0,
                allowDragging: false,
                showNotation: true,
              }}
            />
          </div>
          <div className="board-image-dropzone__controls">
            <button
              type="button"
              className="board-image-dropzone__btn"
              onClick={() =>
                setOrientation((o) => (o === 'white' ? 'black' : 'white'))
              }
              data-testid="board-image-dropzone-flip"
            >
              {t('boardImage.flip', 'Flip board')}
            </button>
            <label className="board-image-dropzone__side">
              {t('boardImage.sideToMove', 'Side to move:')}
              <select
                value={side}
                onChange={(e) => setSide(e.target.value as Side)}
                data-testid="board-image-dropzone-side"
              >
                <option value="w">{t('boardImage.sideWhite', 'White')}</option>
                <option value="b">{t('boardImage.sideBlack', 'Black')}</option>
              </select>
            </label>
            <button
              type="button"
              className={`board-image-dropzone__btn${manualMode ? ' is-active' : ''}`}
              onClick={() => setManualMode((v) => !v)}
              data-testid="board-image-dropzone-toggle-manual"
            >
              {manualMode
                ? t('boardImage.exitManual', 'Auto FEN')
                : t('boardImage.editManually', 'Edit FEN manually')}
            </button>
          </div>
          <div className="board-image-dropzone__fen-row">
            <code
              className="board-image-dropzone__fen"
              data-testid="board-image-dropzone-fen"
            >
              {previewFen}
            </code>
            {manualMode && (
              <input
                type="text"
                className="board-image-dropzone__fen-input"
                value={manualFen}
                onChange={(e) => setManualFen(e.target.value)}
                spellCheck={false}
                data-testid="board-image-dropzone-fen-input"
              />
            )}
          </div>
          {previewError && (
            <div className="board-image-dropzone__error" role="alert">
              {previewError}
            </div>
          )}
          {warnings.length > 0 && (
            <ul
              className="board-image-dropzone__warnings"
              data-testid="board-image-dropzone-warnings"
            >
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {result && (
            <div className="board-image-dropzone__meta">
              {t('boardImage.modelVersion', 'Model: {{version}}', {
                version: result.modelVersion,
              })}
              {result.lowConfidenceCells.length > 0 && (
                <>
                  {' · '}
                  {t('boardImage.lowConfidenceCells', '{{count}} low-confidence cells', {
                    count: result.lowConfidenceCells.length,
                  })}
                </>
              )}
            </div>
          )}
          {error && (
            <div className="board-image-dropzone__error" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="board-image-dropzone__actions">
        {onCancel && (
          <button
            type="button"
            className="board-image-dropzone__cancel"
            onClick={onCancel}
          >
            {t('common.cancel', 'Cancel')}
          </button>
        )}
        <button
          type="button"
          className="board-image-dropzone__apply"
          onClick={handleApply}
          disabled={!canApply}
          data-testid="board-image-dropzone-apply"
        >
          {t('boardImage.apply', 'Apply')}
        </button>
      </div>
    </div>
  );
}
