import { useEffect, useState } from 'react';

const HEADER_HEIGHT = 48;
// KS-4256: компактнее player-bar (padding 6px+gap → 40-44px высоты).
// KS-4621: часы вынесены из `.player-info` — теперь bar содержит только
// аватар+имя, его высота ≈32px (padding 6+6 + name 15 + border 2).
// На desktop часы переехали в `.game-sidebar` и не влияют на высоту
// `.game-board-area`. На mobile появился отдельный `.game-clock-bar`
// над/под player-info (~38px = font 28 + padding 4+4 + border 2);
// его высота учитывается через MOBILE_CLOCK_BAR_HEIGHT ниже.
const CLOCKS_HEIGHT = 2 * 32;
const MOBILE_CLOCK_BAR_HEIGHT = 38;
// KS-4256 / KS-4299: горизонтальный отступ `.game-page` (left + right
// в сумме). На desktop оставляем по 8px с каждой стороны. На mobile
// после KS-4299 доска edge-to-edge — горизонтальных отступов нет.
const HORIZONTAL_PADDING_DESKTOP = 16;
const HORIZONTAL_PADDING_MOBILE = 0;
// KS-4256 / KS-4299: вертикальный отступ `.game-page` (top + bottom).
// На desktop симметричные 6/6 = 12. На mobile сверху 8 («дыхание» до
// верхнего player-bar) + 8 (зазор между нижним player-bar и
// `position: fixed` action-bar; сам action-bar учитывается отдельно
// через `hasActionBar`).
const VERTICAL_PADDING_DESKTOP = 12;
const VERTICAL_PADDING_MOBILE = 16;
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
// KS-4621: 2 × 6px gaps между player-info и доской (desktop). На mobile
// добавляются ещё 2 × 6px (`.player-info` ↔ `.game-clock-bar` ↔ board),
// поэтому ниже в mobile-ветке `BOARD_AREA_GAP * 2`.
const BOARD_AREA_GAP = 12;
// KS-4299: gap между детьми `.game-page` flex-column на mobile. После
// KS-4299 `.game-sidebar` `display: none` на ≤899px, поэтому в потоке
// между `.game-board-area` и `.game-action-bar` ровно один gap. Сейчас
// CSS gap = 8px (см. game.css @media max-width: 899px / 414px) —
// держим синхронно.
const GAME_PAGE_GAP_MOBILE = 8;
// KS-4299: было 200 — резервировалось под `.game-sidebar` (move-list /
// actions / chat) под доской на mobile. После KS-4290..4302 содержимое
// сайдбара на ≤899px полностью скрыто CSS: вертикальная move-list
// заменена горизонтальной лентой `<GameMoveStrip>` над верхним player-
// bar (учитывается отдельно через `hasMoveStrip`), actions переехали
// в `.game-action-bar` (учитываются через `hasActionBar`), chat —
// в `<GameChatSheet>` (position: fixed, в потоке высоту не занимает).
// Резерв 200px превращался в пустой блок под нижним player-bar и не
// давал доске занять доступную высоту. Сейчас 0 — реальные блоки под
// доской учитываются отдельными опциями.
const SIDEBAR_MIN_HEIGHT_MOBILE = 0;
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
// KS-4291 (ADR-134 §3): GameMoveStrip — компактная горизонтальная
// полоска ходов под доской на mobile. Высота 32px без safe-area
// (полоска не прижата к нижнему краю, safe-area уже учтена в
// action-bar). Синхронизировать с `game.css` .game-move-strip.
// KS-4298 — полоска убрана из GameShell, константа оставлена для
// обратной совместимости с тестами/потенциальным повторным
// использованием.
const GAME_MOVE_STRIP_HEIGHT = 32;
// KS-4298: тонкая строка с последним ходом над `.opponent-info`.
// Шрифт ≈12-13px + межстрочное расстояние = высота ≈20px. Учитывается
// в расчёте доски, чтобы доска не уезжала за нижний край после
// появления строки.
const GAME_LAST_MOVE_LINE_HEIGHT = 20;

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
  /**
   * KS-4291 (ADR-134 §3). На mobile под доской отображается компактная
   * полоска ходов высотой 32px между нижним player-bar'ом и action-
   * bar'ом. Параметр включает вычитание этой высоты на mobile; на
   * desktop ≥900px игнорируется (`isMobile && options.hasMoveStrip`).
   * KS-4298 — `GameShell` больше не передаёт этот флаг, но параметр
   * сохранён для совместимости.
   */
  hasMoveStrip?: boolean;
  /**
   * KS-4298. Тонкая строка «последний ход» над верхним player-bar
   * (≈20px). На mobile вычитается из доступной высоты, чтобы доска
   * заняла максимум; на desktop игнорируется
   * (`isMobile && options.hasLastMoveLine`).
   */
  hasLastMoveLine?: boolean;
}

function calculateBoardSize(options: ResponsiveBoardSizeOptions = {}): number {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const isMobile = vw < MOBILE_BREAKPOINT;
  const horizontalPadding = isMobile
    ? HORIZONTAL_PADDING_MOBILE
    : HORIZONTAL_PADDING_DESKTOP;
  const verticalPadding = isMobile
    ? VERTICAL_PADDING_MOBILE
    : VERTICAL_PADDING_DESKTOP;
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
  // KS-4291 (ADR-134 §3): GameMoveStrip — компактная полоска ходов под
  // доской на mobile (≤899px). Высоту 32px вычитаем независимо от
  // action-bar; на desktop игнорируется. KS-4298: GameShell больше
  // не передаёт hasMoveStrip — вычитание отрабатывает только если
  // вызывающий код явно его выставил.
  const moveStrip =
    options.hasMoveStrip && isMobile ? GAME_MOVE_STRIP_HEIGHT : 0;
  // KS-4298: тонкая строка «последний ход» над opponent-info.
  const lastMoveLine =
    options.hasLastMoveLine && isMobile ? GAME_LAST_MOVE_LINE_HEIGHT : 0;

  // KS-4621: на mobile к высоте `.game-board-area` добавляются 2 ×
  // `.game-clock-bar` (~38px) — отдельные блоки часов над/под доской.
  // Дополнительно 2 × BOARD_AREA_GAP (6px каждый) появляются между
  // clock-bar ↔ player-info, итого +12 к вертикали поверх двух
  // существующих gap'ов board ↔ clock-bar. На desktop часы переехали
  // в `.game-sidebar` — colon-bar в `.game-board-area` отсутствует.
  const mobileClockBars = isMobile ? 2 * MOBILE_CLOCK_BAR_HEIGHT : 0;
  const extraGaps = isMobile ? BOARD_AREA_GAP : 0;

  const extraVertical = isMobile
    ? BACK_LINK_HEIGHT +
      BOARD_AREA_GAP +
      extraGaps +
      mobileClockBars +
      GAME_PAGE_GAP_MOBILE +
      SIDEBAR_MIN_HEIGHT_MOBILE +
      botBanner +
      mobileBar +
      actionBar +
      moveStrip +
      lastMoveLine +
      extra +
      SAFETY_RESERVE
    : BACK_LINK_HEIGHT +
      BOARD_AREA_GAP +
      botBanner +
      mobileBar +
      actionBar +
      moveStrip +
      lastMoveLine +
      extra +
      SAFETY_RESERVE;
  const maxByHeight =
    vh - HEADER_HEIGHT - CLOCKS_HEIGHT - verticalPadding - extraVertical;
  const maxByWidth = vw - sidebarW - horizontalPadding;
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
    hasMoveStrip = false,
    hasLastMoveLine = false,
  } = options;
  const [boardSize, setBoardSize] = useState(() =>
    calculateBoardSize({
      hasBotBanner,
      extraSubtract,
      hideMobileBottomBar,
      hasActionBar,
      hasMoveStrip,
      hasLastMoveLine,
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
          hasMoveStrip,
          hasLastMoveLine,
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
  }, [
    hasBotBanner,
    extraSubtract,
    hideMobileBottomBar,
    hasActionBar,
    hasMoveStrip,
    hasLastMoveLine,
  ]);

  return boardSize;
}
