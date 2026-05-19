import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import {
  recognizeBoard,
  BoardNotDetectedError,
  BoardRecognitionUnreliableError,
  resolveOrientation,
  type BoardRecognitionCell,
  type BoardRecognitionResponse,
} from '../api/boardRecognition';
import { cropImageToBlob, type CropArea } from './boardImageCrop';
import {
  InlineBoardEditor,
  fenToEditorBoard,
  editorBoardToFen,
  type PalettePiece,
  type HighlightKind,
} from './InlineBoardEditor';
import './BoardImageDropzone.css';

/**
 * KS-3094: lazy-импорт `react-easy-crop` — компонент весит ~12кб gz,
 * нужен только в момент когда backend вернул 400 `board_not_detected`.
 * При обычной успешной/422-загрузке в bundle он не попадает.
 */
const LazyCropper = lazy(() => import('react-easy-crop'));

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
   * KS-3094: DI для канвас-обрезки. По умолчанию — `cropImageToBlob`
   * из `./boardImageCrop`. Подмена нужна в юнит-тестах (happy-dom не
   * грузит реальные изображения по blob: URL'у).
   */
  cropImage?: (src: string, area: CropArea) => Promise<Blob>;
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

function parseFenRest(fen: string | null | undefined): FenRest {
  // KS-3115: defensive — undefined → нейтральный rest, не падать.
  if (typeof fen !== 'string') {
    return { castling: '-', enPassant: '-', halfmove: 0, fullmove: 1 };
  }
  const parts = fen.split(' ');
  return {
    castling: parts[2] ?? '-',
    enPassant: parts[3] ?? '-',
    halfmove: Number.isFinite(Number(parts[4])) ? Number(parts[4]) : 0,
    fullmove: Number.isFinite(Number(parts[5])) ? Number(parts[5]) : 1,
  };
}

function safeFenBoard(fenFull: string | null | undefined): string {
  // KS-3115: defensive — undefined → пустая доска.
  if (typeof fenFull !== 'string') return EMPTY_FEN_BOARD;
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
 *
 * KS-3106: расширено — теперь также возвращает координаты при
 * нарушениях вида «два белых короля» / «два чёрных короля» /
 * «слишком много ферзей» и т.п. Backend возвращает sanity-issues
 * только текстом без координат (`"exactly one white king required"`),
 * поэтому фронт сам сканирует FEN и находит все клетки виновной
 * фигуры. На скриншоте KS-3106 жалоба: 2 белых короля (b7+h2 в FEN
 * `6b1/kK3r2/...`) не подсвечивались.
 */
export function findSanityCells(fenBoard: string): string[] {
  const out: string[] = [];
  const rows = fenBoard.split('/');
  if (rows.length !== 8) return out;

  // Считаем фигуры одновременно с координатами, чтобы при нарушении
  // подсветить все попавшие в нарушение клетки.
  const positions: Record<string, string[]> = {
    K: [], k: [], Q: [], q: [],
  };
  rows.forEach((row, rowIdx) => {
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const sq = `${String.fromCharCode(97 + file)}${8 - rowIdx}`;
      // Пешка на 1/8 ранге — нарушение.
      if ((ch === 'P' || ch === 'p') && (rowIdx === 0 || rowIdx === 7)) {
        out.push(sq);
      }
      if (ch in positions) {
        positions[ch].push(sq);
      }
      file += 1;
    }
  });

  // Нарушения количества: >1 короля / >9 ферзей. Подсвечиваем все
  // фактические позиции виновной фигуры — пользователь сам решит
  // какую оставить (drag&drop одну из них → подсветка снимается, и
  // если осталась ровно одна — sanity ok).
  if (positions.K.length !== 1) out.push(...positions.K);
  if (positions.k.length !== 1) out.push(...positions.k);
  if (positions.Q.length > 9) out.push(...positions.Q);
  if (positions.q.length > 9) out.push(...positions.q);

  return out;
}


export function BoardImageDropzone({
  initialFen,
  onAccept,
  onCancel,
  recognizer = recognizeBoard,
  cropImage = cropImageToBlob,
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
  // KS-3105: state редактора позиции. После recognize отдаём управление
  // пользователю — он правит фигуры click/drag на встроенном
  // `<InlineBoardEditor>`. Изначально `null` (нет картинки → нет editor'а).
  const [editorBoard, setEditorBoard] = useState<
    Record<string, PalettePiece | undefined> | null
  >(null);
  const [palettePiece, setPalettePiece] = useState<PalettePiece | null>(null);
  // KS-3105: клетки, которые пользователь правил руками — снимаем с них
  // подсветку low/sanity (модель уже не отвечает за их содержимое).
  const [editedCells, setEditedCells] = useState<Set<string>>(new Set());
  // KS-3117: multi-board режим. Когда backend нашёл несколько досок на
  // одной картинке (страница пазлов, учебник с несколькими диаграммами)
  // — здесь массив, UI показывает grid превью для выбора. Single-board
  // и multi-board.length===1 → null (старый flow без grid).
  const [multiBoards, setMultiBoards] = useState<BoardRecognitionResponse[] | null>(null);
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
  // KS-3094: режим «обрезка» после 400 board_not_detected. Когда
  // активен — поверх исходной картинки рендерится react-easy-crop с
  // aspect 1:1, кнопка «Обрезать и распознать заново» вызывает
  // recognizer с обрезанным blob. Если снова 400 — остаёмся в crop-
  // режиме, юзер пробует другой кроп.
  const [cropMode, setCropMode] = useState(false);
  const [cropPos, setCropPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [cropZoom, setCropZoom] = useState(1);
  const cropAreaPxRef = useRef<CropArea | null>(null);
  const lastImageUrlRef = useRef<string | null>(null);
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

  /**
   * KS-3117: вынесенный «apply recognized board» — применяет одну
   * распознанную доску к state'у дропзоны как раньше. Вызывается:
   *  - из `handleFile` при single-board ответе;
   *  - при клике пользователя на превью в multi-board grid.
   * Логика идентична inline-блоку до KS-3117.
   */
  const applyRecognizedBoard = useCallback(
    (res: BoardRecognitionResponse) => {
      setResult(res);
      setFenBoard(res.fenBoard);
      setOrientation(
        resolveOrientation(
          res.orientation,
          res.orientationConfidence,
          res.fenBoard,
        ),
      );
      const parts = res.fen.split(' ');
      const s: Side = parts[1] === 'b' ? 'b' : 'w';
      setSide(s);
      setFenRest(parseFenRest(res.fen));
      setManualFen(res.fen);
      setWarnings(res.warnings ?? []);
      setEditorBoard(fenToEditorBoard(res.fenBoard));
      setEditedCells(new Set());
      setSanityIssues([]);
      setError(null);
      if (onRecognized) {
        onRecognized(res.fen);
      }
    },
    [onRecognized],
  );

  /**
   * KS-3117: клик по превью в multi-board grid'е. Выходим из
   * grid-режима и применяем выбранную доску стандартным flow.
   */
  const handleSelectMultiBoard = useCallback(
    (board: BoardRecognitionResponse) => {
      setMultiBoards(null);
      applyRecognizedBoard(board);
    },
    [applyRecognizedBoard],
  );

  const handleFile = useCallback(
    async (file: File | Blob) => {
      setError(null);
      setWarnings([]);
      setSanityIssues([]);
      // KS-3094: при загрузке НОВОГО файла выходим из crop-режима —
      // он привязан к конкретной картинке. Не сбрасываем профиль/
      // side/orientation: пользовательские настройки сохраняются.
      setCropMode(false);
      setCropPos({ x: 0, y: 0 });
      setCropZoom(1);
      cropAreaPxRef.current = null;
      setBusy(true);
      const url = URL.createObjectURL(file);
      lastImageUrlRef.current = url;
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      try {
        const res = await recognizer(file);
        // KS-3117: multi-board сценарий — несколько досок на одной
        // картинке. Не применяем результат сразу, переключаемся в
        // UI выбора (grid превью ниже). Single (boards отсутствует
        // или ровно одна) — продолжаем старый flow.
        if (res.boards && res.boards.length > 1) {
          setMultiBoards(res.boards);
          setResult(null);
          setEditorBoard(null);
          setSanityIssues([]);
          setError(null);
          return;
        }
        applyRecognizedBoard(res);
      } catch (err) {
        // KS-3094: 400 `board_not_detected`. Stage 1 не нашёл квадрат
        // доски в загруженной картинке. Показываем crop-оверлей —
        // юзер сам выделит доску и нажмёт «Обрезать и распознать
        // заново», мы пошлём кроп тем же recognizer'ом.
        if (err instanceof BoardNotDetectedError) {
          setCropMode(true);
          setCropPos({ x: 0, y: 0 });
          setCropZoom(1);
          cropAreaPxRef.current = null;
          setResult(null);
          setSanityIssues([]);
          setError(null);
          return;
        }
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
            // KS-3108: тот же resolveOrientation для 422-ветки.
            // У 422-payload'а нет `orientationConfidence`, считаем
            // его 0 → всегда применяем autodetect если он сработал.
            setOrientation(
              resolveOrientation(p.orientation, 0, board),
            );
            setManualFen(p.fenAttempt);
            // KS-3105: тот же init редактора и для 422-ветки.
            setEditorBoard(fenToEditorBoard(board));
            setEditedCells(new Set());
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

  // KS-3105: когда есть editorBoard (распознавание прошло), FEN строим
  // из его состояния — пользователь правит фигуры click/drag в редакторе,
  // и мы должны мгновенно отражать это в preview/Apply/sanity. Если
  // редактора нет (ещё ничего не загружали) — старая логика.
  const editorFenBoard = editorBoard ? editorBoardToFen(editorBoard) : null;
  const effectiveFenBoard = editorFenBoard ?? fenBoard;
  const previewFen = manualMode
    ? manualFen
    : composeFen(effectiveFenBoard, side, fenRest);
  // KS-3093: parse-error chess.js — жёсткий блок Apply (только когда
  // юзер сам ввёл мусор в manual-mode). Soft-sanity (checkBoardSanity)
  // — отдельный warning, тоже блокирует Apply, но без alert.
  const previewBoardForSanity = manualMode
    ? manualFen.split(' ')[0] ?? EMPTY_FEN_BOARD
    : effectiveFenBoard;
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
  // KS-3105: при использовании InlineBoardEditor — подсветка убирается
  // с клеток, которые юзер уже исправил руками (editedCells), модель за
  // их содержимое больше не отвечает.
  const squareStyles: Record<string, React.CSSProperties> = {};
  const highlightMap: Partial<Record<string, HighlightKind>> = {};
  for (const c of result?.lowConfidenceCells ?? []) {
    const sq = cellToSquare(c);
    if (!sq) continue;
    if (editedCells.has(sq)) continue;
    squareStyles[sq] = {
      boxShadow: 'inset 0 0 0 3px rgba(255, 200, 60, 0.9)',
    };
    highlightMap[sq] = 'low';
  }
  for (const sq of findSanityCells(previewBoardForSanity)) {
    if (editedCells.has(sq)) continue;
    squareStyles[sq] = {
      boxShadow: 'inset 0 0 0 3px rgba(240, 80, 80, 0.95)',
    };
    highlightMap[sq] = 'sanity';
  }

  const handleApply = useCallback(() => {
    if (!canApply) return;
    onAccept(manualMode ? manualFen.trim() : previewFen);
  }, [canApply, onAccept, manualMode, manualFen, previewFen]);

  // KS-3094: react-easy-crop отдаёт через onCropComplete два набора —
  // % (для state) и пиксели в исходной картинке (для канвас-кропа).
  // Берём пиксели и кладём в ref, чтобы при клике «Обрезать и
  // распознать заново» взять последнюю выбранную область без
  // re-render-petли.
  const onCropComplete = useCallback(
    (_percent: CropArea, pixels: CropArea) => {
      cropAreaPxRef.current = pixels;
    },
    [],
  );

  // KS-3094: «Обрезать и распознать заново». Берём текущий imageUrl
  // (blob:url последнего uploaded файла), обрезаем по выбранной
  // области, прогоняем через handleFile(croppedBlob) — он выйдет из
  // cropMode и пройдёт полный flow распознавания. Если backend снова
  // вернёт 400, мы опять окажемся в cropMode, но уже с новым
  // (обрезанным) imageUrl, как и просит acceptance.
  const handleRecropAndRetry = useCallback(async () => {
    const src = lastImageUrlRef.current;
    // Если пользователь ещё не двигал рамку, react-easy-crop пришлёт
    // onCropComplete сразу после монтирования с дефолтной областью —
    // но дождаться этого можно не успеть, если он сразу нажал retry.
    // Тогда `cropAreaPxRef.current` всё ещё null и retry молча
    // ничего не делает. В этом случае логичнее переотправить
    // исходник целиком — это тот же сценарий, что юзер уже пробовал
    // и получил 400, поэтому делаем no-op и просто оставляем
    // crop-overlay активным.
    const area = cropAreaPxRef.current;
    if (!src || !area) return;
    try {
      const blob = await cropImage(src, area);
      await handleFile(blob);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t('boardImage.cropFailed', 'Failed to crop the image.'),
      );
    }
  }, [handleFile, t, cropImage]);

  // KS-3094: «Загрузить другое изображение». Полный сброс — юзер
  // выбирает другую картинку из системного file-picker'а.
  const handleResetUpload = useCallback(() => {
    setCropMode(false);
    setResult(null);
    setSanityIssues([]);
    setError(null);
    setWarnings([]);
    setFenBoard(EMPTY_FEN_BOARD);
    setManualFen(STARTING_FEN);
    setManualMode(false);
    if (lastImageUrlRef.current) {
      URL.revokeObjectURL(lastImageUrlRef.current);
      lastImageUrlRef.current = null;
    }
    setImageUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    fileInputRef.current?.click();
  }, []);

  // KS-3093: когда родитель подключил `onRecognized` (= использует
  // полноценный board-editor), локальный Apply / Edit FEN внутри
  // дропзоны прячем. Иначе у пользователя два «куда применять»: внутри
  // дропзоны и в editor'е родителя — путаница. recognizer уже
  // передал fen в onRecognized'е.
  const usesParentEditor = typeof onRecognized === 'function';

  // KS-3117: в multi-board режиме рендерим компактный grid превью
  // вместо стандартного layout с InlineBoardEditor. После клика по
  // карточке — `handleSelectMultiBoard(board)` сворачивает multi-state
  // и применяет выбранную доску обычным flow.
  if (multiBoards && multiBoards.length > 1) {
    return (
      <div
        className="board-image-dropzone board-image-dropzone--multi"
        data-testid="board-image-dropzone"
        role="region"
        aria-label={t('boardImage.regionLabel', 'Board image recognition')}
      >
        <div
          className="board-image-dropzone__multi-header"
          data-testid="board-image-dropzone-multi-header"
        >
          {t(
            'boardImage.multiBoardsHint',
            'Found {{count}} boards — pick one to open in the editor.',
            { count: multiBoards.length },
          )}
        </div>
        <div
          className="board-image-dropzone__multi-grid"
          data-testid="board-image-dropzone-multi-grid"
        >
          {multiBoards.map((board, idx) => (
            <button
              key={`${board.fen}-${idx}`}
              type="button"
              className="board-image-dropzone__multi-card"
              onClick={() => handleSelectMultiBoard(board)}
              data-testid={`board-image-dropzone-multi-card-${idx}`}
              aria-label={t('boardImage.multiBoardPick', 'Open board {{n}}', {
                n: idx + 1,
              })}
            >
              <div className="board-image-dropzone__multi-thumb">
                <Chessboard
                  options={{
                    position: board.fenBoard,
                    boardOrientation: resolveOrientation(
                      board.orientation,
                      board.orientationConfidence,
                      board.fenBoard,
                    ),
                    animationDurationInMs: 0,
                    allowDragging: false,
                    showNotation: false,
                  }}
                />
              </div>
              <div className="board-image-dropzone__multi-meta">
                <span className="board-image-dropzone__multi-index">
                  {idx + 1}
                </span>
                <code className="board-image-dropzone__multi-fen">
                  {board.fenBoard}
                </code>
              </div>
            </button>
          ))}
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
        </div>
      </div>
    );
  }

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
          {imageUrl && cropMode ? (
            // KS-3094: crop-оверлей поверх исходной картинки. Cropper
            // загружен lazy, поэтому пока кусок чанка едет — показываем
            // саму картинку (Suspense fallback). Реальный CSS-размер
            // ограничивается контейнером 280×... через .board-image-
            // dropzone__crop-frame.
            <div
              className="board-image-dropzone__crop-frame"
              data-testid="board-image-dropzone-crop-frame"
            >
              {/* KS-3104: вместо отдельной кнопки «Cancel crop» внизу
                  (дублировала верхний Cancel и Reset, визуально шумела)
                  — компактный «×» в правом верхнем углу crop-frame.
                  Функционал тот же: выход из crop-режима БЕЗ recognize,
                  result не трогаем. testid сохранён для существующих
                  тестов KS-3095. */}
              <button
                type="button"
                className="board-image-dropzone__crop-close"
                onClick={() => setCropMode(false)}
                data-testid="board-image-dropzone-crop-cancel"
                aria-label={t('boardImage.cropCancel', 'Cancel crop')}
                title={t('boardImage.cropCancel', 'Cancel crop')}
              >
                ✕
              </button>
              <Suspense
                fallback={
                  <img
                    src={imageUrl}
                    alt={t('boardImage.uploadedAlt', 'Uploaded board')}
                    className="board-image-dropzone__preview"
                  />
                }
              >
                <LazyCropper
                  image={imageUrl}
                  crop={cropPos}
                  zoom={cropZoom}
                  aspect={1}
                  onCropChange={setCropPos}
                  onZoomChange={setCropZoom}
                  onCropComplete={onCropComplete}
                  showGrid={true}
                  // restrictPosition=false даёт юзеру вынести рамку
                  // частично за края — на практике мобильные
                  // скриншоты часто имеют доску у самого края, и
                  // плотное прилегание удобнее.
                  restrictPosition={false}
                />
              </Suspense>
            </div>
          ) : imageUrl ? (
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
          {/* KS-3095 follow-up: «Crop image» — рядом с «Replace image»,
              в drop-зоне под загруженной картинкой. По умолчанию
              recognize прогоняется на исходнике; кнопка позволяет
              уточнить область вручную, если модель распознала плохо.
              Прячем при cropMode (overlay уже активен). Во время
              busy кнопка видна, но disabled (полупрозрачная) —
              чтобы юзер видел, что она существует, а не «исчезла». */}
          {imageUrl && !cropMode && (
            <button
              type="button"
              className="board-image-dropzone__file-label"
              onClick={() => {
                setCropPos({ x: 0, y: 0 });
                setCropZoom(1);
                cropAreaPxRef.current = null;
                setCropMode(true);
              }}
              disabled={busy}
              data-testid="board-image-dropzone-crop-toggle"
            >
              {t('boardImage.cropToggle', 'Crop image')}
            </button>
          )}
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
            {cropMode ? (
              /* KS-3120: в crop-режиме (после 400/500/network-ошибки)
                 не показываем доску справа — раньше она отрисовывала
                 фейковую стартовую позицию из state'а (initialFen
                 родителя), что путало пользователя «как будто
                 распозналась стартовая». Теперь — нейтральный
                 placeholder с подсказкой обрезать кадр. */
              <div
                className="board-image-dropzone__crop-placeholder"
                data-testid="board-image-dropzone-board-crop-placeholder"
              >
                <span aria-hidden="true">⤴</span>
                <p>
                  {t(
                    'boardImage.cropPlaceholder',
                    'Crop the image on the left, then re-recognize.',
                  )}
                </p>
              </div>
            ) : editorBoard ? (
              /* KS-3105: после recognize — полноценный редактор с palette
                 и drag&drop, чтобы пользователь правил фигуры тут же, не
                 уходя на вкладку «Board Editor». Подсветка low-confidence
                 и sanity-нарушений снимается с клетки, когда юзер кладёт
                 туда фигуру руками (cell в `editedCells`). orientation
                 берётся из backend-ответа, можно перевернуть кнопкой Flip
                 ниже. */
              <InlineBoardEditor
                board={editorBoard}
                onBoardChange={setEditorBoard}
                selectedPiece={palettePiece}
                onSelectPiece={setPalettePiece}
                orientation={orientation}
                highlightCells={highlightMap}
                onCellEdited={(sq) =>
                  setEditedCells((prev) => {
                    if (prev.has(sq)) return prev;
                    const next = new Set(prev);
                    next.add(sq);
                    return next;
                  })
                }
                /* KS-3105: палитра под доской — на desktop modal-ширина
                   500px, board 320×320, справа места нет; на mobile тем
                   более вертикальный layout. Bottom-placement даёт
                   палитре всю ширину и не обрезается. */
                palettePosition="bottom"
                testIdPrefix="board-image-dropzone-editor"
              />
            ) : (
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
            )}
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
          {/* KS-3094: пояснение для crop-режима — без него юзеру не
              сразу понятно, почему вдруг доска не отрисована, а вместо
              неё инструмент обрезки. */}
          {cropMode && (
            <div
              className="board-image-dropzone__crop-hint"
              role="status"
              data-testid="board-image-dropzone-crop-hint"
            >
              {t(
                'boardImage.cropHint',
                'Board not found on the image. Drag and resize the square to fit just the board, then re-recognize.',
              )}
            </div>
          )}
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
        {/* KS-3094: в crop-режиме показываем «Загрузить другое
            изображение» (secondary) и «Обрезать и распознать заново»
            (primary). Apply отключён — позиция ещё не распознана.
            KS-3104: убрана третья кнопка «Cancel crop» — её роль
            покрывает верхний Cancel (закрытие модала) и Reset
            (возврат к dropzone). Три secondary + primary создавали
            визуальный шум, пользователь не понимал куда жать. */}
        {cropMode ? (
          <>
            <button
              type="button"
              className="board-image-dropzone__cancel"
              onClick={handleResetUpload}
              data-testid="board-image-dropzone-crop-reset"
            >
              {t('boardImage.cropReset', 'Load another image')}
            </button>
            <button
              type="button"
              className="board-image-dropzone__apply"
              onClick={handleRecropAndRetry}
              disabled={busy}
              data-testid="board-image-dropzone-crop-retry"
            >
              {t('boardImage.cropRetry', 'Crop and re-recognize')}
            </button>
          </>
        ) : (
          /* KS-3109: Apply показывается ВСЕГДА после recognize.
             Раньше при `usesParentEditor=true` (когда SetPositionModal
             передал onRecognized) кнопка пряталась — ждали что юзер
             переключится на вкладку Board Editor и Apply'нет там. С
             KS-3105 редактор встроен прямо в dropzone, скрывать
             Apply больше нельзя: пользователь поправил позицию руками,
             ждёт кнопку «Применить», а видит только Cancel. Теперь
             кнопка всегда видна, но `disabled` если sanity issues
             или нет распознанного результата. Title-tooltip объясняет
             ПОЧЕМУ disabled (sanity-issue текстом). */
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
