/**
 * KS-4150: общая визуальная оболочка игрового экрана.
 *
 * Используется и онлайн-партией (`/game/:id`), и локальной игрой с
 * ботом (`/play/local-bot`). Различие — только в источнике данных,
 * передаваемом через пропсы. Дублирование разметки/CSS-классов
 * между двумя страницами устранено: панель часов, список ходов,
 * блок действий, модальное окно результата и чат живут здесь.
 *
 * Оболочка ничего не знает про WebSocket, REST или Stockfish — она
 * принимает уже агрегированное состояние партии и обратный вызов
 * `onMove`. Управление премувами, промоушеном, подсветкой ходов,
 * звуками, размером доски и drag-and-drop инкапсулировано внутри
 * оболочки, чтобы оба маршрута получали идентичное поведение.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type {
  WsChatMessagePayload,
  WsGameEndPayload,
} from '@kingside/shared';

import { MemoChessboard } from '../MemoChessboard';
import { PromotionPicker } from '../PromotionPicker';
import { HelpButton } from '../HelpButton';
import { GameResultSheet } from './GameResultSheet';
import { GameActionBar } from './GameActionBar';
import { GameMoveStrip } from './GameMoveStrip';
import { GameWaitingOverlay } from './GameWaitingOverlay';
import { GameChatSheet } from './GameChatSheet';
import { GameChatToast } from './GameChatToast';
import { useBoardSettings } from '../../hooks/useBoardSettings';
import { useBoardHighlights } from '../../hooks/useBoardHighlights';
import { useResponsiveBoardSize } from '../../hooks/useResponsiveBoardSize';
import { useStablePosition } from '../../hooks/useStablePosition';
import { useFastDrag } from '../../hooks/useFastDrag';
import { useSounds, soundEventFromSan } from '../../hooks/useSounds';

export type GameColor = 'white' | 'black';
export type GamePromotion = 'q' | 'r' | 'b' | 'n';
export type GameStatus = 'waiting' | 'active' | 'finished';

export interface GameChatProps {
  messages: WsChatMessagePayload[];
  onSend: (text: string) => void;
  currentUserId?: string;
}

export interface GameShellProps {
  /** chess.js инстанс с текущей позицией — нужен для подсветки легальных ходов. */
  chess: Chess;
  fen: string;
  /** История ходов в SAN. */
  moves: string[];
  /** Часы в секундах. */
  clocks: { white: number; black: number };
  status: GameStatus;
  /** Итог партии — 'white' | 'black' | 'draw' | null. */
  result: string | null;
  /** Цвет фигур игрока (вид доски). */
  playerColor: GameColor;
  /** Имена соперников. */
  players: { white: string; black: string };

  /** Применить ход игрока. true — ход легален и применён, false — отвергнут. */
  onMove: (from: Square, to: Square, promotion?: GamePromotion) => boolean;
  /** Разрешить премув (заранее заданный ход на чужом ходу). По умолчанию false. */
  enablePremove?: boolean;
  /** true — текущая перерисовка вызвана ходом соперника (для аккуратной анимации). */
  isOpponentMove?: boolean;
  /**
   * Координаты последнего сыгранного хода — нужны для подсветки
   * жёлтым и звукового сопровождения. Источник данных обновляет
   * этот объект на каждый ход (свой или чужой); shell сравнивает
   * с предыдущим значением и проигрывает звук только один раз.
   */
  lastMove?: { from: Square; to: Square; san: string; ply: number } | null;

  /** Партия с ботом. Влияет на видимость чата, предложения ничьей, баннера. */
  isBot?: boolean;
  /** Уровень бота для подписи в имени. */
  botLevel?: number | null;
  /** Показать баннер «вы играете против бота» (онлайн-fallback). */
  showBotBanner?: boolean;

  /** Сопернику предложена ничья. */
  drawOffered?: boolean;
  canOfferDraw?: boolean;
  canResign?: boolean;
  onResign?: () => void;
  onDrawOffer?: () => void;
  onDrawAccept?: () => void;
  onDrawDecline?: () => void;

  /** Турнирные надстройки. */
  showBerserkButton?: boolean;
  onBerserk?: () => void;
  whiteBerserk?: boolean;
  blackBerserk?: boolean;

  /** Модалка результата. */
  showResultModal?: boolean;
  onCloseResultModal?: () => void;
  ratingChange?: WsGameEndPayload['ratingChange'];

  /** Действия в блоке результата (модалка + сайдбар). */
  onRematch?: () => void;
  canRematch?: boolean;
  rematchPending?: boolean;
  onAnalyze?: () => void;
  showAnalyzeButton?: boolean;
  onNewGame?: () => void;
  newGameLabel?: string;
  /** Кнопка «Новая партия» — ссылка (онлайн). */
  newGameLink?: { to: string; label: string };
  /** Дополнительная ссылка «Домой». */
  homeLink?: { to: string; label: string };
  /** Возврат в турнир. */
  tournamentReturn?: { to: string; label: string };

  /** Чат (онлайн партия). */
  chat?: GameChatProps;

  /** Кнопка «назад». */
  backLink: { to: string; label: string };
  /** Кнопка справки в правом верхнем углу. */
  showHelpButton?: boolean;
  /** Произвольный блок над сайдбаром — например, статус «бот думает». */
  belowBoardBlock?: ReactNode;
  /**
   * KS-4148: принудительно использовать стандартный набор фигур
   * react-chessboard (pieceSet 'standard'), игнорируя customPieces
   * из BoardSettingsContext. Используется на `/play/local-bot`,
   * когда у пользователя нет явного выбора pieceSet — чтобы дефолт
   * проекта (chessnut) не перебивал ожидание «классический стаунтон».
   */
  forceStandardPieces?: boolean;
  /**
   * KS-4153: партия без часов. Блок часов остаётся в разметке (чтобы
   * не дёргать layout), но вместо времени показывается прочерк «—».
   */
  hideClocks?: boolean;
  /**
   * KS-4292 (ADR-134 §6): отображаемое название режима — «Blitz»,
   * «Rapid» и т. п. Используется в pre-game placeholder поверх доски
   * при `status='waiting'`. Если не передано — pre-game подпись
   * сокращается до значения `timeControl` или скрывается совсем.
   */
  mode?: string;
  /**
   * KS-4292: контроль времени в формате «5+0», «3+2». Та же
   * pre-game подпись.
   */
  timeControl?: string;
  /**
   * KS-4292: коллбэк «Отменить поиск» в action-bar при `status='waiting'`.
   * Если не передан — кнопка отсутствует, action-bar остаётся
   * spacer'ом (например, `/play/local-bot`, где поиска нет).
   */
  onCancelSearch?: () => void;
  /**
   * KS-4295 (ADR-134 §9). Коллбэк «Помощь» в меню «⋮ Ещё»
   * action-bar'а. Если не передан явно, но `showHelpButton=true`,
   * GameShell генерирует дефолтный обработчик, открывающий тот же
   * URL, что и старая `<HelpButton section="play">` —
   * `/features#play`. Передача собственного `onHelp` позволяет
   * вызывающему открыть, например, контекстный гайд по урокам.
   */
  onHelp?: () => void;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function isPromotionAttempt(chess: Chess, from: Square, to: Square): boolean {
  const piece = chess.get(from);
  if (!piece || piece.type !== 'p') return false;
  const targetRank = to[1];
  return (
    (piece.color === 'w' && targetRank === '8') ||
    (piece.color === 'b' && targetRank === '1')
  );
}

export function GameShell(props: GameShellProps) {
  const {
    chess,
    fen,
    moves,
    clocks,
    status,
    result,
    playerColor,
    players,
    onMove,
    enablePremove = false,
    isOpponentMove = false,
    lastMove = null,
    isBot = false,
    botLevel = null,
    showBotBanner = false,
    drawOffered = false,
    canOfferDraw = false,
    canResign = false,
    onResign,
    onDrawOffer,
    onDrawAccept,
    onDrawDecline,
    showBerserkButton = false,
    onBerserk,
    whiteBerserk = false,
    blackBerserk = false,
    showResultModal = false,
    onCloseResultModal,
    ratingChange,
    onRematch,
    canRematch = false,
    rematchPending = false,
    onAnalyze,
    showAnalyzeButton = false,
    onNewGame,
    newGameLabel,
    newGameLink,
    homeLink,
    tournamentReturn,
    chat,
    // KS-4259: `backLink` остался в GameShellProps для обратной
    // совместимости вызывающих страниц, но рендера у него больше нет
    // (см. блок `return` ниже) — основной sidebar навигации достаточно.
    // Поэтому не деструктурируем сюда.
    showHelpButton = false,
    belowBoardBlock,
    forceStandardPieces = false,
    hideClocks = false,
    mode,
    timeControl,
    onCancelSearch,
    onHelp,
  } = props;

  const { t } = useTranslation();
  const { playSound, muted, toggleMute } = useSounds();
  const {
    showNotation,
    customPieces,
    darkSquareStyle,
    lightSquareStyle,
    autoPromoteToQueen,
  } = useBoardSettings();

  const gamePageRef = useRef<HTMLDivElement>(null);
  const boardAreaRef = useRef<HTMLDivElement>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const movesRef = useRef<HTMLDivElement>(null);

  // Локальные UI-состояния
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [animationDuration] = useState<number>(() => {
    const saved = localStorage.getItem('pieceAnimationDuration');
    return saved !== null ? parseInt(saved, 10) : 200;
  });
  const [botBannerDismissed, setBotBannerDismissed] = useState(false);
  // KS-4290 (ADR-134 §2): controlled-режим `GameResultSheet`. На mobile
  // действия пользователя «свернуть/раскрыть результат» проходят через
  // GameActionBar (post-game pill). На desktop модальное окно
  // показывается отдельно — это состояние на него не влияет.
  const [resultSheetExpanded, setResultSheetExpanded] = useState(true);
  // KS-4292 (ADR-134 §6): pre-game placeholder появляется через 1.5 с
  // после входа в `status='waiting'` — чтобы при быстром нахождении
  // соперника overlay не моргнул. Переход в любой другой статус
  // мгновенно снимает overlay.
  const [showWaitingOverlay, setShowWaitingOverlay] = useState(false);
  useEffect(() => {
    if (status !== 'waiting') {
      setShowWaitingOverlay(false);
      return;
    }
    const timer = setTimeout(() => setShowWaitingOverlay(true), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  // KS-4293 (ADR-134 §4): состояние нижней панели чата + счётчик
  // непрочитанных + уведомление о новом сообщении соперника.
  //
  //   - `chatSheetOpen` — управляется кнопкой «💬» в action-bar и
  //     закрытием самой панели/тапом по уведомлению.
  //   - `chatUnreadCount` инкрементируется при появлении нового
  //     сообщения соперника при закрытой панели. Открытие панели
  //     сбрасывает в 0.
  //   - `chatToast` — текущее уведомление; null если ничего
  //     не показываем. Появляется только при `status==='active'`
  //     и закрытой панели; на `finished` подавлено.
  //   - Идентификация «соперника» — `msg.userId !== chat.currentUserId`.
  //     `chat` опционален; без него весь блок отключён.
  const [chatSheetOpen, setChatSheetOpen] = useState(false);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [chatToast, setChatToast] = useState<
    { username: string; content: string; id: string } | null
  >(null);
  const lastSeenMsgCountRef = useRef(chat?.messages.length ?? 0);
  useEffect(() => {
    if (!chat) return;
    const total = chat.messages.length;
    const prev = lastSeenMsgCountRef.current;
    if (total <= prev) {
      lastSeenMsgCountRef.current = total;
      return;
    }
    // Новые сообщения с prev по total-1.
    const incoming = chat.messages
      .slice(prev)
      .filter((m) => m.userId !== chat.currentUserId);
    lastSeenMsgCountRef.current = total;
    if (incoming.length === 0) return;
    if (chatSheetOpen) return;
    setChatUnreadCount((c) => c + incoming.length);
    // Тост — только при активной партии. Берём последнее новое
    // сообщение, id — позиция в массиве (моменто стабильна).
    if (status === 'active') {
      const last = incoming[incoming.length - 1];
      setChatToast({
        username: last.username,
        content: last.content,
        id: `chat-${total}`,
      });
    }
  }, [chat?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Сброс непрочитанных и уведомления при открытии панели.
  useEffect(() => {
    if (chatSheetOpen) {
      setChatUnreadCount(0);
      setChatToast(null);
    }
  }, [chatSheetOpen]);
  // На post-game гасим тост сразу, если он был.
  useEffect(() => {
    if (status === 'finished') setChatToast(null);
  }, [status]);
  // Сбрасываем в expanded при появлении нового результата (новая
  // партия завершилась после реванша/новой игры).
  useEffect(() => {
    if (status === 'finished') setResultSheetExpanded(true);
  }, [status, result]);

  // KS-4257: bot-banner появляется в `.game-board-area` над верхним
  // player-bar и съедает ~34px высоты. Передаём флаг в хук, чтобы
  // расчёт `maxByHeight` учёл это и нижний ряд клеток не уходил
  // под нижний player-bar.
  const hasBotBanner = isBot && showBotBanner && !botBannerDismissed;
  // KS-4274: MobileBottomBar на ≤768px скрыт MainLayout'ом ТОЛЬКО на
  // `/game/<id>` (hideBottomBar = pathname.startsWith('/game/')). На
  // других страницах с GameShell (например `/play/local-bot`) bar
  // остаётся и забирает 56px+safe-area внизу — передаём в хук, чтобы
  // он вычел эту высоту из расчёта доски.
  const location = useLocation();
  const navigate = useNavigate();
  // KS-4295: если родитель явно не задал `onHelp`, но help-кнопка
  // включена (`showHelpButton=true`), используем тот же URL, что
  // и старая desktop-кнопка `<HelpButton section="play">`.
  const effectiveOnHelp =
    onHelp ?? (showHelpButton ? () => navigate('/features#play') : undefined);
  const hideMobileBottomBar = location.pathname.startsWith('/game/');
  const boardWidth = useResponsiveBoardSize({
    hasBotBanner,
    hideMobileBottomBar,
    // KS-4290 / ADR-134 §2: на mobile GameShell всегда рендерит
    // GameActionBar (sticky внизу 56 + safe-area-bottom). Хуку нужно
    // вычесть эту высоту, чтобы доска не уезжала за нижний край. На
    // desktop ≥900px компонент CSS-правилом скрыт, и `calculateBoardSize`
    // игнорирует `hasActionBar` (см. `isMobile && options.hasActionBar`).
    hasActionBar: true,
    // KS-4291 / ADR-134 §3: на mobile под доской также рендерится
    // компактная полоска ходов (32px). Аналогично — на desktop игнор.
    hasMoveStrip: true,
  });
  const [chatInput, setChatInput] = useState('');
  const [pendingPromotion, setPendingPromotion] = useState<
    { from: Square; to: Square } | null
  >(null);
  const [pendingPremove, setPendingPremove] = useState<
    { from: Square; to: Square; promotion?: GamePromotion } | null
  >(null);

  // Подсветка ходов / выбранной фигуры
  const onMoveForTouchRef = useRef<((from: Square, to: Square) => boolean) | undefined>(
    undefined,
  );
  const onMoveForTouch = useCallback(
    (from: Square, to: Square) =>
      onMoveForTouchRef.current ? onMoveForTouchRef.current(from, to) : false,
    [],
  );
  const {
    squareStyles: highlightStyles,
    onSquareClick,
    setLastMove,
    clearLastMove,
    clearSelection,
  } = useBoardHighlights({
    game: chess,
    playerColor,
    enabled: status === 'active',
    onMove: onMoveForTouch,
  });

  // Подсветка последнего хода и звук — из lastMove источника данных.
  // Сравниваем по ply, чтобы повторные ре-рендеры с тем же ходом
  // не плодили звук.
  const lastMoveKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lastMove) {
      clearLastMove();
      lastMoveKeyRef.current = null;
      return;
    }
    setLastMove(lastMove.from, lastMove.to);
    const key = `${lastMove.ply}:${lastMove.san}`;
    if (lastMoveKeyRef.current !== key) {
      lastMoveKeyRef.current = key;
      playSound(soundEventFromSan(lastMove.san));
    }
  }, [lastMove, setLastMove, clearLastMove, playSound]);

  // Сброс премува при завершении партии
  useEffect(() => {
    if (status !== 'active') setPendingPremove(null);
  }, [status]);

  // Применение премува, когда снова наш ход
  useEffect(() => {
    if (!enablePremove) return;
    if (!pendingPremove) return;
    if (status !== 'active') return;
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    if (turn !== playerColor) return;
    const { from, to, promotion } = pendingPremove;
    setPendingPremove(null);
    onMove(from, to, promotion);
  }, [fen, enablePremove, pendingPremove, status, chess, playerColor, onMove]);

  // Прокрутка чата вниз при новых сообщениях
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [chat?.messages]);

  // Прокрутка списка ходов вниз
  useEffect(() => {
    if (movesRef.current) {
      movesRef.current.scrollTop = movesRef.current.scrollHeight;
    }
  }, [moves]);

  // Адаптивная ширина сайдбара
  useLayoutEffect(() => {
    if (!gamePageRef.current) return;
    const total = gamePageRef.current.clientWidth;
    if (total === 0) return;
    setSidebarWidth(Math.min(320, Math.max(200, Math.floor(total * 0.25))));
  }, []);

  // KS-4151: CSS-переменная ширины доски — для адаптивной верстки
  // `.player-info { max-width: var(--board-area-height) }`. Раньше
  // была заведена через ResizeObserver на `boardAreaRef`, что давало
  // обратную связь: блок player-info менял ширину → менялась высота
  // board-area → ResizeObserver писал новое значение → ... доска
  // «дёргалась» при ходе. Сейчас источник — стабильная ширина доски
  // из `useResponsiveBoardSize`; обновляется только при ресайзе окна.
  useEffect(() => {
    const page = gamePageRef.current;
    if (!page || boardWidth <= 0) return;
    page.style.setProperty('--board-area-height', `${boardWidth}px`);
  }, [boardWidth]);

  // Обработка хода игрока: промоушен, премув, прямое применение
  const handleAttemptMove = useCallback(
    (from: Square, to: Square): boolean => {
      if (status !== 'active') return false;
      const turnColor = chess.turn() === 'w' ? 'white' : 'black';

      // Не наш ход — премув либо отказ
      if (turnColor !== playerColor) {
        if (!enablePremove) return false;
        const promotion = isPromotionAttempt(chess, from, to) ? 'q' : undefined;
        setPendingPremove({
          from,
          to,
          ...(promotion !== undefined && { promotion }),
        });
        return true;
      }

      // Промоушен пешки
      if (isPromotionAttempt(chess, from, to)) {
        const probe = new Chess(chess.fen());
        const probeMove = probe.move({ from, to, promotion: 'q' });
        if (!probeMove) return false;
        if (autoPromoteToQueen) {
          clearSelection();
          return onMove(from, to, 'q');
        }
        setPendingPromotion({ from, to });
        return true;
      }

      clearSelection();
      return onMove(from, to);
    },
    [status, chess, playerColor, enablePremove, autoPromoteToQueen, clearSelection, onMove],
  );
  onMoveForTouchRef.current = handleAttemptMove;

  const handlePromotionChoice = useCallback(
    (piece: GamePromotion) => {
      if (!pendingPromotion) return;
      onMove(pendingPromotion.from, pendingPromotion.to, piece);
      setPendingPromotion(null);
    },
    [pendingPromotion, onMove],
  );

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  const handleBoardContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setPendingPremove(null);
  }, []);

  // Drag-and-drop
  const handlePieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare) return false;
      return handleAttemptMove(
        sourceSquare as Square,
        targetSquare as Square,
      );
    },
    [handleAttemptMove],
  );
  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop: handlePieceDrop,
    boardOrientation: playerColor,
    enabled: status === 'active',
  });

  // Resizer сайдбара
  const handleResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      document.body.style.userSelect = 'none';
      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const total = gamePageRef.current?.clientWidth ?? 900;
        const next = Math.max(200, Math.min(total - 300, startWidth - delta));
        setSidebarWidth(next);
      };
      const onMouseUp = () => {
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [sidebarWidth],
  );

  // ─── Board options ─────────────────────────────────────────────
  const stablePosition = useStablePosition(fen);
  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );
  const premoveSquareStyles = useMemo(() => {
    if (!pendingPremove) return undefined;
    return {
      [pendingPremove.from]: { backgroundColor: 'rgba(0,120,255,0.4)' },
      [pendingPremove.to]: { backgroundColor: 'rgba(0,120,255,0.4)' },
    };
  }, [pendingPremove]);
  const mergedSquareStyles = useMemo(() => {
    const merged = { ...highlightStyles };
    if (premoveSquareStyles) Object.assign(merged, premoveSquareStyles);
    return merged;
  }, [highlightStyles, premoveSquareStyles]);

  const handleSquareClick = useCallback(
    ({ square }: { piece?: unknown; square: string }) =>
      onSquareClick(square as Square),
    [onSquareClick],
  );
  const handlePieceClick = useCallback(
    ({ square }: { isSparePiece?: boolean; piece?: unknown; square: string | null }) => {
      if (square) onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: playerColor,
      animationDurationInMs: suppressAnimationRef.current
        ? 0
        : isOpponentMove
          ? animationDuration
          : 0,
      allowDragging: false,
      showNotation,
      darkSquareStyle,
      lightSquareStyle,
      ...(!forceStandardPieces && customPieces && { pieces: customPieces }),
      ...(boardStyle && { boardStyle }),
      squareStyles: mergedSquareStyles,
      onSquareClick: handleSquareClick,
      onPieceClick: handlePieceClick,
    }),
    [
      stablePosition,
      playerColor,
      suppressAnimationRef,
      isOpponentMove,
      animationDuration,
      showNotation,
      darkSquareStyle,
      lightSquareStyle,
      customPieces,
      forceStandardPieces,
      boardStyle,
      mergedSquareStyles,
      handleSquareClick,
      handlePieceClick,
    ],
  );

  // ─── Производные данные результата ─────────────────────────────
  const opponentColor: GameColor = playerColor === 'white' ? 'black' : 'white';
  const playerRatingBefore = ratingChange
    ? playerColor === 'white'
      ? ratingChange.whiteRatingBefore
      : ratingChange.blackRatingBefore
    : null;
  const playerRatingAfter = ratingChange
    ? playerColor === 'white'
      ? ratingChange.whiteRatingAfter
      : ratingChange.blackRatingAfter
    : null;
  const ratingDiff =
    playerRatingBefore != null && playerRatingAfter != null
      ? playerRatingAfter - playerRatingBefore
      : null;

  const renderResultActions = (showAnalyzeTestId: 'side' | 'modal') => (
    <>
      {canRematch && onRematch && (
        <button
          type="button"
          className="result-btn"
          onClick={onRematch}
          disabled={rematchPending}
        >
          {rematchPending
            ? t('gameResult.rematchSent', 'Sent...')
            : t('gameResult.rematch', 'Rematch')}
        </button>
      )}
      {tournamentReturn ? (
        <Link
          to={tournamentReturn.to}
          className="result-btn result-btn-primary"
        >
          {tournamentReturn.label}
        </Link>
      ) : (
        <>
          {newGameLink && (
            <Link to={newGameLink.to} className="result-btn">
              {newGameLink.label}
            </Link>
          )}
          {onNewGame && (
            <button
              type="button"
              className="result-btn"
              data-testid={
                showAnalyzeTestId === 'modal'
                  ? 'game-new-game'
                  : 'game-new-game-side'
              }
              onClick={onNewGame}
            >
              {newGameLabel ?? t('gameResult.newGame', 'New game')}
            </button>
          )}
          {showAnalyzeButton && onAnalyze && (
            <button
              type="button"
              className="result-btn result-btn-primary"
              data-testid={
                showAnalyzeTestId === 'modal'
                  ? 'game-result-analyze'
                  : 'game-result-analyze-side'
              }
              onClick={onAnalyze}
            >
              {t('gameResult.openInAnalysis', 'Open in analysis')}
            </button>
          )}
          {homeLink && (
            <Link to={homeLink.to} className="result-btn">
              {homeLink.label}
            </Link>
          )}
        </>
      )}
    </>
  );

  const opponentBerserk =
    opponentColor === 'white' ? whiteBerserk : blackBerserk;
  const selfBerserk = playerColor === 'white' ? whiteBerserk : blackBerserk;

  return (
    <div className="game-page" ref={gamePageRef}>
      {/* KS-4259: убран рендер `.back-nav-link` — обрезанная плашка
          «← в лобби» в левом верхнем углу перекрывалась основной
          sidebar навигацией. Возврат в лобби доступен через
          основной sidebar / settings dropdown. Prop `backLink`
          оставлен в типах для обратной совместимости вызывающих
          компонентов (GamePage и др.) — рендер просто опущен. */}
      {showHelpButton && <HelpButton section="play" />}

      <div className="game-board-area" ref={boardAreaRef}>
        {isBot && showBotBanner && !botBannerDismissed && (
          <div className="bot-fallback-banner">
            <span>
              {t(
                'game.botFallback',
                'You are playing against a bot. While few players are online, a bot replaces your opponent.',
              )}
            </span>
            <button onClick={() => setBotBannerDismissed(true)}>&times;</button>
          </div>
        )}

        <div className="player-info opponent-info">
          <span className={`color-indicator ${opponentColor}`} />
          <span className="player-name">
            {opponentBerserk && <span title="Berserk">⚡</span>}
            {players[opponentColor] || opponentColor}
            {isBot && botLevel != null && (
              <span className="bot-level"> (Lv. {botLevel})</span>
            )}
          </span>
          <span className="clock">
            {hideClocks ? '—' : formatTime(clocks[opponentColor])}
          </span>
          {/* KS-4293 / ADR-134 §4: уведомление о новом сообщении
              соперника у верхнего края соперника-bar. Появляется
              при status='active' и закрытой панели чата (родитель
              сам отвечает за установку `chatToast` только в этих
              условиях, см. useEffect выше). */}
          <GameChatToast
            message={chatToast}
            onTimeout={() => setChatToast(null)}
            onClick={() => setChatSheetOpen(true)}
          />
        </div>

        <div
          className="board-container"
          ref={boardContainerRef}
          style={boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined}
          onContextMenu={handleBoardContextMenu}
        >
          <MemoChessboard options={boardOptions} />
          <PromotionPicker
            pending={pendingPromotion}
            color={playerColor === 'white' ? 'w' : 'b'}
            onChoice={handlePromotionChoice}
            onCancel={handlePromotionCancel}
            testId="game-promotion-overlay"
          />
          {/* KS-4292 / ADR-134 §6: pre-game placeholder поверх доски.
              Показывается только на mobile (CSS-правило прячет на
              desktop), и только после 1.5 с в `status='waiting'`. CSS
              также бледнит саму доску через `.board-container:has(...)`
              для браузеров с поддержкой `:has()`; на остальных доска
              остаётся как есть (overlay сам по себе достаточно
              акцентирует ожидание). */}
          {showWaitingOverlay && (
            <GameWaitingOverlay mode={mode} timeControl={timeControl} />
          )}
        </div>

        <div className="player-info player-info-self">
          <span className={`color-indicator ${playerColor}`} />
          <span className="player-name">
            {selfBerserk && <span title="Berserk">⚡</span>}
            {players[playerColor] || playerColor}
          </span>
          <span className="clock">
            {hideClocks ? '—' : formatTime(clocks[playerColor])}
          </span>
        </div>

        {belowBoardBlock}

        {/* KS-4291 / ADR-134 §3: компактная горизонтальная полоска
            ходов под доской, видна только на mobile (CSS-правило в
            `game.css` скрывает её на ≥900px). На desktop пользователь
            видит обычную `.move-list` в `.game-sidebar`. */}
        <GameMoveStrip moves={moves} />
      </div>

      <div className="game-h-resizer" onMouseDown={handleResizerMouseDown} />

      <div className="game-sidebar" style={{ width: sidebarWidth }}>
        <div className="move-list">
          <h3>{t('game.moves')}</h3>
          <div className="moves game-moves-inline" ref={movesRef}>
            {moves.flatMap((move, i) => {
              const isWhite = i % 2 === 0;
              const moveNumber = Math.floor(i / 2) + 1;
              const display = isWhite ? `${moveNumber}.${move}` : move;
              const isLast = i === moves.length - 1;
              return [
                <span
                  key={i}
                  className={`game-move-item${isLast ? ' current' : ''}`}
                >
                  {display}
                </span>,
                ' ',
              ];
            })}
          </div>
        </div>

        <div className="game-actions-top">
          <button
            className={`mute-toggle${muted ? ' muted' : ''}`}
            onClick={toggleMute}
            title={muted ? t('game.unmute') : t('game.mute')}
            aria-label={muted ? t('game.unmute') : t('game.mute')}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>

        {status === 'active' && (
          <div className="game-actions">
            {showBerserkButton && onBerserk && (
              <button
                onClick={onBerserk}
                style={{
                  background: 'var(--c-f59e0b)',
                  color: 'var(--c-1a1a2e)',
                  fontWeight: 'bold',
                  borderRadius: 4,
                }}
                title={t(
                  'game.berserkHint',
                  'Halve your clock for a bonus point if you win',
                )}
              >
                ⚡ Berserk
              </button>
            )}
            {canOfferDraw && drawOffered ? (
              <div className="draw-offer">
                <p>{t('game.drawOffered')}</p>
                <button onClick={onDrawAccept}>{t('game.accept')}</button>
                <button onClick={onDrawDecline}>{t('game.decline')}</button>
              </div>
            ) : (
              <>
                {canOfferDraw && onDrawOffer && (
                  <button onClick={onDrawOffer}>{t('game.offerDraw')}</button>
                )}
                {canResign && onResign && (
                  <button
                    onClick={onResign}
                    data-testid="game-resign"
                  >
                    {t('game.resign')}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {status === 'finished' && result && !showResultModal && (
          <div className="game-result">
            <h3>{t('game.finished')}</h3>
            <p>
              {result === 'draw'
                ? t('game.draw')
                : result === 'white'
                  ? t('game.whiteWins')
                  : t('game.blackWins')}
            </p>
            {ratingChange && (
              <div className="game-result-rating">
                <span className="rating-before">{playerRatingBefore}</span>
                <span className="rating-arrow">&rarr;</span>
                <span className="rating-after">{playerRatingAfter}</span>
                <span
                  className={`rating-diff ${
                    ratingDiff! > 0
                      ? 'positive'
                      : ratingDiff! < 0
                        ? 'negative'
                        : ''
                  }`}
                >
                  ({ratingDiff! > 0 ? '+' : ''}
                  {ratingDiff})
                </span>
              </div>
            )}
            <div className="game-result-actions">
              {renderResultActions('side')}
            </div>
          </div>
        )}

        {chat && (
          <div className="chat">
            <h3>{t('game.chat')}</h3>
            <div className="chat-messages">
              {chat.messages.map((msg, i) => (
                <div
                  key={i}
                  className={`chat-msg ${msg.userId === chat.currentUserId ? 'own' : ''}`}
                >
                  <strong>{msg.username}</strong>: {msg.content}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="chat-input">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && chatInput.trim()) {
                    chat.onSend(chatInput.trim());
                    setChatInput('');
                  }
                }}
                placeholder={t('game.chatPlaceholder')}
              />
              <button
                onClick={() => {
                  if (chatInput.trim()) {
                    chat.onSend(chatInput.trim());
                    setChatInput('');
                  }
                }}
              >
                {t('game.chatSend')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* KS-4288 / ADR-134 §1: bottom-sheet результата на mobile.
          Рендерим параллельно с модальным окном при `status === 'finished'`;
          видимость разделена CSS: на `max-width: 899px` модальное
          окно и встроенный `.game-result` скрыты, sheet виден; на
          desktop — наоборот. Источник набора действий
          (`renderResultActions`) общий — кнопки не дублируются.
          Свёрнутая полоска временно живёт отдельно — после KS-4289
          её место переедет внутрь нижней панели действий. */}
      {status === 'finished' && result && (
        <div className="game-result-sheet-wrapper" aria-hidden={!showResultModal}>
          <GameResultSheet
            outcome={
              result === 'draw'
                ? 'draw'
                : (result === 'white' && playerColor === 'white') ||
                    (result === 'black' && playerColor === 'black')
                  ? 'win'
                  : 'loss'
            }
            title={
              result === 'draw'
                ? t('game.draw')
                : (result === 'white' && playerColor === 'white') ||
                    (result === 'black' && playerColor === 'black')
                  ? t('gameResult.victory')
                  : t('gameResult.defeat')
            }
            detail={
              result === 'draw'
                ? t('game.draw')
                : result === 'white'
                  ? t('game.whiteWins')
                  : t('game.blackWins')
            }
            ratingBlock={
              ratingChange ? (
                <div className="rating-change-display">
                  <span className="rating-before">{playerRatingBefore}</span>
                  <span className="rating-arrow">&rarr;</span>
                  <span className="rating-after">{playerRatingAfter}</span>
                  <span
                    className={`rating-diff ${
                      ratingDiff! > 0
                        ? 'positive'
                        : ratingDiff! < 0
                          ? 'negative'
                          : ''
                    }`}
                  >
                    {ratingDiff! > 0 ? '+' : ''}
                    {ratingDiff}
                  </span>
                </div>
              ) : null
            }
            actions={renderResultActions('modal')}
            // KS-4290: на mobile клик по подложке сворачивает sheet в
            // pill, который появится в `GameActionBar` — задача
            // показать пользователю, что результат можно вернуть
            // обратно. Модальное окно на desktop — это отдельный блок
            // ниже, у него свой `onCloseResultModal`; здесь sheet
            // полностью скрыт через CSS, поэтому подменой колбэка
            // десктоп-поведение не затрагивается.
            onCloseOverlay={() => setResultSheetExpanded(false)}
            expanded={resultSheetExpanded}
            onExpandedChange={setResultSheetExpanded}
          />
        </div>
      )}

      {/* KS-4290 / ADR-134 §2: sticky action-bar для мобильной вёрстки.
          На desktop ≥900px скрыт CSS-правилом (`.game-action-bar`
          `display: none` по умолчанию, `display: flex` в @media
          `max-width: 899px`). Старые inline `.game-actions` и
          `.game-actions-top` на mobile тоже скрыты — действия партии
          живут только здесь. На finished — pill «Партия завершена ▲»,
          по клику разворачивает `GameResultSheet`. */}
      <GameActionBar
        status={status}
        canResign={status === 'active' && canResign && !!onResign}
        onResign={onResign}
        canOfferDraw={status === 'active' && canOfferDraw && !drawOffered}
        onOfferDraw={onDrawOffer}
        muted={muted}
        onToggleMute={toggleMute}
        resultPillLabel={
          status === 'finished' && result
            ? result === 'draw'
              ? t('game.draw')
              : (result === 'white' && playerColor === 'white') ||
                  (result === 'black' && playerColor === 'black')
                ? t('gameResult.victory')
                : t('gameResult.defeat')
            : undefined
        }
        onExpandResult={
          status === 'finished' && !resultSheetExpanded
            ? () => setResultSheetExpanded(true)
            : undefined
        }
        onCancelSearch={onCancelSearch}
        onChatClick={chat ? () => setChatSheetOpen(true) : undefined}
        chatUnreadCount={chatUnreadCount}
        onHelp={effectiveOnHelp}
      />

      {/* KS-4293 / ADR-134 §4: нижняя панель чата на mobile. Рендерим
          всегда — `GameChatSheet` сам возвращает null при `open=false`.
          На desktop ≥900px CSS прячет панель через `.game-chat-sheet-
          overlay { display: none }`. */}
      {chat && (
        <GameChatSheet
          open={chatSheetOpen}
          onClose={() => setChatSheetOpen(false)}
          chat={chat}
        />
      )}

      {showResultModal && status === 'finished' && result && (
        <div
          className="game-result-modal-overlay"
          onClick={onCloseResultModal}
        >
          <div
            className="game-result-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`result-modal-header ${
                result === 'draw'
                  ? 'draw'
                  : (result === 'white' && playerColor === 'white') ||
                      (result === 'black' && playerColor === 'black')
                    ? 'win'
                    : 'loss'
              }`}
            >
              <h2>
                {result === 'draw'
                  ? t('game.draw')
                  : (result === 'white' && playerColor === 'white') ||
                      (result === 'black' && playerColor === 'black')
                    ? t('gameResult.victory')
                    : t('gameResult.defeat')}
              </h2>
            </div>
            <div className="result-modal-body">
              <p className="result-modal-detail">
                {result === 'draw'
                  ? t('game.draw')
                  : result === 'white'
                    ? t('game.whiteWins')
                    : t('game.blackWins')}
              </p>
              {ratingChange && (
                <div className="result-modal-rating">
                  <span className="rating-label">{t('gameResult.rating')}</span>
                  <div className="rating-change-display">
                    <span className="rating-before">{playerRatingBefore}</span>
                    <span className="rating-arrow">&rarr;</span>
                    <span className="rating-after">{playerRatingAfter}</span>
                    <span
                      className={`rating-diff ${
                        ratingDiff! > 0
                          ? 'positive'
                          : ratingDiff! < 0
                            ? 'negative'
                            : ''
                      }`}
                    >
                      {ratingDiff! > 0 ? '+' : ''}
                      {ratingDiff}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="result-modal-actions">
              {renderResultActions('modal')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
