import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFastDrag } from './useFastDrag';

/**
 * KS-273: Unit tests for useFastDrag enabled-state behavior.
 *
 * Verifies the KS-270 regression fix:
 * - enabled check is performed at pointerdown time (not setup time)
 * - options.enabled in useEffect deps causes re-setup on change
 *
 * NOTE: the hook postpones ghost creation until the pointer has moved past
 * `DRAG_THRESHOLD` (4px) — a plain `pointerdown` is treated as a potential
 * click so that `onPieceClick` can still fire (KS-???). A test that wants to
 * trigger the drag path must follow up with a `pointermove` beyond the
 * threshold; see `simulateDragStart` below.
 */

const DRAG_THRESHOLD = 4;

/**
 * Fire a pointerdown on the piece followed by a pointermove that crosses the
 * drag threshold, so `useFastDrag` promotes the gesture to an active drag and
 * creates the ghost element.
 */
function simulateDragStart(piece: Element, startX: number, startY: number): void {
  piece.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: startX,
      clientY: startY,
      bubbles: true,
      button: 0,
      cancelable: true,
    }),
  );
  // Move far enough past the threshold (10px is well over 4).
  document.dispatchEvent(
    new PointerEvent('pointermove', {
      clientX: startX + DRAG_THRESHOLD + 10,
      clientY: startY,
      bubbles: true,
    }),
  );
}

/**
 * Stub `setPointerCapture` / `releasePointerCapture` on the container. happy-dom
 * supports them, but we never wire a real PointerEvent path-through, so without
 * a stub the hook's `container.setPointerCapture(pointerId)` call throws and
 * tears down the whole drag start.
 */
function stubPointerCapture(el: HTMLElement): void {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn(() => false);
}

function createMockContainer(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'board-container';

  // Create mock board element matching selector div[id$="-board"]
  const board = document.createElement('div');
  board.id = 'test-board';
  board.style.width = '400px';
  board.style.height = '400px';

  // Create 64 squares with data-square attributes
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = ['1', '2', '3', '4', '5', '6', '7', '8'];
  for (const rank of ranks) {
    for (const file of files) {
      const square = document.createElement('div');
      square.setAttribute('data-square', file + rank);
      square.style.width = '50px';
      square.style.height = '50px';

      // Add white piece to e2 (for player-color drag tests)
      if (file === 'e' && rank === '2') {
        const piece = document.createElement('div');
        piece.setAttribute('data-piece', 'wP');
        square.appendChild(piece);
      }
      // Add black piece to e7 (for opponent-color drag tests)
      if (file === 'e' && rank === '7') {
        const piece = document.createElement('div');
        piece.setAttribute('data-piece', 'bP');
        square.appendChild(piece);
      }
      board.appendChild(square);
    }
  }

  container.appendChild(board);
  document.body.appendChild(container);
  return container;
}

describe('useFastDrag — enabled state (KS-273)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = createMockContainer();
    stubPointerCapture(container);
  });

  afterEach(() => {
    container.remove();
    // Remove ghosts that were not cleaned up synchronously (RAF/setTimeout deferred)
    document.querySelectorAll('[style*="z-index: 9999"]').forEach(el => el.remove());
  });

  it('should not create ghost when enabled=false', () => {
    const onPieceDrop = vi.fn(() => true);
    const ref = { current: container };

    renderHook(() =>
      useFastDrag(ref, {
        onPieceDrop,
        boardOrientation: 'white',
        enabled: false,
      }),
    );

    // Simulate a full drag gesture (pointerdown + pointermove > threshold) on
    // own piece. The hook should ignore it because enabled=false.
    const piece = container.querySelector('[data-piece="wP"]')!;
    simulateDragStart(piece, 225, 225);

    // No ghost should be created
    const ghosts = document.querySelectorAll('[style*="position: fixed"]');
    expect(ghosts.length).toBe(0);
  });

  it('should create ghost when enabled=true', () => {
    const onPieceDrop = vi.fn(() => true);
    const ref = { current: container };

    // Mock getBoundingClientRect for board
    const boardEl = container.querySelector('div[id$="-board"]')!;
    vi.spyOn(boardEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      top: 0,
      left: 0,
      right: 400,
      bottom: 400,
      toJSON: () => {},
    });

    renderHook(() =>
      useFastDrag(ref, {
        onPieceDrop,
        boardOrientation: 'white',
        enabled: true,
      }),
    );

    const piece = container.querySelector('[data-piece="wP"]')!;
    simulateDragStart(piece, 225, 225);

    const ghosts = document.querySelectorAll('[style*="z-index: 9999"]');
    expect(ghosts.length).toBe(1);

    // Cleanup: trigger pointerup
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 225,
        clientY: 225,
        bubbles: true,
      }),
    );
  });

  it('should react to enabled changing from false to true (KS-270 regression)', () => {
    const onPieceDrop = vi.fn(() => true);
    const ref = { current: container };

    const boardEl = container.querySelector('div[id$="-board"]')!;
    vi.spyOn(boardEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      top: 0,
      left: 0,
      right: 400,
      bottom: 400,
      toJSON: () => {},
    });

    // Start with enabled=false (like PuzzleRush start screen)
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useFastDrag(ref, {
          onPieceDrop,
          boardOrientation: 'white',
          enabled,
        }),
      { initialProps: { enabled: false } },
    );

    // Drag gesture should be ignored when disabled
    const piece = container.querySelector('[data-piece="wP"]')!;
    simulateDragStart(piece, 225, 225);

    let ghosts = document.querySelectorAll('[style*="z-index: 9999"]');
    expect(ghosts.length).toBe(0);

    // Switch to enabled=true (like transitioning to 'playing' screen)
    rerender({ enabled: true });

    // Now the drag gesture should work
    simulateDragStart(piece, 225, 225);

    ghosts = document.querySelectorAll('[style*="z-index: 9999"]');
    expect(ghosts.length).toBe(1);

    // Cleanup
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 225,
        clientY: 225,
        bubbles: true,
      }),
    );
  });

  it('should disable drag when enabled changes from true to false', () => {
    const onPieceDrop = vi.fn(() => true);
    const ref = { current: container };

    const boardEl = container.querySelector('div[id$="-board"]')!;
    vi.spyOn(boardEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      top: 0,
      left: 0,
      right: 400,
      bottom: 400,
      toJSON: () => {},
    });

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useFastDrag(ref, {
          onPieceDrop,
          boardOrientation: 'white',
          enabled,
        }),
      { initialProps: { enabled: true } },
    );

    // Switch to disabled (game ended, feedback showing, etc.)
    rerender({ enabled: false });

    const piece = container.querySelector('[data-piece="wP"]')!;
    simulateDragStart(piece, 225, 225);

    const ghosts = document.querySelectorAll('[style*="z-index: 9999"]');
    expect(ghosts.length).toBe(0);
  });

  it('should work through multiple enable/disable cycles (restart scenario)', () => {
    const onPieceDrop = vi.fn(() => true);
    const ref = { current: container };

    const boardEl = container.querySelector('div[id$="-board"]')!;
    vi.spyOn(boardEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      top: 0,
      left: 0,
      right: 400,
      bottom: 400,
      toJSON: () => {},
    });

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useFastDrag(ref, {
          onPieceDrop,
          boardOrientation: 'white',
          enabled,
        }),
      { initialProps: { enabled: false } },
    );

    const piece = container.querySelector('[data-piece="wP"]')!;

    const tryDrag = (): number => {
      simulateDragStart(piece, 225, 225);
      const count = document.querySelectorAll('[style*="z-index: 9999"]').length;
      // Cleanup if ghost was created
      document.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: 225,
          clientY: 225,
          bubbles: true,
        }),
      );
      // Ghost cleanup is RAF/setTimeout deferred — remove manually for test isolation
      document.querySelectorAll('[style*="z-index: 9999"]').forEach(el => el.remove());
      return count;
    };

    // Cycle 1: false -> true -> false
    expect(tryDrag()).toBe(0); // disabled
    rerender({ enabled: true });
    expect(tryDrag()).toBe(1); // enabled
    rerender({ enabled: false });
    expect(tryDrag()).toBe(0); // disabled again

    // Cycle 2: false -> true (restart scenario)
    rerender({ enabled: true });
    expect(tryDrag()).toBe(1); // enabled after second cycle
  });

  it('should not create ghost when dragging opponent piece (KS-291)', () => {
    const onPieceDrop = vi.fn(() => true);
    const ref = { current: container };

    const boardEl = container.querySelector('div[id$="-board"]')!;
    vi.spyOn(boardEl, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      top: 0,
      left: 0,
      right: 400,
      bottom: 400,
      toJSON: () => {},
    });

    renderHook(() =>
      useFastDrag(ref, {
        onPieceDrop,
        boardOrientation: 'white',
        enabled: true,
      }),
    );

    // Try to drag opponent's (black) piece
    const opponentPiece = container.querySelector('[data-piece="bP"]')!;
    simulateDragStart(opponentPiece, 225, 75);

    const ghosts = document.querySelectorAll('[style*="z-index: 9999"]');
    expect(ghosts.length).toBe(0);
  });
});
