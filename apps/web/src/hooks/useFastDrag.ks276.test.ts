import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFastDrag } from './useFastDrag';

/**
 * KS-277: Unit tests verifying KS-276 fix (piece disappears on drag in Chrome).
 *
 * Tests the three changes from KS-276:
 * 1. setPointerCapture targets container, not e.target
 * 2. dragstart event is blocked during active drag
 * 3. lostpointercapture restores piece visibility
 */

function createMockContainer(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'board-container';

  const board = document.createElement('div');
  board.id = 'test-board';
  board.style.width = '400px';
  board.style.height = '400px';

  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = ['1', '2', '3', '4', '5', '6', '7', '8'];
  for (const rank of ranks) {
    for (const file of files) {
      const square = document.createElement('div');
      square.setAttribute('data-square', file + rank);
      square.style.width = '50px';
      square.style.height = '50px';

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

function mockBoardRect(container: HTMLDivElement) {
  const boardEl = container.querySelector('div[id$="-board"]')!;
  vi.spyOn(boardEl, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 400, height: 400,
    top: 0, left: 0, right: 400, bottom: 400,
    toJSON: () => {},
  });
}

function startDrag(container: HTMLDivElement): HTMLElement {
  const piece = container.querySelector('[data-piece]')!;
  piece.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: 225, clientY: 75,
      bubbles: true, button: 0, cancelable: true,
    }),
  );
  return piece as HTMLElement;
}

function endDrag() {
  document.dispatchEvent(
    new PointerEvent('pointerup', {
      clientX: 225, clientY: 225, bubbles: true,
    }),
  );
}

describe('useFastDrag — KS-276 Chrome drag fix', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = createMockContainer();
    mockBoardRect(container);
  });

  afterEach(() => {
    container.remove();
  });

  // ── Fix 1: setPointerCapture on container ──────────────────────────────────

  describe('setPointerCapture target', () => {
    it('should call setPointerCapture on container, not on piece element', () => {
      const containerCaptureSpy = vi.spyOn(container, 'setPointerCapture')
        .mockImplementation(() => {});
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      startDrag(container);

      expect(containerCaptureSpy).toHaveBeenCalled();

      endDrag();
      containerCaptureSpy.mockRestore();
    });

    it('should NOT call setPointerCapture on SVG child elements', () => {
      // Add an SVG child inside the piece to simulate react-chessboard structure
      const piece = container.querySelector('[data-piece]')!;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      piece.appendChild(svg);

      const svgCaptureSpy = vi.spyOn(svg, 'setPointerCapture')
        .mockImplementation(() => {});
      const pieceCaptureSpy = vi.spyOn(piece as HTMLElement, 'setPointerCapture')
        .mockImplementation(() => {});
      const containerCaptureSpy = vi.spyOn(container, 'setPointerCapture')
        .mockImplementation(() => {});

      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      // Dispatch pointerdown from SVG element (as Chrome would)
      svg.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 225, clientY: 75,
          bubbles: true, button: 0, cancelable: true,
        }),
      );

      expect(svgCaptureSpy).not.toHaveBeenCalled();
      expect(pieceCaptureSpy).not.toHaveBeenCalled();
      expect(containerCaptureSpy).toHaveBeenCalled();

      endDrag();
      svgCaptureSpy.mockRestore();
      pieceCaptureSpy.mockRestore();
      containerCaptureSpy.mockRestore();
    });
  });

  // ── Fix 2: dragstart prevention ────────────────────────────────────────────

  describe('dragstart prevention', () => {
    it('should prevent dragstart during active drag', () => {
      vi.spyOn(container, 'setPointerCapture').mockImplementation(() => {});
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      startDrag(container);

      // Dispatch dragstart during active drag
      const dragEvent = new Event('dragstart', {
        bubbles: true, cancelable: true,
      });
      container.dispatchEvent(dragEvent);

      expect(dragEvent.defaultPrevented).toBe(true);

      endDrag();
    });

    it('should NOT prevent dragstart when no drag is active', () => {
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      // Dispatch dragstart without active drag
      const dragEvent = new Event('dragstart', {
        bubbles: true, cancelable: true,
      });
      container.dispatchEvent(dragEvent);

      expect(dragEvent.defaultPrevented).toBe(false);
    });
  });

  // ── Fix 3: lostpointercapture recovery ─────────────────────────────────────

  describe('lostpointercapture recovery', () => {
    it('should restore piece opacity when pointer capture is lost', () => {
      vi.spyOn(container, 'setPointerCapture').mockImplementation(() => {});
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      const piece = startDrag(container);

      // Piece should be hidden during drag
      expect(piece.style.opacity).toBe('0');

      // Simulate lostpointercapture
      container.dispatchEvent(
        new PointerEvent('lostpointercapture', { bubbles: false }),
      );

      // Piece opacity should be restored
      expect(piece.style.opacity).toBe('');
    });

    it('should remove ghost element when pointer capture is lost', () => {
      vi.spyOn(container, 'setPointerCapture').mockImplementation(() => {});
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      startDrag(container);

      // Ghost should exist during drag
      const ghostsDuringDrag = document.querySelectorAll(
        '[style*="z-index: 9999"]',
      );
      expect(ghostsDuringDrag.length).toBe(1);

      // Simulate lostpointercapture
      container.dispatchEvent(
        new PointerEvent('lostpointercapture', { bubbles: false }),
      );

      // Ghost should be removed
      const ghostsAfter = document.querySelectorAll(
        '[style*="z-index: 9999"]',
      );
      expect(ghostsAfter.length).toBe(0);
    });

    it('should clear drag state after lostpointercapture', () => {
      vi.spyOn(container, 'setPointerCapture').mockImplementation(() => {});
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      startDrag(container);

      // Trigger lostpointercapture
      container.dispatchEvent(
        new PointerEvent('lostpointercapture', { bubbles: false }),
      );

      // Subsequent pointermove should not throw (drag state is cleared)
      expect(() => {
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: 300, clientY: 300, bubbles: true,
          }),
        );
      }).not.toThrow();

      // Subsequent pointerup should not throw
      expect(() => {
        endDrag();
      }).not.toThrow();
    });

    it('should IGNORE lostpointercapture bubbling from child (KS-278 root cause)', () => {
      vi.spyOn(container, 'setPointerCapture').mockImplementation(() => {});
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      const piece = startDrag(container);

      // Ghost should exist
      expect(document.querySelectorAll('[style*="z-index: 9999"]').length).toBe(1);
      expect(piece.style.opacity).toBe('0');

      // Simulate lostpointercapture bubbling from child element (piece).
      // This is what happens in browsers when container.setPointerCapture()
      // releases implicit capture from e.target (the piece/SVG).
      const childEvent = new PointerEvent('lostpointercapture', { bubbles: true });
      Object.defineProperty(childEvent, 'target', { value: piece });
      container.dispatchEvent(childEvent);

      // Ghost should STILL exist — the drag must NOT be torn down
      expect(document.querySelectorAll('[style*="z-index: 9999"]').length).toBe(1);
      expect(piece.style.opacity).toBe('0');

      endDrag();
    });

    it('lostpointercapture is no-op when no drag is active', () => {
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop: vi.fn(() => true),
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      // Should not throw when no drag is active
      expect(() => {
        container.dispatchEvent(
          new PointerEvent('lostpointercapture', { bubbles: false }),
        );
      }).not.toThrow();
    });
  });

  // ── Combined scenario ──────────────────────────────────────────────────────

  describe('full drag lifecycle with KS-276 fixes', () => {
    it('drag completes correctly with all safety mechanisms in place', () => {
      vi.spyOn(container, 'setPointerCapture').mockImplementation(() => {});
      const onPieceDrop = vi.fn(() => true);
      const ref = { current: container };

      renderHook(() =>
        useFastDrag(ref, {
          onPieceDrop,
          boardOrientation: 'white',
          enabled: true,
        }),
      );

      const piece = startDrag(container);

      // Verify piece hidden during drag
      expect(piece.style.opacity).toBe('0');

      // Verify ghost exists
      const ghosts = document.querySelectorAll('[style*="z-index: 9999"]');
      expect(ghosts.length).toBe(1);

      // Verify dragstart is blocked
      const dragEvent = new Event('dragstart', {
        bubbles: true, cancelable: true,
      });
      container.dispatchEvent(dragEvent);
      expect(dragEvent.defaultPrevented).toBe(true);

      // Complete drag normally
      document.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: 225, clientY: 225, bubbles: true,
        }),
      );

      // Piece visible, ghost removed
      expect(piece.style.opacity).toBe('');
      expect(
        document.querySelectorAll('[style*="z-index: 9999"]').length,
      ).toBe(0);
    });
  });
});
