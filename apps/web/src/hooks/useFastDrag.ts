import { useEffect, useRef, useCallback } from 'react';

type DropHandler = (args: {
  sourceSquare: string;
  targetSquare: string | null;
}) => boolean;

interface FastDragOptions {
  onPieceDrop: DropHandler;
  boardOrientation: 'white' | 'black';
  enabled?: boolean;
  onPiecePickup?: (sourceSquare: string) => void;
  onPieceRelease?: () => void;
}

/**
 * Ultra-fast pointer-based drag plugin for chess pieces.
 * Bypasses @dnd-kit overhead by using raw pointer events.
 */
export function useFastDrag(
  containerRef: React.RefObject<HTMLElement | null>,
  options: FastDragOptions,
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const dragStateRef = useRef<{
    sourceSquare: string;
    pieceEl: HTMLElement;
    ghost: HTMLElement;
    squareSize: number;
    boardRect: DOMRect;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  const findSquareFromPoint = useCallback((x: number, y: number): string | null => {
    const state = dragStateRef.current;
    if (!state) return null;

    const { boardRect, squareSize } = state;
    const relX = x - boardRect.left;
    const relY = y - boardRect.top;

    if (relX < 0 || relY < 0 || relX >= boardRect.width || relY >= boardRect.height) {
      return null;
    }

    const col = Math.floor(relX / squareSize);
    const row = Math.floor(relY / squareSize);

    const orientation = optionsRef.current.boardOrientation;
    const file = orientation === 'white'
      ? String.fromCharCode(97 + col)     // a-h
      : String.fromCharCode(97 + 7 - col); // h-a
    const rank = orientation === 'white'
      ? String(8 - row)   // 8-1
      : String(1 + row);  // 1-8

    return file + rank;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onPointerDown = (e: PointerEvent) => {
      if (optionsRef.current.enabled === false) return;
      if (e.button !== 0) return;

      const target = e.target as HTMLElement;
      // Find the piece element (has data-piece attribute)
      const pieceEl = target.closest<HTMLElement>('[data-piece]');
      if (!pieceEl) return;

      // Find the square element (has data-square attribute)
      const squareEl = target.closest<HTMLElement>('[data-square]');
      if (!squareEl) return;

      const sourceSquare = squareEl.getAttribute('data-square');
      if (!sourceSquare) return;

      // Prevent dragging opponent's pieces: data-piece starts with 'w' or 'b'
      const dataPiece = pieceEl.getAttribute('data-piece');
      if (dataPiece) {
        const pieceColor = dataPiece[0] === 'w' ? 'white' : 'black';
        if (pieceColor !== optionsRef.current.boardOrientation) return;
      }

      // Find the board element (the grid container with id ending in '-board')
      const boardEl = container.querySelector<HTMLElement>('div[id$="-board"]');
      if (!boardEl) return;

      const boardRect = boardEl.getBoundingClientRect();
      const squareSize = boardRect.width / 8;

      // Create ghost element
      const ghost = pieceEl.cloneNode(true) as HTMLElement;
      ghost.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        pointer-events: none;
        z-index: 9999;
        width: ${squareSize}px;
        height: ${squareSize}px;
        will-change: transform;
        opacity: 1;
      `;

      // Center ghost on cursor
      const ghostX = e.clientX - squareSize / 2;
      const ghostY = e.clientY - squareSize / 2;
      ghost.style.transform = `translate3d(${ghostX}px, ${ghostY}px, 0)`;

      document.body.appendChild(ghost);

      // Hide original piece
      pieceEl.style.opacity = '0';

      dragStateRef.current = {
        sourceSquare,
        pieceEl,
        ghost,
        squareSize,
        boardRect,
        offsetX: squareSize / 2,
        offsetY: squareSize / 2,
      };

      optionsRef.current.onPiecePickup?.(sourceSquare);

      // Capture pointer on the container (not e.target) for reliable tracking.
      // Using e.target (often a deep SVG child) can lose capture in Chrome
      // when the element is re-rendered or removed by React.
      container.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;

      const x = e.clientX - state.offsetX;
      const y = e.clientY - state.offsetY;
      state.ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const onPointerUp = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;

      // Recalculate boardRect at drop time — the original rect captured on
      // pointerdown may be stale if the page scrolled or layout shifted
      // (e.g. flex-wrap reflow on .game-page).
      const boardEl = container.querySelector<HTMLElement>('div[id$="-board"]');
      const freshBoardRect = boardEl ? boardEl.getBoundingClientRect() : state.boardRect;
      const freshSquareSize = freshBoardRect.width / 8;

      // Update state so findSquareFromPoint uses the fresh rect, not the
      // stale one from pointerdown — prevents wrong square detection when
      // layout shifted during the drag.
      state.boardRect = freshBoardRect;
      state.squareSize = freshSquareSize;

      const targetSquare = findSquareFromPoint(e.clientX, e.clientY);

      dragStateRef.current = null;
      optionsRef.current.onPieceRelease?.();

      // Determine whether this is a valid drop attempt (different square).
      const isDropAttempt = !!(targetSquare && targetSquare !== state.sourceSquare);

      const orientation = optionsRef.current.boardOrientation;

      // For accepted drops: skip snap-transition entirely — call handler
      // immediately, then keep ghost aligned with the actual board position
      // until React has painted.  This avoids the "jerk" caused by layout
      // shift between snap position and post-render board position.
      if (isDropAttempt) {
        let accepted = false;
        try {
          accepted = optionsRef.current.onPieceDrop({
            sourceSquare: state.sourceSquare,
            targetSquare: targetSquare!,
          });
        } catch {
          accepted = false;
        }

        if (accepted) {
          // Snap ghost to the target square instantly (no transition)
          // using the freshest board rect — this covers the board while
          // React re-renders.
          const file = targetSquare!.charCodeAt(0) - 97;
          const rank = parseInt(targetSquare![1], 10);
          const col = orientation === 'white' ? file : 7 - file;
          const row = orientation === 'white' ? 8 - rank : rank - 1;

          state.ghost.style.transition = 'none';
          const snapX = freshBoardRect.left + col * freshSquareSize;
          const snapY = freshBoardRect.top + row * freshSquareSize;
          state.ghost.style.transform = `translate3d(${snapX}px, ${snapY}px, 0)`;
          // Sync ghost size in case board resized since pointerdown
          state.ghost.style.width = `${freshSquareSize}px`;
          state.ghost.style.height = `${freshSquareSize}px`;

          // Wait for React commit + browser paint, realign once more
          // in case layout shifted during re-render, then remove ghost.
          requestAnimationFrame(() => {
            if (boardEl) {
              const postRect = boardEl.getBoundingClientRect();
              const postSq = postRect.width / 8;
              const newSnapX = postRect.left + col * postSq;
              const newSnapY = postRect.top + row * postSq;
              state.ghost.style.transform = `translate3d(${newSnapX}px, ${newSnapY}px, 0)`;
              state.ghost.style.width = `${postSq}px`;
              state.ghost.style.height = `${postSq}px`;
            }
            requestAnimationFrame(() => {
              state.ghost.remove();
            });
          });
          return;
        }

        // Drop was rejected — fall through to snap-back
      }

      // Snap-back animation: smoothly return ghost to source square.
      const snapSquare = state.sourceSquare;

      const file = snapSquare.charCodeAt(0) - 97;
      const rank = parseInt(snapSquare[1], 10);
      const col = orientation === 'white' ? file : 7 - file;
      const row = orientation === 'white' ? 8 - rank : rank - 1;

      const snapX = freshBoardRect.left + col * freshSquareSize;
      const snapY = freshBoardRect.top + row * freshSquareSize;

      state.ghost.style.transition = 'transform 80ms ease-out';
      // Force reflow so the browser registers the current transform before
      // applying the new one — without this, both style changes are batched
      // and the transition never fires (the ghost "teleports" instead).
      void state.ghost.offsetHeight;
      state.ghost.style.transform = `translate3d(${snapX}px, ${snapY}px, 0)`;

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;

        state.ghost.remove();
        // Restore opacity on the original piece element
        state.pieceEl.style.opacity = '';
        // Fallback: if React re-rendered and replaced the DOM element,
        // find the piece at the source square and restore its opacity too
        const ctr = containerRef.current;
        if (ctr) {
          const sqEl = ctr.querySelector<HTMLElement>(`[data-square="${state.sourceSquare}"] [data-piece]`);
          if (sqEl && sqEl !== state.pieceEl) {
            sqEl.style.opacity = '';
          }
        }
      };

      state.ghost.addEventListener('transitionend', cleanup, { once: true });
      // Fallback in case transitionend doesn't fire
      setTimeout(cleanup, 120);
    };

    const onPointerCancel = () => {
      const state = dragStateRef.current;
      if (!state) return;

      state.pieceEl.style.opacity = '';
      state.ghost.remove();
      dragStateRef.current = null;
      optionsRef.current.onPieceRelease?.();
    };

    // Prevent Chrome's native HTML5 drag on images/SVGs inside pieces.
    // Without this, Chrome can hijack the pointer sequence, causing
    // pointerup to never fire and leaving the piece invisible.
    const onDragStart = (e: Event) => {
      if (dragStateRef.current) {
        e.preventDefault();
      }
    };

    // Safety net: if pointer capture is lost unexpectedly (e.g. due to
    // DOM mutations from React re-renders), restore piece visibility.
    // IMPORTANT: only react when the container itself loses capture,
    // not when a child loses implicit capture (which bubbles up).
    // When we call container.setPointerCapture(), the browser releases
    // implicit capture from e.target (the piece/SVG child), firing
    // lostpointercapture on it. That event bubbles to the container
    // and would incorrectly tear down the drag if we don't filter it.
    const onLostPointerCapture = (e: PointerEvent) => {
      if (e.target !== container) return;

      const state = dragStateRef.current;
      if (!state) return;

      state.pieceEl.style.opacity = '';
      state.ghost.remove();
      dragStateRef.current = null;
    };

    container.addEventListener('pointerdown', onPointerDown, { passive: false });
    container.addEventListener('dragstart', onDragStart);
    container.addEventListener('lostpointercapture', onLostPointerCapture);
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('dragstart', onDragStart);
      container.removeEventListener('lostpointercapture', onLostPointerCapture);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);

      // Cleanup any active drag
      const state = dragStateRef.current;
      if (state) {
        state.pieceEl.style.opacity = '';
        state.ghost.remove();
        dragStateRef.current = null;
      }
    };
  }, [containerRef, findSquareFromPoint, options.enabled]);
}
