import { useEffect, useRef, useState, useCallback } from 'react';
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
   * Полностью отключить интерактивное редактирование (контекстное меню,
   * редактор комментария по long-press). Клик по ходу через `onMoveClick`
   * остаётся — навигация по партии нужна и в read-only режиме.
   */
  readOnly?: boolean;
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
  readOnly = false,
}: ReviewMoveListProps) {
  const editable = !readOnly && Boolean(
    onPromoteVariation ||
      onDeleteVariation ||
      onTruncateRemaining ||
      onSetNag ||
      onSetComment,
  );
  const { t } = useTranslation();
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
  });
  const [commentEditIndex, setCommentEditIndex] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [expandedComments, setExpandedComments] = useState<Set<number>>(new Set());

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
    closeContextMenu();
  };

  const saveComment = () => {
    if (commentEditIndex === null || !onSetComment) return;
    onSetComment(commentEditIndex, commentText);
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
    if (commentEditIndex === move.globalIndex) {
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
    return (
      <span
        key={`comment-${move.globalIndex}`}
        className={`review-comment${isExpanded ? ' review-comment--expanded' : ''}`}
        data-testid={`review-comment-${move.globalIndex}`}
        onClick={() => toggleCommentExpand(move.globalIndex)}
      >
        {move.comment}
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
        const elements = [
          <span
            key={`move-${item.globalIndex}-${index}`}
            className={getMoveClasses(item)}
            data-testid={`review-move-${item.globalIndex}`}
            data-current={item.isCurrent ? 'true' : 'false'}
            onClick={() => handleMoveClick(item)}
            onContextMenu={(e) => handleMoveContextMenu(e, item)}
            onTouchStart={(e) => handleTouchStart(e, item)}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchMove}
          >
            {item.display}
            {move && renderNagSymbols(move)}
            {move && renderEvalClock(move)}
          </span>,
          ' ',
        ];

        // Render comment block (or editor) after the move
        if (move) {
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
          <div className="review-no-moves">No moves</div>
        ) : (
          <div className="review-moves-list">{renderMovesList()}</div>
        )}
      </div>

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
        if (contextMenu.mode === 'mobile') {
          return (
            <NagPaletteSheet
              open
              nags={moveForActions.nags ?? []}
              onChange={handlePaletteChange}
              onClose={closeContextMenu}
              extraActions={actions}
            />
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
                />
                <div className="review-context-menu__divider" />
              </>
            )}
            {actions}
          </div>
        );
      })()}
    </div>
  );
}
