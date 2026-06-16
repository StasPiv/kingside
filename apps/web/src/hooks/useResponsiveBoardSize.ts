import { useEffect, useState } from 'react';

const HEADER_HEIGHT = 48;
// KS-4256: компактнее player-bar (padding 6px+gap → 40-44px высоты).
const CLOCKS_HEIGHT = 2 * 44;
// KS-4256: меньше padding'а вокруг доски — освободить место для самой доски.
const PADDING_DESKTOP = 16;
const PADDING_MOBILE = 16;
const PADDING_NARROW = 48; // extra padding on narrow phones (≤480px) to leave room for sidebar
const SIDEBAR_WIDTH = 280;
const SIDEBAR_GAP = 16;
const MIN_BOARD_SIZE = 240;
// KS-4256: было 640 — на FullHD доска казалась маленькой против lichess (≈720)
// и chess.com (≈620). 920 даёт ~700-900px доску на стандартных десктопах,
// при этом ширина окна / высота viewport всё равно ограничивают сверху.
const MAX_BOARD_SIZE = 920;
const MOBILE_BREAKPOINT = 900;
// KS-4256: back-link теперь `position: fixed` (см. game.css) — не занимает
// высоту в потоке колонки с доской.
const BACK_LINK_HEIGHT = 0;
const BOARD_AREA_GAP = 12; // 2 × 6px gaps between player-info and board
const GAME_PAGE_GAP_MOBILE = 12; // gap between flex children in .game-page on mobile
const SIDEBAR_MIN_HEIGHT_MOBILE = 200; // reserve space for moves/actions below board on mobile
// KS-4257: bot-banner — реально занимает ~28px (padding 4+4 + font 12*1.35 + border
// 2) плюс gap 6 над ним. Округляем до 34, чтобы запас был и на bookmark-bar.
const BOT_BANNER_HEIGHT = 34;
// KS-4257 / KS-4275: общий «safety» резерв на нерасчитанные пиксели.
// Источники: нижний padding .game-page (6px), border player-bar (1+1px),
// фактический line-height clock (≈4-6px поверх font-size), округление aspect-ratio
// доски, браузерные bookmark-bar/extension-bar. После KS-4274 на 1280×800
// нижний ряд клеток ещё обрезался на ~5% — поднимаем с 12 до 28, чтобы запас
// был с гарантией. Лучше отдать 16 лишних px высоты, чем срезать фигуры.
const SAFETY_RESERVE = 28;
// KS-4274: MobileBottomBar (layout.css `.mobile-bottom-bar`) — `position: fixed`,
// `height: 56px + env(safe-area-inset-bottom, 0)`. Видна при `(max-width: 768px)`
// и на не-game-страницах. На `/play/local-bot` тот же GameShell, но bar остаётся
// — забирает 56px+safe-area нижней части viewport, доска уезжала за неё.
const MOBILE_BOTTOM_BAR_HEIGHT = 56;
// `(max-width: 768px)` — точный media query из layout.css §`.mobile-bottom-bar`.
// Если меняется там — синхронизировать здесь.
const MOBILE_BOTTOM_BAR_BREAKPOINT = 768;
// KS-4290 (ADR-134 §2): GameActionBar — `position: sticky`, min-height 56px
// + env(safe-area-inset-bottom). Виден на ≤899px при активном GameShell.
// Если меняется высота — синхронизировать здесь и в `game.css`
// .game-action-bar.
const GAME_ACTION_BAR_HEIGHT = 56;

function safeAreaInsetBottom(): number {
  // На iOS / Android — env(safe-area-inset-bottom). В headless / десктопе
  // вернёт 0 при отсутствии. Безопасно для SSR — useEffect гарантирует window.
  if (typeof window === 'undefined') return 0;
  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.bottom = 'env(safe-area-inset-bottom, 0px)';
  probe.style.height = '0';
  probe.style.width = '0';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const inset = parseFloat(getComputedStyle(probe).bottom) || 0;
  document.body.removeChild(probe);
  return inset;
}

export interface ResponsiveBoardSizeOptions {
  /**
   * KS-4257. Дополнительная высота над доской, которую нужно вычесть из
   * расчёта. Сейчас используется только для bot-fallback-banner; в будущем
   * сюда же можно прокинуть высоту любых in-flow блоков, появляющихся над
   * `.player-info`.
   */
  hasBotBanner?: boolean;
  /**
   * Произвольное дополнительное число пикселей сверху, на случай если
   * GameShell добавит свой блок (`belowBoardBlock` сейчас рендерится
   * внутри `.game-board-area` — отдельный кейс).
   */
  extraSubtract?: number;
  /**
   * KS-4274. `false` (по умолчанию) — на ≤768px вычитаем высоту
   * MobileBottomBar (56px + safe-area-inset-bottom). `true` — bar
   * скрыт (например, на `/game/<id>`, где MainLayout его прячет:
   * `hideBottomBar = pathname.startsWith('/game/')`).
   */
  hideMobileBottomBar?: boolean;
  /**
   * KS-4290 (ADR-134 §2). На mobile (≤899px) под доской рендерится
   * sticky GameActionBar — `min-height: 56px + env(safe-area-inset-bottom)`.
   * Чтобы доска не уезжала за нижний край, вычитаем его высоту аналогично
   * `MobileBottomBar`. На desktop ≥900px action-bar не рендерится, и
   * значение игнорируется.
   */
  hasActionBar?: boolean;
}

function calculateBoardSize(options: ResponsiveBoardSizeOptions = {}): number {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const isMobile = vw < MOBILE_BREAKPOINT;
  const isNarrow = vw <= 480;
  const padding = isNarrow ? PADDING_NARROW : isMobile ? PADDING_MOBILE : PADDING_DESKTOP;
  const sidebarW = isMobile ? 0 : SIDEBAR_WIDTH + SIDEBAR_GAP;

  const botBanner = options.hasBotBanner ? BOT_BANNER_HEIGHT : 0;
  const extra = options.extraSubtract ?? 0;
  // KS-4274: MobileBottomBar показывается на ≤768px (layout.css). На
  // /game/<id> MainLayout его прячет — вызывающий передаёт
  // `hideMobileBottomBar: true`.
  const mobileBarShown =
    !options.hideMobileBottomBar && vw <= MOBILE_BOTTOM_BAR_BREAKPOINT;
  const mobileBar = mobileBarShown
    ? MOBILE_BOTTOM_BAR_HEIGHT + safeAreaInsetBottom()
    : 0;
  // KS-4290 (ADR-134 §2): GameActionBar показывается на ≤899px (тот же
  // breakpoint, что у мобильной вёрстки `.game-page`). Высоту вычитаем
  // только когда вызывающий явно подтвердил, что bar смонтирован —
  // в десктопной верстке GameShell его не рендерит.
  const actionBar =
    options.hasActionBar && isMobile
      ? GAME_ACTION_BAR_HEIGHT + safeAreaInsetBottom()
      : 0;

  const extraVertical = isMobile
    ? BACK_LINK_HEIGHT +
      BOARD_AREA_GAP +
      GAME_PAGE_GAP_MOBILE +
      SIDEBAR_MIN_HEIGHT_MOBILE +
      botBanner +
      mobileBar +
      actionBar +
      extra +
      SAFETY_RESERVE
    : BACK_LINK_HEIGHT +
      BOARD_AREA_GAP +
      botBanner +
      mobileBar +
      actionBar +
      extra +
      SAFETY_RESERVE;
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
 *
 * KS-4257: принимает опции `{ hasBotBanner, extraSubtract }`. Когда выше
 * доски в потоке появляется блок (например, bot-fallback-banner), нужно
 * учесть его высоту, иначе нижний ряд клеток обрезается.
 */
export function useResponsiveBoardSize(
  options: ResponsiveBoardSizeOptions = {},
): number {
  const {
    hasBotBanner = false,
    extraSubtract = 0,
    hideMobileBottomBar = false,
    hasActionBar = false,
  } = options;
  const [boardSize, setBoardSize] = useState(() =>
    calculateBoardSize({
      hasBotBanner,
      extraSubtract,
      hideMobileBottomBar,
      hasActionBar,
    }),
  );

  useEffect(() => {
    const onResize = () =>
      setBoardSize(
        calculateBoardSize({
          hasBotBanner,
          extraSubtract,
          hideMobileBottomBar,
          hasActionBar,
        }),
      );

    // Пересчёт сразу при изменении входных опций (показали/скрыли баннер).
    onResize();

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [hasBotBanner, extraSubtract, hideMobileBottomBar, hasActionBar]);

  return boardSize;
}
