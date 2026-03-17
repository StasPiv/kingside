import { useEffect, useState } from 'react';

const HEADER_HEIGHT = 48;
const CLOCKS_HEIGHT = 2 * 52;
const PADDING_DESKTOP = 48;
const PADDING_MOBILE = 16;
const PADDING_NARROW = 48; // extra padding on narrow phones (≤480px) to leave room for sidebar
const SIDEBAR_WIDTH = 280;
const SIDEBAR_GAP = 24;
const MIN_BOARD_SIZE = 240;
const MAX_BOARD_SIZE = 640;
const MOBILE_BREAKPOINT = 900;
const BACK_LINK_HEIGHT = 30;
const BOARD_AREA_GAP = 16; // 2 × 8px gaps between player-info and board
const GAME_PAGE_GAP_MOBILE = 24; // gap between flex children in .game-page on mobile
const SIDEBAR_MIN_HEIGHT_MOBILE = 200; // reserve space for moves/actions below board on mobile

function calculateBoardSize(): number {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const isMobile = vw < MOBILE_BREAKPOINT;
  const isNarrow = vw <= 480;
  const padding = isNarrow ? PADDING_NARROW : isMobile ? PADDING_MOBILE : PADDING_DESKTOP;
  const sidebarW = isMobile ? 0 : SIDEBAR_WIDTH + SIDEBAR_GAP;

  const extraVertical = isMobile
    ? BACK_LINK_HEIGHT + BOARD_AREA_GAP + GAME_PAGE_GAP_MOBILE + SIDEBAR_MIN_HEIGHT_MOBILE
    : BACK_LINK_HEIGHT + BOARD_AREA_GAP;
  const maxByHeight = vh - HEADER_HEIGHT - CLOCKS_HEIGHT - padding - extraVertical;
  const maxByWidth = vw - sidebarW - padding;
  const size = Math.min(maxByHeight, maxByWidth, MAX_BOARD_SIZE);
  return Math.max(size, MIN_BOARD_SIZE);
}

/**
 * Calculates board size based on available viewport space.
 * Board-first approach: board size = min(maxByHeight, maxByWidth, MAX).
 * Supports portrait/landscape orientation changes on mobile (min 320px).
 * Initial state is calculated synchronously to avoid layout flash on first render.
 */
export function useResponsiveBoardSize(): number {
  const [boardSize, setBoardSize] = useState(() => calculateBoardSize());

  useEffect(() => {
    const onResize = () => setBoardSize(calculateBoardSize());

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return boardSize;
}
