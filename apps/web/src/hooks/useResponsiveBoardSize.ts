import { useEffect, useState } from 'react';

const HEADER_HEIGHT = 48;
const CLOCKS_HEIGHT = 2 * 52;
const PADDING = 48;
const SIDEBAR_WIDTH = 280;
const SIDEBAR_GAP = 24;
const MIN_BOARD_SIZE = 280;
const MAX_BOARD_SIZE = 640;
const MOBILE_BREAKPOINT = 900;

/**
 * Calculates board size based on available viewport space.
 * Board-first approach: board size = min(maxByHeight, maxByWidth, MAX).
 */
export function useResponsiveBoardSize(): number {
  const [boardSize, setBoardSize] = useState(480);

  useEffect(() => {
    const calculate = () => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const sidebarW = vw >= MOBILE_BREAKPOINT ? SIDEBAR_WIDTH + SIDEBAR_GAP : 0;

      const maxByHeight = vh - HEADER_HEIGHT - CLOCKS_HEIGHT - PADDING;
      const maxByWidth = vw - sidebarW - PADDING;
      const size = Math.min(maxByHeight, maxByWidth, MAX_BOARD_SIZE);
      setBoardSize(Math.max(size, MIN_BOARD_SIZE));
    };

    calculate();
    window.addEventListener('resize', calculate);
    return () => window.removeEventListener('resize', calculate);
  }, []);

  return boardSize;
}
