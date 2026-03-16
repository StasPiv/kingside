import { useEffect, useState } from 'react';

const HEADER_HEIGHT = 48;
const CLOCKS_HEIGHT = 2 * 52;
const PADDING_DESKTOP = 48;
const PADDING_MOBILE = 16;
const SIDEBAR_WIDTH = 280;
const SIDEBAR_GAP = 24;
const MIN_BOARD_SIZE = 240;
const MAX_BOARD_SIZE = 640;
const MOBILE_BREAKPOINT = 900;
const BACK_LINK_HEIGHT = 30;
const BOARD_AREA_GAP = 16; // 2 × 8px gaps between player-info and board
const GAME_PAGE_GAP_MOBILE = 24; // gap between flex children in .game-page on mobile

/**
 * Calculates board size based on available viewport space.
 * Board-first approach: board size = min(maxByHeight, maxByWidth, MAX).
 * Supports portrait/landscape orientation changes on mobile (min 320px).
 */
export function useResponsiveBoardSize(): number {
  const [boardSize, setBoardSize] = useState(480);

  useEffect(() => {
    const calculate = () => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const isMobile = vw < MOBILE_BREAKPOINT;
      const padding = isMobile ? PADDING_MOBILE : PADDING_DESKTOP;
      const sidebarW = isMobile ? 0 : SIDEBAR_WIDTH + SIDEBAR_GAP;

      const extraVertical = isMobile ? BACK_LINK_HEIGHT + BOARD_AREA_GAP + GAME_PAGE_GAP_MOBILE : 0;
      const maxByHeight = vh - HEADER_HEIGHT - CLOCKS_HEIGHT - padding - extraVertical;
      const maxByWidth = vw - sidebarW - padding;
      const size = Math.min(maxByHeight, maxByWidth, MAX_BOARD_SIZE);
      setBoardSize(Math.max(size, MIN_BOARD_SIZE));
    };

    calculate();
    window.addEventListener('resize', calculate);
    window.addEventListener('orientationchange', calculate);
    return () => {
      window.removeEventListener('resize', calculate);
      window.removeEventListener('orientationchange', calculate);
    };
  }, []);

  return boardSize;
}
