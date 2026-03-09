import { useEffect, useRef, useCallback } from 'react';

type DropHandler = (args: {
  sourceSquare: string;
  targetSquare: string | null;
}) => boolean;

interface FastDragOptions {
  onPieceDrop: DropHandler;
  boardOrientation: 'white' | 'black';
  enabled?: boolean;
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

      // Find the board element (the grid container with id ending in '-board')
      const boardEl = container.querySelector<HTMLElement>('div[id$="-board"]');
      if (!boardEl) return;

      const boardRect = boardEl.getBoundingClientRect();
      const squareSize = boardRect.width / 8;

      // Create ghost element
      const ghost = pieceEl.cloneNode(true) as HTMLElement;
      ghost.style.cssText = `
        position: fixed;
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

      // Capture pointer for smooth tracking
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
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

      const targetSquare = findSquareFromPoint(e.clientX, e.clientY);

      // Restore original piece visibility
      state.pieceEl.style.opacity = '';

      // Remove ghost
      state.ghost.remove();

      dragStateRef.current = null;

      // Call handler
      if (targetSquare && targetSquare !== state.sourceSquare) {
        optionsRef.current.onPieceDrop({
          sourceSquare: state.sourceSquare,
          targetSquare,
        });
      }
    };

    const onPointerCancel = () => {
      const state = dragStateRef.current;
      if (!state) return;

      state.pieceEl.style.opacity = '';
      state.ghost.remove();
      dragStateRef.current = null;
    };

    container.addEventListener('pointerdown', onPointerDown, { passive: false });
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
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
