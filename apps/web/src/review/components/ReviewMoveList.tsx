import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChessMove } from '../types';
import { nagToSymbol } from '../utils/nagUtils';
// KS-2266 (ADR-037 §1, §6): категории NAG и `setNagInCategory` —
// заменяет наивный toggle (push в массив) на replace-within-group.
import { groupNagsByCategory } from '../../utils/nagCategories';
// KS-2283 (ADR-037 §3, E2-integration): NAG-палитра вместо старой
// 6-кнопочной NAG-row в context-menu. Десктоп — popup, мобайл — sheet.
import { NagPalette } from './NagPalette';
import { NagPaletteSheet } from './NagPaletteSheet';
// KS-2278 (ADR-037 §3.4, E4): детект устройства для выбора popup/sheet.
import { useIsMobile } from '../../hooks/useIsMobile';
// KS-2291 (ADR-038 §13): variation-color секция в палитре — нужен
// findVariationRoot для определения isVariation и currentVariationColor.
import { findVariationRoot, searchInHistory } from '../utils/ChessHistoryUtils';
import type { VariationColor } from '../types';
// KS-4953 (ADR-165 rev4 §7.4): парсинг [%exit …] и счётчик недостроенных.
import {
  parseExitTag,
  countUnfinishedBranches,
  type ExitKind,
} from '../utils/exitTag';
import {
  processMoveHierarchy,
  getMoveClasses,
  getBracketClasses,
  isProcessedMove,
  isBracketItem,
  ProcessedMove,
} from '../utils/ChessMoveProcessing';
import './ReviewMoveList.css';

export interface GameInfo {
  white: { username: string; rating?: number | null };
  black: { username: string; rating?: number | null };
  opening?: string;
  result?: string;
  event?: string;
  date?: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  move: ChessMove | null;
  /**
   * KS-2283: режим открытия. `desktop` — popup рядом с курсором (правый
   * клик), `mobile` — bottom-sheet (`<NagPaletteSheet>`, long-press).
   */
  mode: 'desktop' | 'mobile';
  /**
   * KS-2295 (ADR-038 §13.11): начальный focus палитры. `'nag'` —
   * стандарт (1..9 на NAG). `'variationColor'` — открыто через hotkey
   * `V`, 1..4 сразу мап на цвета.
   */
  initialFocus: 'nag' | 'variationColor';
}

// KS-2283: NAG_BUTTONS удалены — старая 6-кнопочная NAG-row в context-menu
// заменена на полноценную палитру `<NagPalette>` (14 NAG + delete) с
// категорийной дедупликацией (KS-2266 / setNagInCategory).

interface ReviewMoveListProps {
  history: ChessMove[];
  currentGlobalIndex: number;
  onMoveClick: (move: ChessMove) => void;
  /**
   * KS-2005: edit-колбэки `onPromoteVariation/onDeleteVariation/`
   * `onTruncateRemaining/onSetNag/onSetComment` стали опциональными.
   * Если ни один не передан или установлен `readOnly`, контекстное меню
   * не открывается (right-click и long-press игнорируются), а уже
   * сохранённые в PGN комментарии и NAG-символы рендерятся как обычно.
   * Это позволяет переиспользовать компонент в read-only сценариях
   * (`InlinePgnViewer` для шага «разбор партии» в уроке) без копий.
   */
  onPromoteVariation?: (move: ChessMove) => void;
  onDeleteVariation?: (move: ChessMove) => void;
  onTruncateRemaining?: (move: ChessMove) => void;
  onSetNag?: (globalIndex: number, nags: number[]) => void;
  onSetComment?: (globalIndex: number, comment: string) => void;
  /**
   * KS-2291 (ADR-038 §13, VC E3): задать/снять цвет вариации.
   * `moveIndex` — globalIndex любого хода ВНУТРИ вариации (palette
   * сама не знает root); reducer (`setVariationColor` из
   * useReviewState, KS-2287) находит root через findVariationRoot.
   * Если не передан — секция «Variation color» в палитре скрыта.
   */
  onSetVariationColor?: (moveIndex: number, color: VariationColor | null) => void;
  /**
   * Полностью отключить интерактивное редактирование (контекстное меню,
   * редактор комментария по long-press). Клик по ходу через `onMoveClick`
   * остаётся — навигация по партии нужна и в read-only режиме.
   */
  readOnly?: boolean;
  /**
   * KS-2872 (FM3) — режим conceal: ходы с `ply > concealAfterPly`
   * рендерятся как `???` (SAN скрыт). Клик по такому ходу всё ещё
   * вызывает navigation, но текст не раскрывает позицию.
   * `null`/`undefined` — обычный режим без сокрытия.
   */
  concealAfterPly?: number | null;
  /**
   * KS-3258 follow-up: кастомный fallback для пустой истории. Если не
   * передан — рисуется обычный `<div class="review-no-moves">No moves</div>`.
   * Используется в AnalysisPage / Broadcast / Archive для отображения
   * `<ForfeitPlaceholder>` вместо «No moves» на forfeit-партиях.
   */
  emptyState?: React.ReactNode;
  /**
   * KS-4641 / ADR-143 §7.3. Опциональный рендерер бейджа рядом с
   * SAN'ом хода. Используется в replay-режиме для метки `× N` —
   * количества упоминаний этого хода тренером (если N > 1). Если не
   * передан — бейдж не рендерится. Вызывается на каждый main-line/
   * variation узел; возвращает `null` чтобы не рендерить ничего.
   */
  getMoveBadge?: (move: ChessMove) => React.ReactNode | null;
}

export function ReviewMoveList({
  history,
  currentGlobalIndex,
  onMoveClick,
  onPromoteVariation,
  onDeleteVariation,
  onTruncateRemaining,
  onSetNag,
  onSetComment,
  onSetVariationColor,
  readOnly = false,
  concealAfterPly = null,
  emptyState,
  getMoveBadge,
}: ReviewMoveListProps) {
  const editable = !readOnly && Boolean(
    onPromoteVariation ||
      onDeleteVariation ||
      onTruncateRemaining ||
      onSetNag ||
      onSetComment ||
      onSetVariationColor,
  );
  const { t } = useTranslation();
  // KS-4953: локализованная подпись причины завершения ветки.
  const exitLabel = useCallback(
    (kind: ExitKind): string => {
      switch (kind) {
        case 'theory':
          return t('review.exit.theory', 'Теория');
        case 'refuted':
          return t('review.exit.refuted', 'Наказано');
        case 'transposition':
          return t('review.exit.transposition', 'Перестановка');
        case 'forced':
          return t('review.exit.forced', 'Вынужденно');
        case 'depth':
          return t('review.exit.depth', 'Конец репертуара');
        case 'rare':
          return t('review.exit.rare', 'Редкая линия');
        case 'budget':
        case 'limit':
          return t('review.exit.limit', 'Не достроено');
        default:
          return '';
      }
    },
    [t],
  );
  // KS-4953: сколько веток осталось недостроено по предохранителю (limit).
  const unfinishedCount = countUnfinishedBranches(history);
  // KS-2278: режим popup'а определяется устройством (touch + viewport),
  // а не триггером. На desktop (мышь + широкий viewport) даже long-press
  // на гибридном ноутбуке открывает popup. На mobile (touch + узкий
  // viewport) даже PointerEvent right-click из stylus'а открывает sheet.
  const isMobile = useIsMobile();
  const movesContainerRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  // Timestamp until which synthetic click/touch events should be ignored after long press
  const ignoreCloseUntilRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    move: null,
    mode: 'desktop',
    initialFocus: 'nag',
  });
  const [commentEditIndex, setCommentEditIndex] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');
  // KS-4974: SAN редактируемого хода для заголовка мобильного оверлея.
  const [commentMoveLabel, setCommentMoveLabel] = useState('');
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [expandedComments, setExpandedComments] = useState<Set<number>>(new Set());
  // KS-4974: высота экранной клавиатуры (visualViewport). На мобильном
  // редактор комментария рендерится как fixed-оверлей над клавиатурой —
  // инлайн-поле в height-locked панели «Ходов» уезжает под клавиатуру и
  // ничем не доскроллить. Отслеживаем инсет, пока открыт редактор.
  const [keyboardInset, setKeyboardInset] = useState(0);

  useEffect(() => {
    const container = movesContainerRef.current;
    if (!container) return;
    const active = container.querySelector('.move-item.current') as HTMLElement | null;
    if (active) {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      // No active move (e.g. initial position after "go to start") —
      // scroll the notation container to the top.
      container.scrollTop = 0;
    }
  }, [currentGlobalIndex]);

  // Autofocus comment textarea
  useEffect(() => {
    if (commentEditIndex !== null && commentTextareaRef.current) {
      commentTextareaRef.current.focus();
    }
  }, [commentEditIndex]);

  // KS-4974: пока редактор комментария открыт на мобильном — держим
  // fixed-оверлей над клавиатурой, отслеживая visualViewport. Инсет =
  // сколько снизу «съедено» клавиатурой относительно layout-вьюпорта.
  useEffect(() => {
    if (!isMobile || commentEditIndex === null) {
      setKeyboardInset(0);
      return;
    }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardInset(inset);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [isMobile, commentEditIndex]);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false, move: null }));
  }, []);

  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleClose = () => {
      // Ignore synthetic click/touch events fired shortly after long press
      if (Date.now() < ignoreCloseUntilRef.current) return;
      closeContextMenu();
    };
    document.addEventListener('click', handleClose);
    document.addEventListener('touchstart', handleClose);
    document.addEventListener('contextmenu', handleClose);
    return () => {
      document.removeEventListener('click', handleClose);
      document.removeEventListener('touchstart', handleClose);
      document.removeEventListener('contextmenu', handleClose);
    };
  }, [contextMenu.visible, closeContextMenu]);

  const showContextMenu = useCallback(
    (
      coords: { clientX: number; clientY: number },
      move: ChessMove,
      mode: 'desktop' | 'mobile' = 'desktop',
      // KS-2295: hotkey `V` открывает палитру с focus='variationColor'.
      initialFocus: 'nag' | 'variationColor' = 'nag',
    ) => {
      // KS-2283: clamp X в viewport, чтобы desktop popup (NagPalette)
      // не уехал за правый край при клике у границы. Высота уходит вверх
      // через CSS `transform: translateY(-100%)` (как было).
      const POPUP_WIDTH_HINT = 320;
      const safeX = Math.min(
        coords.clientX,
        Math.max(0, window.innerWidth - POPUP_WIDTH_HINT),
      );
      setContextMenu({
        visible: true,
        x: safeX,
        y: coords.clientY,
        move,
        mode,
        initialFocus,
      });
    },
    [],
  );

  const handleMoveClick = (processedMove: ProcessedMove): void => {
    if (processedMove.originalMove) {
      onMoveClick(processedMove.originalMove);
    }
  };

  const handleMoveContextMenu = (e: React.MouseEvent, processedMove: ProcessedMove): void => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    if (processedMove.originalMove) {
      // KS-2278: режим зависит от устройства, а не от триггера. На
      // mobile-touch-screen с подключенной мышкой right-click тоже
      // должен открыть sheet (mobile UX primary).
      showContextMenu(e, processedMove.originalMove, isMobile ? 'mobile' : 'desktop');
    }
  };

  const handleTouchStart = (e: React.TouchEvent, processedMove: ProcessedMove): void => {
    if (!editable) return;
    if (!processedMove.originalMove) return;
    const touch = e.touches[0];
    const move = processedMove.originalMove;
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      longPressTimerRef.current = null;
      // Ignore any synthetic click/touchstart events for 700ms after showing the menu
      ignoreCloseUntilRef.current = Date.now() + 700;
      // KS-2278: long-press на гибридном desktop-ноуте (touch-screen
      // + широкий viewport) открывает popup, а не sheet. На mobile
      // (touch + узкий viewport) — sheet.
      showContextMenu(
        { clientX: touch.clientX, clientY: touch.clientY },
        move,
        isMobile ? 'mobile' : 'desktop',
      );
    }, 500);
  };

  const handleTouchEnd = (): void => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressFiredRef.current = false;
  };

  const handleTouchMove = (): void => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressFiredRef.current = false;
  };

  // KS-2266 / KS-2283: NagPalette внутри сама вызывает setNagInCategory.
  // Здесь только мостик `onChange` → `onSetNag(idx, nextNags)`.
  const handlePaletteChange = useCallback(
    (nextNags: number[]) => {
      if (!contextMenu.move || !onSetNag) return;
      onSetNag(contextMenu.move.globalIndex, nextNags);
    },
    [contextMenu.move, onSetNag],
  );

  // KS-2291: вычисления для секции «Variation color» в палитре.
  // `isVariation` — true если контекстный move лежит ВНУТРИ вариации
  // (`findVariationRoot` вернул не-null). `currentVariationColor` —
  // цвет с root'а. `handlePaletteVariationColor` — мостик в host'овский
  // `onSetVariationColor` (KS-2287, useReviewState.setVariationColor).
  const variationRoot =
    contextMenu.move
      ? (findVariationRoot(history, contextMenu.move) as ChessMove | null)
      : null;
  const isVariationContext = variationRoot !== null;
  const currentVariationColor = variationRoot?.variationColor;
  const handlePaletteVariationColor = useCallback(
    (color: VariationColor | null) => {
      if (!contextMenu.move || !onSetVariationColor) return;
      onSetVariationColor(contextMenu.move.globalIndex, color);
    },
    [contextMenu.move, onSetVariationColor],
  );

  // KS-2282 / KS-2295: hotkey `A` (annotate, NAG focus) и `V`
  // (variation color, VC focus) открывают палитру для текущего хода
  // (currentGlobalIndex). `V` имеет смысл только когда хост передал
  // onSetVariationColor — иначе работает как `A`.
  // Координаты — центр текущего хода в DOM (fallback: центр контейнера
  // / окна). Игнорируется при focus в input/textarea/contenteditable
  // и при modifier'ах (Cmd/Ctrl/Alt).
  useEffect(() => {
    if (!editable) return;
    if (!onSetNag && !onSetVariationColor) return;
    const handleHotkey = (e: KeyboardEvent) => {
      // Modifier'ы — оставляем браузеру / системе.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      let openInitialFocus: 'nag' | 'variationColor' | null = null;
      if ((e.key === 'a' || e.key === 'A') && onSetNag) {
        openInitialFocus = 'nag';
      } else if ((e.key === 'v' || e.key === 'V') && onSetVariationColor) {
        // KS-2295: V → focus сразу на variation-color (если будет
        // доступна — определяется в палитре по isVariation).
        openInitialFocus = 'variationColor';
      }
      if (openInitialFocus === null) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      // Уже открыт popup/sheet — Esc там работает; игнорируем повторный hotkey.
      if (contextMenu.visible) return;
      // KS-2295: рекурсивный поиск по globalIndex — иначе ход внутри
      // варианта не находится (history.find смотрит только в main-line).
      const currentMove = searchInHistory(
        history,
        currentGlobalIndex,
      ) as ChessMove | null;
      if (!currentMove) return;
      e.preventDefault();
      const container = movesContainerRef.current;
      const activeEl = container?.querySelector(
        '.move-item.current',
      ) as HTMLElement | null;
      const rect = (activeEl ?? container)?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect
        ? rect.top + rect.height / 2
        : window.innerHeight / 2;
      showContextMenu(
        { clientX: cx, clientY: cy },
        currentMove,
        // mode пусть решит device-detection через ту же логику, что
        // и handleMoveContextMenu (KS-2278). Передаём undefined →
        // showContextMenu возьмёт дефолт 'desktop' (popup), что
        // корректно для hotkey-открытия — пользователь за клавиатурой.
        undefined,
        openInitialFocus,
      );
    };
    window.addEventListener('keydown', handleHotkey);
    return () => window.removeEventListener('keydown', handleHotkey);
  }, [
    editable,
    onSetNag,
    onSetVariationColor,
    history,
    currentGlobalIndex,
    contextMenu.visible,
    showContextMenu,
  ]);

  // Esc → close. Listener на window только когда меню открыто.
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeContextMenu();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [contextMenu.visible, closeContextMenu]);

  const openCommentEditor = (move: ChessMove) => {
    setCommentEditIndex(move.globalIndex);
    setCommentText(move.comment ?? '');
    setCommentMoveLabel(move.san ?? '');
    closeContextMenu();
  };

  const saveComment = () => {
    if (commentEditIndex === null || !onSetComment) return;
    onSetComment(commentEditIndex, commentText);
    setCommentEditIndex(null);
    setCommentText('');
  };

  const cancelComment = () => {
    setCommentEditIndex(null);
    setCommentText('');
  };

  const deleteComment = () => {
    if (commentEditIndex === null || !onSetComment) return;
    onSetComment(commentEditIndex, '');
    setCommentEditIndex(null);
    setCommentText('');
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      saveComment();
    }
    if (e.key === 'Escape') {
      setCommentEditIndex(null);
      setCommentText('');
    }
  };

  const toggleCommentExpand = (globalIndex: number) => {
    setExpandedComments((prev) => {
      const next = new Set(prev);
      if (next.has(globalIndex)) {
        next.delete(globalIndex);
      } else {
        next.add(globalIndex);
      }
      return next;
    });
  };

  /**
   * KS-2266 (ADR-037 §6): рендер NAG-символов inline с ходом —
   * **по одному NAG из каждой категории**. Раньше рендерились все
   * подряд (`!! !?` и т.п.), при наличии legacy-данных с дублями.
   * Теперь groupNagsByCategory отдаёт по одному (последнему)
   * представителю категории, и пользователь видит только актуальный.
   */
  const renderNagSymbols = (move: ChessMove) => {
    if (!move.nags || move.nags.length === 0) return null;
    const grouped = groupNagsByCategory(move.nags);
    const items: React.ReactNode[] = [];
    const qualityNag = grouped.quality;
    if (qualityNag !== undefined) {
      let className = 'review-nag';
      if (qualityNag === 1 || qualityNag === 3) className += ' review-nag--good';
      else if (qualityNag === 2 || qualityNag === 4) className += ' review-nag--bad';
      else if (qualityNag === 5 || qualityNag === 6) className += ' review-nag--interesting';
      items.push(
        <span key={`nag-quality-${qualityNag}`} className={className}>
          {nagToSymbol(qualityNag)}
        </span>,
      );
    }
    const evalNag = grouped.positionEval;
    if (evalNag !== undefined) {
      items.push(
        <span key={`nag-eval-${evalNag}`} className="review-nag review-nag--eval">
          {nagToSymbol(evalNag)}
        </span>,
      );
    }
    return items.length > 0 ? items : null;
  };

  /** Render eval and clock inline after a move */
  const renderEvalClock = (move: ChessMove) => {
    const parts: React.ReactNode[] = [];
    if (move.eval !== undefined) {
      const val = move.eval;
      let className = 'review-eval';
      if (val > 0.3) className += ' review-eval--white';
      else if (val < -0.3) className += ' review-eval--black';
      const display = val >= 100 ? '#' : val <= -100 ? '#' : (val > 0 ? '+' : '') + val.toFixed(1);
      parts.push(
        <span key={`eval-${move.globalIndex}`} className={className} title={`eval: ${val}`}>
          {display}
        </span>,
      );
    }
    if (move.clock) {
      parts.push(
        <span key={`clk-${move.globalIndex}`} className="review-clock" title={`clock: ${move.clock}`}>
          🕐{move.clock}
        </span>,
      );
    }
    return parts.length > 0 ? parts : null;
  };

  /** Render comment block after a move */
  const renderComment = (move: ChessMove) => {
    // KS-4974: на мобильном инлайн-редактор не рендерим — вместо него
    // fixed-оверлей над клавиатурой (см. renderMobileCommentEditor).
    // Показываем текущий текст комментария (read-only ветка ниже).
    if (commentEditIndex === move.globalIndex && !isMobile) {
      return (
        <span
          key={`comment-edit-${move.globalIndex}`}
          className="review-comment-editor"
          onClick={(e) => e.stopPropagation()}
        >
          <textarea
            ref={commentTextareaRef}
            className="review-comment-textarea"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onBlur={saveComment}
            onKeyDown={handleCommentKeyDown}
            rows={2}
          />
          <button
            className="review-comment-delete-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              deleteComment();
            }}
            title={t('review.deleteComment', 'Delete comment')}
          >
            ✕
          </button>
        </span>
      );
    }

    if (!move.comment) return null;

    const isExpanded = expandedComments.has(move.globalIndex);
    // KS-4953: причина завершения ветки [%exit …] → цветной бейдж, остальной
    // текст комментария рядом. Без тега — обычный комментарий.
    const { kind, text } = parseExitTag(move.comment);
    return (
      <span
        key={`comment-${move.globalIndex}`}
        className={`review-comment${isExpanded ? ' review-comment--expanded' : ''}`}
        data-testid={`review-comment-${move.globalIndex}`}
        onClick={() => toggleCommentExpand(move.globalIndex)}
      >
        {kind && (
          <span
            className={`review-exit review-exit--${kind}`}
            data-testid={`review-exit-${move.globalIndex}`}
            data-exit-kind={kind}
          >
            {exitLabel(kind)}
          </span>
        )}
        {text ? (kind ? ` ${text}` : text) : ''}
      </span>
    );
  };

  const renderMovesList = () => {
    if (!history || !Array.isArray(history) || history.length === 0) {
      return [];
    }

    const processedItems = processMoveHierarchy(history, currentGlobalIndex);

    return processedItems.flatMap((item, index) => {
      if (isProcessedMove(item)) {
        const move = item.originalMove;
        // KS-2872 (FM3): conceal-режим — для ходов с ply > concealAfterPly
        // SAN скрывается (показываем `???`); nags/comments/eval тоже
        // не показываем чтобы не раскрыть позицию через побочные данные.
        const isConcealed =
          concealAfterPly != null &&
          move != null &&
          typeof move.ply === 'number' &&
          move.ply > concealAfterPly;
        const elements = [
          <span
            key={`move-${item.globalIndex}-${index}`}
            className={
              getMoveClasses(item) + (isConcealed ? ' review-move--concealed' : '')
            }
            data-testid={`review-move-${item.globalIndex}`}
            data-current={item.isCurrent ? 'true' : 'false'}
            data-concealed={isConcealed ? 'true' : undefined}
            onClick={() => handleMoveClick(item)}
            onContextMenu={(e) => handleMoveContextMenu(e, item)}
            onTouchStart={(e) => handleTouchStart(e, item)}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchMove}
          >
            {isConcealed ? '???' : item.display}
            {!isConcealed && move && renderNagSymbols(move)}
            {!isConcealed && move && renderEvalClock(move)}
            {/* KS-4641 / ADR-143 §7.3. Бейдж количества упоминаний
                хода тренером (× N) для replay-режима. Стилизуется
                через className в слое layout (`apps/web/src/styles/...`),
                JSX без inline-style. */}
            {!isConcealed && move && getMoveBadge && getMoveBadge(move)}
          </span>,
          ' ',
        ];

        // Render comment block (or editor) after the move
        if (move && !isConcealed) {
          const commentEl = renderComment(move);
          if (commentEl) {
            elements.push(commentEl, ' ');
          }
        }

        return elements;
      } else if (isBracketItem(item)) {
        return [
          <span
            key={`bracket-${item.bracketType}-${item.parentMoveIndex}-${item.variationIndex}-${index}`}
            className={getBracketClasses(item)}
          >
            {item.bracketType === 'open' ? '(' : ')'}
          </span>,
          ' ',
        ];
      }
      return [];
    });
  };

  return (
    <div className="review-move-list-wrapper">
      <div ref={movesContainerRef} className="review-moves-container">
        {!history || history.length === 0 ? (
          // KS-3258 follow-up: если callsite передал кастомный emptyState
          // (например <ForfeitPlaceholder> для партий с [Termination
          // "Unplayed"]) — рендерим его. Иначе fallback на «No moves».
          (emptyState ?? <div className="review-no-moves">No moves</div>)
        ) : (
          <div className="review-moves-list">{renderMovesList()}</div>
        )}
      </div>
      {/* KS-4953: индикатор недостроенных по предохранителю веток (limit). */}
      {unfinishedCount > 0 && (
        <div
          className="review-unfinished"
          data-testid="review-unfinished"
          data-count={unfinishedCount}
        >
          {t('review.exit.unfinished', '{{count}} веток не достроено (лимит)', {
            count: unfinishedCount,
          })}
        </div>
      )}

      {contextMenu.visible && contextMenu.move && (() => {
        // KS-2283: общий блок actions (comment / promote / truncate / delete)
        // используется и в desktop popup, и в mobile sheet (через extraActions).
        const moveForActions = contextMenu.move;
        const actions = (
          <>
            {onSetComment && (
              <>
                <button
                  type="button"
                  className="review-context-menu__item"
                  onClick={() => openCommentEditor(moveForActions)}
                >
                  {moveForActions.comment
                    ? t('review.editComment', '✎ Edit comment')
                    : t('review.addComment', '+ Add comment')}
                </button>
                <div className="review-context-menu__divider" />
              </>
            )}
            {onPromoteVariation && (
              <button
                type="button"
                className="review-context-menu__item"
                onClick={() => {
                  onPromoteVariation(moveForActions);
                  closeContextMenu();
                }}
              >
                ↑ {t('review.promote', 'Promote')}
              </button>
            )}
            {onTruncateRemaining && (
              <button
                type="button"
                className="review-context-menu__item"
                onClick={() => {
                  onTruncateRemaining(moveForActions);
                  closeContextMenu();
                }}
              >
                ] {t('review.truncate', 'Truncate')}
              </button>
            )}
            {onDeleteVariation && (
              <button
                type="button"
                className="review-context-menu__item review-context-menu__item--danger"
                onClick={() => {
                  onDeleteVariation(moveForActions);
                  closeContextMenu();
                }}
              >
                ✕ {t('review.delete', 'Delete')}
              </button>
            )}
          </>
        );

        // KS-2283: mobile (long-press) → bottom-sheet с NagPalette + actions.
        // KS-2297: рендерим Sheet с NagPalette ТОЛЬКО если хост передал
        // onSetNag — иначе клики по NAG-кнопкам потеряются (handler
        // молча no-op'нет, см. handlePaletteChange guard). Регрессия из
        // KS-2278 (mobile-mode переключение): AnalysisPage (mobile)
        // не передавал onSetNag, sheet открывался, но NAG в нотации
        // не появлялся. Если onSetNag нет, но есть actions — рендерим
        // простой context-menu (как desktop без NagPalette).
        if (contextMenu.mode === 'mobile') {
          if (onSetNag) {
            return (
              <NagPaletteSheet
                open
                nags={moveForActions.nags ?? []}
                onChange={handlePaletteChange}
                onClose={closeContextMenu}
                extraActions={actions}
                // KS-2291: variation-color секция (видна только в варианте).
                isVariation={isVariationContext}
                currentVariationColor={currentVariationColor}
                onSetVariationColor={
                  onSetVariationColor ? handlePaletteVariationColor : undefined
                }
                // KS-2295: hotkey V открывает с focus='variationColor'.
                initialFocus={contextMenu.initialFocus}
              />
            );
          }
          // Mobile без onSetNag — fallback на тот же popup, что desktop,
          // но позиционируется по тем же координатам long-press (CSS
          // layout сам решит «выглядеть как sheet или нет»).
          return (
            <div
              className="review-context-menu"
              style={{ top: contextMenu.y, left: contextMenu.x, transform: 'translateY(-100%)' }}
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            >
              {actions}
            </div>
          );
        }

        // Desktop (right-click) → popup рядом с курсором. NagPalette сверху,
        // actions снизу (если они есть).
        return (
          <div
            className="review-context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x, transform: 'translateY(-100%)' }}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            {onSetNag && (
              <>
                <NagPalette
                  nags={moveForActions.nags ?? []}
                  onChange={handlePaletteChange}
                  onClose={closeContextMenu}
                  // KS-2291: variation-color секция (видна только в варианте).
                  isVariation={isVariationContext}
                  currentVariationColor={currentVariationColor}
                  onSetVariationColor={
                    onSetVariationColor ? handlePaletteVariationColor : undefined
                  }
                  // KS-2295: hotkey V открывает с focus='variationColor'.
                  initialFocus={contextMenu.initialFocus}
                />
                <div className="review-context-menu__divider" />
              </>
            )}
            {actions}
          </div>
        );
      })()}

      {/* KS-4974: мобильный редактор комментария — fixed-оверлей,
          прижатый к низу видимой области над экранной клавиатурой
          (bottom = высота клавиатуры из visualViewport). Поле и каретка
          всегда видны, шрифт 16px (без zoom-on-focus в iOS Safari). */}
      {isMobile &&
        commentEditIndex !== null &&
        onSetComment &&
        createPortal(
          <div
            className="review-comment-editor-mobile"
            style={{ bottom: keyboardInset }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="review-comment-editor-mobile__header">
              <span className="review-comment-editor-mobile__title">
                {commentMoveLabel
                  ? t('review.commentForMove', 'Комментарий · {{move}}', {
                      move: commentMoveLabel,
                    })
                  : t('review.comment', 'Комментарий')}
              </span>
              <button
                type="button"
                className="review-comment-editor-mobile__close"
                onMouseDown={(e) => e.preventDefault()}
                onClick={cancelComment}
                aria-label={t('common.cancel', 'Отмена')}
              >
                ✕
              </button>
            </div>
            <textarea
              ref={commentTextareaRef}
              className="review-comment-textarea review-comment-textarea--mobile"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              rows={3}
              placeholder={t('review.commentPlaceholder', 'Комментарий к ходу…')}
            />
            <div className="review-comment-editor-mobile__actions">
              <button
                type="button"
                className="review-comment-editor-mobile__btn review-comment-editor-mobile__btn--delete"
                onMouseDown={(e) => e.preventDefault()}
                onClick={deleteComment}
              >
                {t('review.deleteComment', 'Удалить')}
              </button>
              <button
                type="button"
                className="review-comment-editor-mobile__btn review-comment-editor-mobile__btn--save"
                onMouseDown={(e) => e.preventDefault()}
                onClick={saveComment}
              >
                {t('common.save', 'Сохранить')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
