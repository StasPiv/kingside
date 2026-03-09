import { useState, useEffect } from 'react';

const HEADER_HEIGHT = 48;
const CLOCKS_HEIGHT = 2 * 52;
const PADDING = 48;
const SIDEBAR_WIDTH = 280 + 24; // sidebar + gap
const SIDEBAR_BREAKPOINT = 900;
const MAX_SIZE = 640;
const MIN_SIZE = 280;

/**
 * Calculates responsive board size based on viewport dimensions.
 * Accounts for header, clocks, padding, and sidebar (on wide screens).
 */
export function useResponsiveBoardSize(): number {
  const [boardSize, setBoardSize] = useState(480);

  useEffect(() => {
    const calculate = () => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const sidebarW = vw >= SIDEBAR_BREAKPOINT ? SIDEBAR_WIDTH : 0;

      const maxByHeight = vh - HEADER_HEIGHT - CLOCKS_HEIGHT - PADDING;
      const maxByWidth = vw - sidebarW - PADDING;
      const size = Math.min(maxByHeight, maxByWidth, MAX_SIZE);
      setBoardSize(Math.max(size, MIN_SIZE));
    };

    calculate();
    window.addEventListener('resize', calculate);
    return () => window.removeEventListener('resize', calculate);
  }, []);

  return boardSize;
}
