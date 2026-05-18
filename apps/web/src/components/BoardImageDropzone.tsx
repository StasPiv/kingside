import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import {
  recognizeBoard,
  BoardRecognitionUnreliableError,
  type BoardRecognitionCell,
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
  /**
   * KS-3093: callback, который дёргается СРАЗУ после распознавания
   * (как успешного 200, так и 422 `recognition_unreliable` с
   * `fenAttempt`). Если родитель его передал — он обычно открывает
   * полноценный board-editor с предзаполненной позицией, чтобы
   * пользователь правил перетаскиванием фигур / переключателем
   * рокировки / side-to-move, а не текстовым FEN-инпутом.
   *
   * Когда `onRecognized` задан, локальная кнопка «Apply» в дропзоне
   * больше не рендерится — apply делается в editor'е родителя
   * (предотвращает двойной flow и недопонимание «куда жать»). Если
   * `onRecognized` не задан — дропзона работает как раньше: Edit FEN
   * + Apply прямо в ней.
   */
  onRecognized?: (fen: string) => void;
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

/**
 * KS-3093: преобразовать (file, rank) → algebraic «a1»..«h8».
 * Контракт `BoardRecognitionCell`: file 0..7 (0=a), rank 0..7 (0=rank 8
 * — top), потому что в FEN-нотации первая строка — 8-й ранг. См.
 * `api/boardRecognition.ts`.
 */
function cellToSquare(cell: BoardRecognitionCell): string | null {
  const f = cell.file;
  const r = cell.rank;
  if (!Number.isInteger(f) || f < 0 || f > 7) return null;
  if (!Number.isInteger(r) || r < 0 || r > 7) return null;
  return `${String.fromCharCode(97 + f)}${8 - r}`;
}

/**
 * KS-3093 / ADR-040-v2 §4. Клиентский sanity-чек board-части FEN.
 * Возвращает массив проблем (пусто = ok). Это мягкое предупреждение,
 * НЕ chess.js-валидация (где «ферзей > 9» формально допустимо), а тот
 * самый набор, который backend проверяет в `recognition_unreliable`:
 *
 *   - ровно один белый и один чёрный король;
 *   - на 1-м и 8-м рангах не должно быть пешек (легальная позиция
 *     требует promotion);
 *   - суммарно ≤ 32 фигуры;
 *   - не более 9 ферзей на сторону (1 родной + 8 промоций).
 *
 * Когда массив пуст, Apply активна. Пока массив не пуст — Apply
 * заблокирован, в UI рисуется warning-плашка с issues.
 */
export function checkBoardSanity(fenBoard: string): string[] {
  const issues: string[] = [];
  const rows = fenBoard.split('/');
  if (rows.length !== 8) {
    issues.push('board must have 8 ranks');
    return issues;
  }
  let whiteKings = 0;
  let blackKings = 0;
  let whiteQueens = 0;
  let blackQueens = 0;
  let totalPieces = 0;
  let pawnOnEdge = false;
  rows.forEach((row, rowIdx) => {
    // rowIdx=0 → rank 8 (top), rowIdx=7 → rank 1 (bottom).
    let fileCount = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        fileCount += Number(ch);
        continue;
      }
      fileCount += 1;
      totalPieces += 1;
      if (ch === 'K') whiteKings += 1;
      else if (ch === 'k') blackKings += 1;
      else if (ch === 'Q') whiteQueens += 1;
      else if (ch === 'q') blackQueens += 1;
      if ((ch === 'P' || ch === 'p') && (rowIdx === 0 || rowIdx === 7)) {
        pawnOnEdge = true;
      }
    }
    if (fileCount !== 8) {
      issues.push(`rank ${8 - rowIdx} doesn't sum to 8 files`);
    }
  });
  if (whiteKings !== 1) issues.push('exactly one white king required');
  if (blackKings !== 1) issues.push('exactly one black king required');
  if (pawnOnEdge) issues.push('some pawns are on the edge rows');
  if (totalPieces > 32) issues.push(`too many pieces (${totalPieces})`);
  if (whiteQueens > 9) issues.push(`too many white queens (${whiteQueens})`);
  if (blackQueens > 9) issues.push(`too many black queens (${blackQueens})`);
  return issues;
}

/**
 * KS-3093: пройти fenBoard и собрать клетки, нарушающие sanity (пешки
 * на 1/8 ранге). Подсвечиваются вместе с `lowConfidenceCells`, чтобы
 * пользователь сразу видел, что именно править.
 */
function findSanityCells(fenBoard: string): string[] {
  const out: string[] = [];
  const rows = fenBoard.split('/');
  if (rows.length !== 8) return out;
  rows.forEach((row, rowIdx) => {
    if (rowIdx !== 0 && rowIdx !== 7) return;
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      if (ch === 'P' || ch === 'p') {
        const sq = `${String.fromCharCode(97 + file)}${8 - rowIdx}`;
        out.push(sq);
      }
      file += 1;
    }
  });
  return out;
}


export function BoardImageDropzone({
  initialFen,
  onAccept,
  onCancel,
  recognizer = recognizeBoard,
  onRecognized,
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
  // KS-3093: backend 422 `recognition_unreliable` — модель распознала
  // позицию, но client-sanity отверг (типичный случай: пешка на a1
  // вместо ладьи). Раньше фронт показывал «Invalid FEN: точка» и
  // блокировал Apply / Edit. Теперь храним issues отдельно от обычных
  // `warnings` (которые приходят при 200), чтобы:
  //   - отрисовать на доске `fenAttempt`, а не пустую;
  //   - показать warning-плашку с причинами;
  //   - подсветить low-confidence + sanity-проблемные клетки;
  //   - оставить Edit FEN / Flip активными, а Apply — заблокированной
  //     пока client-sanity не станет ok.
  const [, setSanityIssues] = useState<string[]>([]);
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
      setSanityIssues([]);
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
        // KS-3093: при успешном распознавании сразу передаём в
        // родительский board-editor — чтобы пользователь правил
        // позицию перетаскиванием фигур / переключателями рокировки /
        // side-to-move, а не текстовым FEN. Если onRecognized не
        // задан — остаёмся на старом потоке (локальный Apply внутри
        // дропзоны).
        if (onRecognized) {
          onRecognized(res.fen);
        }
      } catch (err) {
        // KS-3093: 422 `recognition_unreliable`. Backend распознал и
        // отдал fenAttempt; UI обязан показать его на доске и дать
        // править вручную, а не схлопнуться в общий error-стейт.
        if (err instanceof BoardRecognitionUnreliableError) {
          const p = err.payload;
          if (p.fenAttempt) {
            const board = safeFenBoard(p.fenAttempt);
            const rest = parseFenRest(p.fenAttempt);
            const fenParts = p.fenAttempt.split(' ');
            const stm: Side = fenParts[1] === 'b' ? 'b' : 'w';
            setFenBoard(board);
            setFenRest(rest);
            setSide(stm);
            setOrientation(p.orientation ?? 'white');
            setManualFen(p.fenAttempt);
            // Подменяем `result`-метаданные тем, что есть в payload,
            // чтобы UI ниже корректно показывал modelVersion и
            // lowConfidenceCells. orientation и pseudo-bbox задаём
            // дефолтами — для UI'я они не критичны.
            setResult({
              fen: p.fenAttempt,
              fenBoard: board,
              orientation: p.orientation ?? 'white',
              orientationConfidence: 0,
              bbox: { x: 0, y: 0, width: 0, height: 0 },
              modelVersion: p.modelVersion ?? 'unknown',
              lowConfidenceCells: p.lowConfidenceCells ?? [],
              warnings: [],
            });
            setSanityIssues(p.issues ?? ['recognition_unreliable']);
            setError(null);
            // KS-3093: даже при sanity-провале сразу передаём
            // fenAttempt в родительский editor — пусть пользователь
            // правит позицию drag'ом (a1: P→R и т.п.). Внутри
            // editor'а тот же sanity-чек заблокирует Apply, пока
            // позиция нелегальна.
            if (onRecognized) {
              onRecognized(p.fenAttempt);
            }
            return;
          }
          // Legacy/edge: 422 без fenAttempt — старое поведение
          // «не удалось распознать, загрузите другой снимок».
          setError(
            p.message ??
              t(
                'boardImage.errorUnreliableNoFen',
                'Recognition failed. Please try another screenshot.',
              ),
          );
          return;
        }
        setError(
          err instanceof Error ? err.message : t('boardImage.errorGeneric', 'Failed to recognize board.'),
        );
      } finally {
        setBusy(false);
      }
    },
    [recognizer, t, onRecognized],
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
  // KS-3093: parse-error chess.js — жёсткий блок Apply (только когда
  // юзер сам ввёл мусор в manual-mode). Soft-sanity (checkBoardSanity)
  // — отдельный warning, тоже блокирует Apply, но без alert.
  const previewBoardForSanity = manualMode
    ? manualFen.split(' ')[0] ?? EMPTY_FEN_BOARD
    : fenBoard;
  const liveSanityIssues = checkBoardSanity(previewBoardForSanity);
  const previewError = manualMode ? validateFen(manualFen) : validateFen(previewFen);
  // Apply активен ⇔ chess.js принимает FEN И client-sanity ok И есть
  // распознанный снимок. До загрузки result === null — Apply disabled
  // (как и раньше; раньше из-за того, что pристутствовал parse-error
  // у EMPTY_FEN_BOARD, теперь — явно через !!result).
  const canApply =
    !previewError && liveSanityIssues.length === 0 && !busy && !!result;

  // KS-3093: на доске рисуем previewFen, даже если sanity упал. Раньше
  // на previewError рисовалась пустая доска — это и было «фронтэнд
  // просто выдает ошибку и точка». Теперь пустая доска только если
  // chess.js не смог распарсить ВООБЩЕ (мусор в manual-mode).
  let previewBoardForRender = previewFen.split(' ')[0] ?? EMPTY_FEN_BOARD;
  if (manualMode && previewError) {
    const board = manualFen.split(' ')[0] ?? EMPTY_FEN_BOARD;
    previewBoardForRender =
      board.split('/').length === 8 ? board : EMPTY_FEN_BOARD;
  }

  // KS-3093: подсветка клеток. Объединяем lowConfidenceCells (модель не
  // уверена, жёлтые рамки) и клетки, нарушающие sanity (например, пешки
  // на 1/8 ранге, красные рамки). На общей клетке побеждает sanity.
  const squareStyles: Record<string, React.CSSProperties> = {};
  for (const c of result?.lowConfidenceCells ?? []) {
    const sq = cellToSquare(c);
    if (!sq) continue;
    squareStyles[sq] = {
      boxShadow: 'inset 0 0 0 3px rgba(255, 200, 60, 0.9)',
    };
  }
  for (const sq of findSanityCells(previewBoardForSanity)) {
    squareStyles[sq] = {
      boxShadow: 'inset 0 0 0 3px rgba(240, 80, 80, 0.95)',
    };
  }

  const handleApply = useCallback(() => {
    if (!canApply) return;
    onAccept(manualMode ? manualFen.trim() : previewFen);
  }, [canApply, onAccept, manualMode, manualFen, previewFen]);

  // KS-3093: когда родитель подключил `onRecognized` (= использует
  // полноценный board-editor), локальный Apply / Edit FEN внутри
  // дропзоны прячем. Иначе у пользователя два «куда применять»: внутри
  // дропзоны и в editor'е родителя — путаница. recognizer уже
  // передал fen в onRecognized'е.
  const usesParentEditor = typeof onRecognized === 'function';

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
          <div
            className="board-image-dropzone__board"
            data-testid="board-image-dropzone-board"
            data-fen-board={previewBoardForRender}
          >
            <Chessboard
              options={{
                position: previewBoardForRender,
                boardOrientation: orientation,
                animationDurationInMs: 0,
                allowDragging: false,
                showNotation: true,
                ...(Object.keys(squareStyles).length > 0
                  ? { squareStyles }
                  : {}),
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
            {!usesParentEditor && (
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
            )}
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
          {/* KS-3093: parse-error chess.js — только когда юзер ввёл
              мусор в manual-mode. Раньше это же сообщение показывалось
              и для 422 («pawns on the edge rows» — chess.js тоже
              ругается). Теперь 422-путь приземляется в warning-плашку
              ниже, parse-error остаётся только для невалидного manual. */}
          {manualMode && previewError && (
            <div
              className="board-image-dropzone__error"
              role="alert"
              data-testid="board-image-dropzone-parse-error"
            >
              {previewError}
            </div>
          )}
          {/* KS-3093: warning-плашка — sanity на лету. При 422 сразу
              показывает причины (pawns on edge / no king / …), после
              правки FEN пересчитывается и пропадает, когда позиция
              становится корректной. */}
          {result && liveSanityIssues.length > 0 && (
            <div
              className="board-image-dropzone__sanity-warning"
              role="status"
              data-testid="board-image-dropzone-sanity-warning"
            >
              <div className="board-image-dropzone__sanity-warning-head">
                {t(
                  'boardImage.sanityWarningHead',
                  'Looks off — fix highlighted squares before applying:',
                )}
              </div>
              <ul className="board-image-dropzone__sanity-warning-list">
                {liveSanityIssues.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
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
        {/* KS-3093: при использовании в `SetPositionModal` (вкладка
            «From image») apply делает board-editor родителя — здесь
            кнопка не нужна, иначе у пользователя два «куда жать». */}
        {!usesParentEditor && (
          <button
            type="button"
            className="board-image-dropzone__apply"
            onClick={handleApply}
            disabled={!canApply}
            data-testid="board-image-dropzone-apply"
            title={
              !result
                ? t('boardImage.applyTipNoImage', 'Upload a board screenshot first.')
                : previewError
                  ? previewError
                  : liveSanityIssues.length > 0
                    ? liveSanityIssues.join('; ')
                    : undefined
            }
            aria-disabled={!canApply}
          >
            {t('boardImage.apply', 'Apply')}
          </button>
        )}
      </div>
    </div>
  );
}
