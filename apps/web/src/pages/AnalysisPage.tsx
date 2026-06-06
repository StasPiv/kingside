import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  useParams,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAiPositionComment } from '../hooks/useAiPositionComment';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { GameMetaInfo } from '../components/GameMetaBar';
import { EngineSettingsModal } from '../components/EngineSettingsModal';
import { SetPositionModal } from '../components/SetPositionModal';
import { PgnHeadersModal } from '../components/PgnHeadersModal';
import { useStablePosition } from '../hooks/useStablePosition';
import type { EvalLine } from '../hooks/useStockfish';
import { clampMultiPvToLegalMoves } from '../hooks/useStockfish';
import { useEngine } from '../hooks/useEngine';
import type { EngineSource } from '../hooks/useEngine';
// KS-3597 (ADR-099 F2): Maia top-N + sort-режим на уровне страницы.
import { useMaiaAnalysis } from '../hooks/useMaiaAnalysis';
import { useEngineSortMode } from '../hooks/useEngineSortMode';
import { useEngineConfig } from '../hooks/useEngineConfig';
import { useContainerSize } from '../hooks/useContainerSize';
import { useFastDrag } from '../hooks/useFastDrag';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBoardSettings, BOARD_SIZES } from '../hooks/useBoardSettings';
import { useBoardHighlights, LAST_MOVE_COLOR } from '../hooks/useBoardHighlights';
import { HIGHLIGHT_COLORS, annotationColorByModifiers } from '../hooks/useSquareHighlights';
import type { AnnotationColor, ArrowAnnotation, NodeAnnotations, SquareHighlight } from '../review/types';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import {
  ShareAnalysisButton,
  type ShareAnalysisButtonHandle,
} from '../components/analysis/ShareAnalysisButton';
import { useReviewState } from '../review/useReviewState';
import { useAnalysisPersistenceResolver } from './analysis/useAnalysisPersistenceResolver';
// KS-2281 (E5 deferred): localStorage autosave для ad-hoc /analysis,
// чтобы NAG-аннотации не терялись при reload страницы.
import { useAdHocAnalysisAutosave } from '../hooks/useAdHocAnalysisAutosave';
import type { ChessMove } from '../review/types';
import { parseAnnotatedPgn, extractInitialAnnotations } from '../review/utils/PgnDeserializer';
import { classifyOpening } from '../utils/ecoClassify';
import { formatEval, formatCompact } from '../utils/chessFormat';
import { parseInitialPly } from './utils/initialPly';
import { searchInHistory, findGlobalIndexByFen } from '../review/utils/ChessHistoryUtils';
import { useSavedAnalyses, getDefaultTitle, parsePgnHeaders } from '../hooks/useSavedAnalyses';
// KS-3299 (M2 F5): создание репертуара из анализа.
import { openingTrainerApi } from '../api/openingTrainerApi';
// KS-3331 (ADR-078 §5.3): добавить анализ в существующий репертуар.
import { AddToRepertoireModal } from './openingTrainer/AddToRepertoireModal';
import type {
  OpeningRepertoireDto,
  OpeningRepertoireWithStatsDto,
} from '@kingside/shared';
import { ApiError as ApiErrorClass } from '../ApiError';
import { serializeToAnnotatedPgn } from '../review/utils/PgnSerializer';
// KS-2863 (ADR-060 §10.1 FR1): извлечённый header — workshop-shortcut +
// breadcrumbs + inline-edit title. State (isEditingTitle, titleInput,
// handlers) остаётся в AnalysisPage, передаётся через props.
import { AnalysisHeader } from './analysis/AnalysisHeader';
// KS-3736 / ADR-110: live-трансляция анализа партии — кнопка «Транслировать»,
// индикатор статуса, восстановление режима при reload.
// KS-3755 / ADR-112: управление трансляцией перенесено в
// AnalysisActionsMenu (под доской). От прежнего верхнего блока
// `LiveBroadcastControl` осталась только тонкая обёртка-индикатор
// `LiveBroadcastBadge`: «В эфире · N зрителей» + тосты «Ссылка
// скопирована» / ошибки.
import { LiveBroadcastBadge } from '../components/analysis/LiveBroadcastBadge';
import { useAnalysisLiveBroadcast } from '../hooks/useAnalysisLiveBroadcast';
// KS-3747 / ADR-111 §7: проп `liveSession` — AnalysisPage становится
// просмотрщиком трансляции (mode='viewer') или подключается к ней как
// автор (mode='owner', фактическое использование — KS-3748). Хук тот же
// (`useLiveAnalysisBroadcast`), что и в KS-3746. Прежнее имя
// `liveBroadcast` уже занято в этом файле под другую сущность
// (`useAnalysisLiveBroadcast` из KS-3736 — стартер/state-машина блока
// «Транслировать» автора), переиспользовать имя нельзя.
import { useLiveAnalysisBroadcast } from '../hooks/useLiveAnalysisBroadcast';
// KS-2958: переиспользуем основной `PuzzleGeneratorModal` с пропами
// `initialPgn` + `autoStart` — то же окно с прогрессом и пост-flow
// (My drafts / Publish all), что и в разделе «Тренировка точности».
import { PuzzleGeneratorModal } from '../components/PuzzleGeneratorModal';
// KS-3421 (ADR-087 §8 F1): единое меню действий с двумя режимами
// (dropdown / bottom-sheet) и общим items-source. Активируется
// build-time гейтом `ANALYSIS_ACTIONS_MENU_V2_ENABLED`.
import {
  AnalysisActionsMenu,
  type AnalysisActionItem,
} from '../components/analysis/AnalysisActionsMenu';
import { ANALYSIS_ACTIONS_MENU_V2_ENABLED } from '../config/analysisActionsMenu';
// KS-3606 (ADR-100 §9): «Разобрать партию» теперь пункт в
// AnalysisActionsMenu, а не отдельная кнопка в engine-panel.
import { useGameReviewLauncher } from '../components/analysis/useGameReviewLauncher';
// KS-3471 (ADR-090 V4 F1): модалка movetime для «репертуар из мастер-партий 2400+».
import {
  ArchiveRepertoireMovetimeModal,
  type ArchiveRepertoireMovetime,
} from '../components/analysis/ArchiveRepertoireMovetimeModal';
// KS-3472 (ADR-090 V4 F2): монолитный поток + progress-modal.
import { useRepertoireFromArchive } from '../components/analysis/useRepertoireFromArchive';
import { RepertoireFromArchiveProgress } from '../components/analysis/RepertoireFromArchiveProgress';
// KS-2864 (ADR-060 §10.1 FR2): извлечённый board-area — GameMetaBar +
// EvalBar + Chessboard + promotion-overlay + VariationChooser.
// useFastDrag остаётся в AnalysisPage (привязан к тому же ref).
import { AnalysisBoard } from './analysis/AnalysisBoard';
// KS-2866 (ADR-060 §10.1 FR3): извлечённый sidebar — engine-panel +
// archive tree + ReviewMoveList + mobile tabs. На FR4 большая часть
// props переедет в AnalysisContext.
import { AnalysisSidebar } from './analysis/AnalysisSidebar';
import {
  composeArrowLayers,
  mergeSquareStyleLayers,
  omitLastMoveIfAiOverlayActive,
} from './analysis/aiOverlayMerge';
import { panelToggleReducer } from './analysis/accordionTogglePanel';
// KS-2867 (ADR-060 §3.1 FR4): единый источник «что мы открываем» —
// discriminated union review/analysis/puzzle. Заменяет разбросанные
// `params.id`/`params.gameId`/`puzzleFen`/`localId` производные.
// ADR-067 (KS-3131): ветка `kind='study'` удалена в KS-3014, упоминания
// зачищены здесь.
import { useAnalysisContext } from './analysis/AnalysisContext';
// KS-3198: NavButton с long-press авто-повтором — заменяет inline
// <button> для ⇤ ← → ⇥ в `.analysis-board-controls`.
import { NavButton } from './analysis/NavButton';
type GameData = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  status: string;
  whiteRatingBefore?: number | null;
  blackRatingBefore?: number | null;
  ratingChange?: {
    whiteRatingBefore: number;
    whiteRatingAfter: number;
    blackRatingBefore: number;
    blackRatingAfter: number;
  };
};

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function buildPgnWithFen(moves: string, fen: string, headers?: Record<string, string>): string {
  const parts: string[] = [];
  if (headers) {
    // Standard PGN header order
    for (const key of ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'WhiteTitle', 'BlackTitle', 'ECO', 'Opening']) {
      if (headers[key] && headers[key] !== '?' && headers[key] !== '????.??.??') {
        parts.push(`[${key} "${headers[key]}"]`);
      }
    }
  }
  if (fen !== DEFAULT_FEN) {
    // KS-2828: `[SetUp "1"]` обязательная пара к `[FEN]` по PGN-стандарту
    // (§9.7.3). Без него внешние парсеры могут игнорировать FEN-header.
    parts.push(`[SetUp "1"]`);
    parts.push(`[FEN "${fen}"]`);
  }
  if (parts.length > 0) {
    return parts.join('\n') + '\n\n' + moves;
  }
  return moves;
}

type MoveData = {
  san: string;
  uci: string;
  fenAfter: string;
};

/**
 * KS-2403: внешняя обёртка-роут пересоздаёт `AnalysisPageInner` при
 * каждой смене `:id` / `:gameId` через `key={id ?? gameId}`. Это
 * гарантирует unmount + mount, а не просто rerender — никакой
 * stale-state (history, annotations, evaluation result, ply, FEN,
 * локальные refs/caches) не выживает на route change. Образец —
 * KS-2375 (ArchiveGamePage). Без этого React переиспользовал один
 * экземпляр `AnalysisPage` между разными :id, и пользователь видел
 * «ту же партию» при открытии анализа из разных мест.
 *
 * Для роута `/analysis` (без id) — fallback `'__none__'`, чтобы при
 * переходе с `/analysis/UUID` на `/analysis` тоже произошёл remount.
 */
/**
 * KS-2672: один компонент рендерит три режима:
 *  - owner (auth) — полная фукнциональность (Share, Edit, autosave).
 *  - viewer (auth, не-owner) — read-only по `isPublic=true`.
 *  - anonymous (без auth) — read-only по public-эндпоинту.
 *
 * Маршрут `/analysis/public/:id` передаёт `publicMode=true`, тогда
 * данные грузятся через `GET /analyses/public/:id` (без auth) и
 * мутации (autosave, title-edit, position update) выключены. Для
 * залогиненного владельца, открывшего public-URL своего же анализа,
 * UI остаётся read-only — это упрощает логику; чтобы редактировать,
 * автор должен зайти на обычный `/analysis/:id`.
 */
interface AnalysisPageProps {
  publicMode?: boolean;
  /**
   * KS-3182 (ADR-072 §7 F2): embedded-режим — AnalysisPage встроен в
   * другой контейнер (шаг урока «Партия»). Поведение:
   *  - PGN приходит из `embeddedPgn` пропа, а не из URL/state/БД;
   *  - все мутации/persistence выключены (трактуем как `publicMode=true`
   *    внутри: autosave, share, edit-title, position-update, fetch by id
   *    подавлены теми же гейтами, что и в публичном режиме);
   *  - `<AnalysisHeader>` (breadcrumb + title-edit) и overflow-меню
   *    (Share / Export / Import) НЕ рендерятся — авторам шага не нужны;
   *  - сайдбар, дерево вариантов, opening explorer и Stockfish работают
   *    как обычно (read-only консистентно с publicMode).
   */
  embedded?: boolean;
  embeddedPgn?: string;
  /**
   * KS-3747 (ADR-111 §7): подключение страницы анализа к live-
   * трансляции «full» (с PGN-деревом, а не только UCI-лентой).
   *
   *  - `mode: 'viewer'` — источник PGN не REST/state, а live `pgn` из
   *    `useLiveAnalysisBroadcast`. Каждый `sync`/`state-patch` от
   *    автора применяется через `loadFromPgn`, при этом критично
   *    сохраняется текущая позиция зрителя в дереве (ADR-111 §2.8 п.5):
   *    после загрузки нового PGN ищем узел с тем же FEN и переходим
   *    на него. Owner-only UI (`autosave`, `Share`, `edit-title`,
   *    «Транслировать», `Set Position`, `Game Info`) подавлен через
   *    `publicMode || isViewerLive` + явный гейт пунктов меню.
   *    ArchiveTreePanel, Stockfish, AI продолжают работать локально
   *    у зрителя (они привязаны к currentFen — а он валиден всегда).
   *  - `mode: 'owner'` — подключение к хуку для последующего эмита
   *    state-patch при изменениях review-state. Фактическое
   *    использование — KS-3748; здесь только готовится почва.
   */
  liveSession?: { slug: string; mode: 'viewer' | 'owner' };
}

/**
 * KS-3421 (ADR-087 §8 F1). Сборка items-source для нового
 * AnalysisActionsMenu из контекста AnalysisPage. Один источник правды
 * по 10 пунктам в 4 группах:
 *   gamePosition: setPosition (FEN), gameInfo, findByPosition
 *   pgn:          exportPgn, copyPgn
 *   training:     generatePuzzle, guessMoves, useAsRepertoire, addToExistingRepertoire
 *   sharing:      share
 *
 * Auth-gating для гостя (вариант Б из ADR-087): пункты, требующие
 * `user`, не скрываются — рендерятся `disabled + hint` «Войдите».
 * Для зарегистрированных НЕ-владельцев чужого анализа пункты
 * по-прежнему скрываются (`visible: false`) — раздавать чужой Share
 * и create-from-foreign-repertoire бессмысленно.
 */
type BuildItemsContext = {
  t: (key: string, def?: string) => string;
  gameId: string | undefined;
  navigate: (to: string, opts?: { state?: unknown }) => void;
  currentFen: string;
  historyLen: number;
  kind: 'analysis' | 'review' | 'puzzle';
  publicMode: boolean;
  user: { id: string } | null;
  localIdRef: { current: string | null };
  savedOwnerId: string | null;
  creatingRepertoire: boolean;
  repertoires: ReadonlyArray<OpeningRepertoireWithStatsDto> | null;
  repertoiresLoading: boolean;
  analysisTitle: string;
  buildAnalysisPgn: () => string | null;
  handleExportPgn: () => void;
  handleCopyPgn: () => Promise<void> | void;
  setShowSetPosition: (v: boolean) => void;
  setShowPgnHeaders: (v: boolean) => void;
  /**
   * KS-3747 (ADR-111 §7): зрительский live-режим. Подавляет пункты,
   * которые трогают авторитетное состояние трансляции
   * (`set-position`, `game-info`-edit). Остальные owner-only пункты
   * (autosave, Share, edit-title) уже скрыты гейтом `publicMode`
   * (он принудительно true для viewer-live в `AnalysisPageInner`).
   */
  liveViewer: boolean;
  setPuzzleGenPgn: (pgn: string) => void;
  setShowPuzzleGen: (v: boolean) => void;
  setSidePickerOpen: (v: boolean) => void;
  setAddToRepertoireOpen: (v: boolean) => void;
  shareButtonRef: { current: ShareAnalysisButtonHandle | null };
  /**
   * KS-3471 (ADR-090 V4 F1): открыть модалку выбора movetime для
   * «репертуар из мастер-партий 2400+». Гостю пункт виден disabled+
   * tooltip (auth-only по ADR-087 §8, вариант Б).
   */
  openArchiveRepertoireModal: () => void;
  /**
   * KS-3606 (ADR-100 §9). Пункт меню «Разобрать партию» — handler
   * берётся от `useGameReviewLauncher` (см. AnalysisPage). disabled
   * флаг и tooltip также подаются из hook'а (там же логика «дубль /
   * пустая партия / running»).
   */
  onRunGameReview: () => void;
  gameReviewDisabled: boolean;
  gameReviewDisabledHint: string | undefined;
  /**
   * KS-3755 (ADR-112): live-трансляция анализа. Управление перенесено
   * из верхнего LiveBroadcastControl в эту группу пунктов меню.
   * Источник state — `useAnalysisLiveBroadcast`; обработчики — caller.
   * Гейт видимости пунктов — `!publicMode && user` (только владелец
   * на своей странице); внутри — kind-aware ветки (см. buildItems).
   */
  liveAnalysisId: string | null;
  liveIsLive: boolean;
  liveIsStarting: boolean;
  // KS-3771: счётчик зрителей убран из UI (см. broadcast-status пункт).
  livePublicUrl: string | null;
  onLiveStart: () => void;
  onLiveSaveAndStart: () => void;
  onLiveCopyLink: () => void | Promise<void>;
  onLiveStop: () => void;
};

function buildAnalysisActionsItems(
  ctx: BuildItemsContext,
): AnalysisActionItem[] {
  const {
    t,
    gameId,
    navigate,
    currentFen,
    historyLen,
    kind,
    publicMode,
    user,
    localIdRef,
    savedOwnerId,
    creatingRepertoire,
    repertoires,
    repertoiresLoading,
    analysisTitle,
    buildAnalysisPgn,
    handleExportPgn,
    handleCopyPgn,
    setShowSetPosition,
    setShowPgnHeaders,
    liveViewer,
    setPuzzleGenPgn,
    setShowPuzzleGen,
    setSidePickerOpen,
    setAddToRepertoireOpen,
    shareButtonRef,
    openArchiveRepertoireModal,
    onRunGameReview,
    gameReviewDisabled,
    gameReviewDisabledHint,
    liveAnalysisId,
    liveIsLive,
    liveIsStarting,
    livePublicUrl,
    onLiveStart,
    onLiveSaveAndStart,
    onLiveCopyLink,
    onLiveStop,
  } = ctx;

  const isOwner =
    !!user && !publicMode && !!localIdRef.current && savedOwnerId === user.id;
  // Guest = нет user. Для зарегистрированного не-владельца скрываем
  // owner-only пункты целиком; для гостя — disabled+tooltip (вариант Б).
  const isGuest = !user;
  const guestDisabledHint = t(
    'analysis.actionsMenu.signInHint',
    'Sign in to use this action.',
  );
  const emptyHistory = historyLen === 0;
  const items: AnalysisActionItem[] = [];

  // — gamePosition —
  // KS-3747: для зрителя live-трансляции set-position и game-info
  // подавлены — эти модалки меняют локальное состояние, которое в
  // viewer-режиме перезапишется следующим sync'ом от автора, и юзер
  // подумает что «не сохранилось». Find-by-position остаётся — это
  // навигация в архив, безопасно.
  if (!gameId && !liveViewer) {
    items.push({
      id: 'set-position',
      group: 'gamePosition',
      label: `${t('position.title', 'Set Position')} (FEN)`,
      onClick: () => setShowSetPosition(true),
    });
    items.push({
      id: 'game-info',
      group: 'gamePosition',
      label: t('analysis.gameInfo', 'Game Info'),
      onClick: () => setShowPgnHeaders(true),
    });
  }
  items.push({
    id: 'find-by-position',
    group: 'gamePosition',
    label: t('analysis.findByPosition', 'Find games with this position'),
    onClick: () =>
      navigate(`/archive?fen=${encodeURIComponent(currentFen)}&sort=topElo`),
  });

  // — pgn —
  items.push({
    id: 'export-pgn',
    group: 'pgn',
    label: t('review.exportPgn', 'Export PGN'),
    onClick: () => handleExportPgn(),
    disabled: emptyHistory,
  });
  items.push({
    id: 'copy-pgn',
    group: 'pgn',
    label: t('review.copyPgn', 'Copy PGN to clipboard'),
    onClick: () => void handleCopyPgn(),
    disabled: emptyHistory,
  });

  // — training —
  // KS-3606 (ADR-100 §9): «Разобрать партию» — авто-NAG через
  // SF+Maia, создаёт дубль через backend. Disabled если уже на
  // дубле или партия пуста (логика в `useGameReviewLauncher`).
  items.push({
    id: 'analyze-game',
    group: 'training',
    label: t('analysis.review.runCta', 'Analyze game'),
    onClick: onRunGameReview,
    disabled: gameReviewDisabled,
    disabledHint: gameReviewDisabledHint,
  });
  if (kind === 'analysis' || kind === 'review') {
    items.push({
      id: 'generate-puzzle',
      group: 'training',
      label: t('analysis.generatePuzzle', 'Generate puzzle'),
      onClick: () => {
        const pgn = buildAnalysisPgn();
        if (!pgn) return;
        setPuzzleGenPgn(pgn);
        setShowPuzzleGen(true);
      },
      disabled: emptyHistory,
    });
  }
  items.push({
    id: 'guess-moves',
    group: 'training',
    label: t('analysis.guessMoves', 'Guess the moves'),
    onClick: () => {
      const pgn = buildAnalysisPgn();
      if (!pgn) return;
      navigate('/guess', {
        state: { pgn, title: analysisTitle || undefined },
      });
    },
    disabled: emptyHistory,
  });
  // KS-3471 (ADR-090 V4 F1): «Создать репертуар из мастер-партий 2400+».
  // Auth-only по варианту Б (disabled+tooltip гостю). Доступен на любой
  // позиции, для которой есть FEN — historyLen может быть 0 (стартовая
  // позиция). Backend B2 (KS-3469) сам решает «нет партий» через 0 items.
  items.push({
    id: 'archive-position-repertoire',
    group: 'training',
    label: t(
      'analysis.archiveRepertoire.menuItem',
      'Create repertoire from master games 2400+',
    ),
    onClick: openArchiveRepertoireModal,
    disabled: isGuest,
    disabledHint: isGuest ? guestDisabledHint : undefined,
  });
  // Auth-only пункты: useAs / addTo / share.
  if (kind === 'analysis' && historyLen > 0 && !publicMode) {
    const useAsVisible = isGuest || isOwner;
    if (useAsVisible) {
      items.push({
        id: 'use-as-repertoire',
        group: 'training',
        label: creatingRepertoire
          ? t('analysis.useAsRepertoire.creating', 'Creating…')
          : t('analysis.useAsRepertoire.menuItem', 'Use as new repertoire'),
        onClick: () => setSidePickerOpen(true),
        disabled: isGuest || creatingRepertoire,
        disabledHint: isGuest ? guestDisabledHint : undefined,
      });
    }
    const addToVisible = isGuest || isOwner;
    if (addToVisible) {
      const emptyRepertoires =
        repertoires !== null && repertoires.length === 0;
      items.push({
        id: 'add-to-repertoire',
        group: 'training',
        label: repertoiresLoading
          ? t(
              'analysis.useAsRepertoire.addToExistingLoading',
              'Loading repertoires…',
            )
          : t(
              'analysis.useAsRepertoire.addToExistingMenuItem',
              'Add to existing repertoire…',
            ),
        onClick: () => setAddToRepertoireOpen(true),
        disabled:
          isGuest || repertoiresLoading || emptyRepertoires,
        disabledHint: isGuest
          ? guestDisabledHint
          : emptyRepertoires
            ? t(
                'analysis.useAsRepertoire.addToExistingEmpty',
                'You have no repertoires yet',
              )
            : undefined,
      });
    }
  }

  // — sharing —
  const shareVisible =
    !publicMode && (isGuest || (isOwner && !!localIdRef.current));
  if (shareVisible) {
    items.push({
      id: 'share',
      group: 'sharing',
      label: t('analysis.share.menuItem', 'Share'),
      onClick: () => {
        // Открыть в следующем тике — даём dropdown/sheet закрыться раньше.
        window.setTimeout(() => {
          shareButtonRef.current?.open();
        }, 0);
      },
      disabled: isGuest,
      disabledHint: isGuest ? guestDisabledHint : undefined,
    });
  }

  // — broadcast — KS-3755 / ADR-112: управление трансляцией перенесено
  // из верхнего LiveBroadcastControl сюда. Пункты видны только владельцу
  // на собственной странице (не publicMode, не гость). Для зрителя
  // live-режима (publicMode=true через isViewerLive) ничего не
  // добавляем — он не управляет трансляцией. Для гостя на чужом
  // публичном анализе тоже ничего — там нечего транслировать.
  const broadcastVisible = !publicMode && !!user;
  if (broadcastVisible) {
    if (liveIsLive) {
      // Заголовок группы: «В эфире · N зрителей» как disabled-пункт.
      // Меню — самый видимый канал, в котором имеет смысл показывать
      // счётчик зрителей; внешний бейдж даёт минимально-навязчивую
      // подсказку «трансляция идёт», детализация — здесь.
      // KS-3771: счётчик зрителей убран. Заголовок группы — просто
      // «В эфире» (без `· N зрителей`). Backend по-прежнему собирает
      // viewerCount/viewerPeak (метрики), фронт не показывает.
      items.push({
        id: 'broadcast-status',
        group: 'broadcast',
        label: t('liveAnalysis.onAir', 'On air'),
        onClick: () => {},
        disabled: true,
      });
      if (livePublicUrl) {
        items.push({
          id: 'broadcast-copy-link',
          group: 'broadcast',
          label: t('liveAnalysis.copyLink', 'Copy link'),
          onClick: () => {
            void onLiveCopyLink();
          },
        });
      }
      items.push({
        id: 'broadcast-stop',
        group: 'broadcast',
        label: t('liveAnalysis.stopMenuItem', 'Stop broadcast'),
        onClick: onLiveStop,
      });
    } else if (kind !== 'analysis') {
      // review / puzzle — анализ чужой партии или пазла, транслировать
      // нечего. Пункт disabled + tooltip-подсказка.
      items.push({
        id: 'broadcast-start',
        group: 'broadcast',
        label: t('liveAnalysis.startMenuItem', 'Start broadcast'),
        onClick: () => {},
        disabled: true,
        disabledHint: t(
          'liveAnalysis.unavailableTooltip',
          'Save to your workshop to start broadcasting',
        ),
      });
    } else if (!liveAnalysisId) {
      // Ad-hoc сессия без id — «Сохранить и начать трансляцию».
      items.push({
        id: 'broadcast-save-and-start',
        group: 'broadcast',
        label: t(
          'liveAnalysis.saveAndStartMenuItem',
          'Save and start broadcast',
        ),
        onClick: onLiveSaveAndStart,
        disabled: liveIsStarting,
      });
    } else {
      // Обычный flow: сохранённый анализ с id → просто start.
      items.push({
        id: 'broadcast-start',
        group: 'broadcast',
        label: t('liveAnalysis.startMenuItem', 'Start broadcast'),
        onClick: onLiveStart,
        disabled: liveIsStarting,
      });
    }
  }

  return items;
}

export function AnalysisPage({
  publicMode = false,
  embedded = false,
  embeddedPgn,
  liveSession,
}: AnalysisPageProps = {}) {
  const params = useParams<{
    id?: string;
    gameId?: string;
  }>();
  // KS-3182: embedded-инстанс монтируется вне аналитического роута;
  // useParams вернёт undefined, поэтому key основан на pgn (смена PGN
  // должна пересоздавать всё внутреннее состояние, иначе history
  // первой партии останется во второй карточке шага).
  // KS-3747: live-инстанс монтируется по slug — пересоздаём дерево
  // при смене slug/mode (но НЕ при каждом state-patch, иначе
  // потеряли бы контекст зрителя — см. ADR-111 §2.8 п.5).
  const key =
    params.id ??
    params.gameId ??
    (embedded ? `embedded:${embeddedPgn ?? ''}` : null) ??
    (liveSession ? `live:${liveSession.slug}:${liveSession.mode}` : null) ??
    '__none__';
  return (
    <AnalysisPageInner
      key={key}
      publicMode={publicMode}
      embedded={embedded}
      embeddedPgn={embeddedPgn}
      liveSession={liveSession}
    />
  );
}

function AnalysisPageInner({
  publicMode: publicModeProp = false,
  embedded = false,
  embeddedPgn,
  liveSession,
}: AnalysisPageProps) {
  // KS-3182: embedded === read-only во всех точках, где `publicMode`
  // используется как гейт мутаций (autosave, share, title-edit,
  // position update, fetch by id, drag disabled, JSX-кнопки действий).
  // Чтобы не переписывать каждый use-site, переопределяем локальный
  // `publicMode = publicModeProp || embedded`. Все существующие гейты
  // (~15 use-sites) автоматически захватят embedded как read-only.
  //
  // KS-3747 (ADR-111 §7): viewer-live тоже считаем read-only — у
  // зрителя нет analysisId, нечего автосейвить, нельзя editить title
  // или вызывать «Транслировать». Этот же гейт скрывает блок
  // LiveBroadcastControl (KS-3736), который условие
  // `!embedded && !publicMode && user` уже учитывает.
  const isViewerLive = liveSession?.mode === 'viewer';
  const publicMode = publicModeProp || embedded || isViewerLive;
  // Add class to body/app for mobile layout (fallback for browsers without :has() support)
  useEffect(() => {
    // KS-3182: body-class `has-analysis-page` нужна mobile-layout'у
    // analysis-страницы. В embedded-режиме (внутри урока) она бы
    // приклеилась к body всей страницы урока — это перебивает CSS
    // lesson-layout'а. Эффект полностью отключаем для embedded;
    // mobile-layout в шаге урока подстраивает GameStep локально.
    if (embedded) return undefined;
    document.body.classList.add('has-analysis-page');
    const app = document.querySelector('.app');
    app?.classList.add('has-analysis-page');
    return () => {
      document.body.classList.remove('has-analysis-page');
      app?.classList.remove('has-analysis-page');
    };
  }, [embedded]);

  // KS-2867 (FR4): единый AnalysisContext вместо разбросанных derivations.
  // Backwards-compatible локальные алиасы — оставлены чтобы не переписывать
  // 30+ мест использования за одну итерацию (FM1-FM5 поэтапно мигрируют
  // на прямое чтение ctx.kind/ctx.fields).
  const ctx = useAnalysisContext({ publicMode });
  const gameId = ctx.kind === 'review' ? ctx.gameId : undefined;
  const analysisId = ctx.kind === 'analysis' ? ctx.analysisId : undefined;
  const location = useLocation();
  // KS-3082: для onClick «Найти партии с этой позицией» в overflow меню.
  const navigate = useNavigate();
  // KS-3092: `?ply=N` (либо `location.state.initialPly`) — стартовый
  // полу-ход для viewer'а при открытии партии из by-position-результатов
  // архива. Backend (`/games/by-position`) отдаёт `reachedAtPly` в
  // каждом item; ArchiveGamesPage.handleRowClick прокидывает его и
  // в navState, и в URL — последнее переживает reload и копирование
  // ссылки. Берём navState приоритетнее (без round-trip через
  // URLSearchParams), URL — как fallback.
  const [analysisSearchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  // KS-2114: размер доски на странице анализа (S/M/L) — пресет из общего
  // BoardSettingsContext, сохраняется в localStorage (см. ключ
  // `analysisBoardSize`). UI-переключатель ниже в `.analysis-board-controls`.
  const { boardSize, setBoardSize } = useBoardSettings();
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  // KS-2434: вкладка 'report' удалена вместе с серверным game-report'ом.
  // KS-3687: добавлена вкладка 'ai' (4-я). Синхронизировано с
  // AnalysisMobileTab в AnalysisSidebar.tsx.
  type MobileTabId = 'moves' | 'engine' | 'tree' | 'ai';
  const [mobileTab, setMobileTab] = useState<MobileTabId>('moves');
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  // KS-3471 (ADR-090 V4 F1): модалка выбора movetime + F2 поток.
  const [showArchiveRepMovetimeModal, setShowArchiveRepMovetimeModal] =
    useState(false);
  const archiveRep = useRepertoireFromArchive();
  const [archiveRepProgressOpen, setArchiveRepProgressOpen] = useState(false);
  // KS-2674: ref на ShareAnalysisButton — нужен чтобы пункт «Share»
  // в overflow-меню (mobile) мог открыть тот же popup, что и trigger
  // в action-bar (desktop), без дублирования логики.
  const shareButtonRef = useRef<ShareAnalysisButtonHandle | null>(null);
  // KS-2220: inline-сообщение возле кнопок «PGN» после копирования.
  // Глобального toast-сервиса в проекте нет (см. ArchiveGamePage —
  // тот же паттерн state + setTimeout).
  const [pgnCopyMsg, setPgnCopyMsg] = useState<string | null>(null);
  const pgnCopyTimerRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<number | null>(null);

  // KS-2666: для кнопки «Поделиться» нам нужны `userId` (определить
  // owner'а) и `isPublic` (текущее состояние) из загруженного анализа.
  // Backend возвращает оба поля в `AnalysisResponse`. Локальные
  // state'ы — обновляются после `getById`.
  const [savedOwnerId, setSavedOwnerId] = useState<string | null>(null);
  const [savedIsPublic, setSavedIsPublic] = useState<boolean>(false);

  // Standalone analysis state
  const {
    create: createAnalysis,
    update: updateAnalysis,
    getById,
    getPublicById,
  } = useSavedAnalyses();
  // KS-2867 (FR4): localId-инициализация из AnalysisContext.localId
  // (resolver уже учёл state.localId и id из URL).
  const localIdRef = useRef<string | undefined>(
    ctx.kind === 'analysis' ? ctx.localId : analysisId,
  );
  // Safety-net: при смене `:id` синхронизируем `localIdRef.current`,
  // даже если KS-2403 `key={id}` обёртка по какой-то причине не
  // пересоздала компонент (например, прямые `replaceState` без
  // navigate, тесты с MemoryRouter без unmount-mount). Без этого
  // auto-save (см. ниже) сохраняет history текущей открытой партии в
  // запись с предыдущим `id` — все партии в Workshop становятся
  // одинаковыми.
  useEffect(() => {
    localIdRef.current = analysisId;
  }, [analysisId]);

  // KS-3046 (заменяет KS-3044 localStorage-слой): при перевороте доски
  // (1) обновляем state оптимистично, (2) если у анализа уже есть id
  // в БД — сразу шлём PATCH `{ boardOrientation: next }`. Для ad-hoc-
  // сессии без id в момент переворота — персистенция отложена до
  // первого createAnalysis (см. ниже после `entry.id` — там вызывается
  // updateAnalysis с актуальным значением из boardOrientationRef).
  // Backend поле `analyses.boardOrientation` добавлено в KS-3045.
  const boardOrientationRef = useRef(boardOrientation);
  boardOrientationRef.current = boardOrientation;
  const flipBoardOrientation = useCallback(() => {
    setBoardOrientation((prev) => {
      const next = prev === 'white' ? 'black' : 'white';
      const id = localIdRef.current;
      // KS-2672: в publicMode не-владелец не должен мутировать чужой
      // анализ — PATCH не отправляем, ориентация переключается только
      // локально (на reload вернётся к owner-сохранённому значению).
      // Авторизованный владелец public-URL ходит на /analysis/:id для
      // редактирования — там publicMode=false.
      if (id && !publicMode) {
        // Fire-and-forget: PATCH без ожидания. Ошибки сети не должны
        // блокировать UI — пользователь видит state-смену моментально.
        // Если запись не сохранится (offline / 5xx), следующий переворот
        // всё равно пошлёт новый PATCH; в худшем случае пользователь
        // увидит дефолт при следующей загрузке — приемлемая деградация
        // для UI-настройки.
        updateAnalysis(id, { boardOrientation: next }).catch(() => {});
      }
      return next;
    });
  }, [updateAnalysis, publicMode]);
  const stateBreadcrumbRootTitle = (location.state as { breadcrumbRootTitle?: string } | null)?.breadcrumbRootTitle;
  const stateBreadcrumbRootUrl = (location.state as { breadcrumbRootUrl?: string } | null)?.breadcrumbRootUrl;
  const stateBreadcrumbSection = (location.state as { breadcrumbSection?: string } | null)?.breadcrumbSection;
  const stateBreadcrumbBackUrl = (location.state as { breadcrumbBackUrl?: string } | null)?.breadcrumbBackUrl;
  const stateBreadcrumbBackState = (location.state as { breadcrumbBackState?: unknown } | null)?.breadcrumbBackState;
  const breadcrumbFileName = (location.state as { breadcrumbFileName?: string } | null)?.breadcrumbFileName;
  const breadcrumbFileBackUrl = (location.state as { breadcrumbFileBackUrl?: string } | null)?.breadcrumbFileBackUrl;
  const breadcrumbFileBackState = (location.state as { breadcrumbFileBackState?: unknown } | null)?.breadcrumbFileBackState;
  const breadcrumbRootTitle = stateBreadcrumbRootTitle;
  const breadcrumbRootUrl = stateBreadcrumbRootUrl;
  const breadcrumbSection = stateBreadcrumbSection;
  const breadcrumbBackUrl = stateBreadcrumbBackUrl;
  const breadcrumbBackState = stateBreadcrumbBackState;
  // KS-2867 (FR4): puzzle-параметры теперь приходят из AnalysisContext.
  // Совместимость: значения те же, что раньше из location.state/URL.
  const puzzleFen = ctx.kind === 'puzzle' ? ctx.fen : undefined;
  const puzzlePgn = ctx.kind === 'puzzle' ? ctx.pgn : undefined;
  const puzzleMovesParam = ctx.kind === 'puzzle' ? ctx.moves : undefined;
  const puzzleSide: 'white' | 'black' | null =
    ctx.kind === 'puzzle' && ctx.side ? ctx.side : null;
  const [analysisTitle, setAnalysisTitle] = useState<string>(() => {
    // KS-3262: при openedExisting (dedup-hit) игнорируем state.title —
    // он передан из source (broadcast/archive). Реальный title придёт
    // из getById ответа ниже.
    const state = location.state as {
      title?: string;
      openedExisting?: boolean;
    } | null;
    if (state?.openedExisting) return getDefaultTitle();
    return state?.title ?? getDefaultTitle();
  });
  // KS-3261: toast «Открыли существующий анализ». Триггерится из state
  // (openAnalysisFromPgn кладёт `openedExisting: true` когда backend
  // вернул `existing: true` по dedup). Скрывается через 3 секунды.
  const [openedExistingToast, setOpenedExistingToast] = useState<boolean>(
    () => {
      const state = location.state as { openedExisting?: boolean } | null;
      return Boolean(state?.openedExisting);
    },
  );
  useEffect(() => {
    if (!openedExistingToast) return;
    const id = window.setTimeout(() => setOpenedExistingToast(false), 3000);
    return () => window.clearTimeout(id);
  }, [openedExistingToast]);
  const [pgnHeaders, setPgnHeaders] = useState<Record<string, string>>(() => {
    // KS-3262: при openedExisting headers тоже игнорируем — реальные
    // придут из getById(saved.pgn) после ответа сервера.
    const state = location.state as {
      pgn?: string;
      openedExisting?: boolean;
    } | null;
    if (state?.openedExisting) return {};
    return state?.pgn ? parsePgnHeaders(state.pgn) : {};
  });
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(analysisTitle);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  // KS-1576: Variation chooser state — открывается при ArrowRight если у следующего хода есть альтернативы
  const [variationChooser, setVariationChooser] = useState<
    { mainLine: ChessMove; variations: ChessMove[][] } | null
  >(null);
  useEffect(() => {
    if (!gameId && localIdRef.current && !analysisId) {
      window.history.replaceState(null, '', '/analysis/' + localIdRef.current);
    }
    // KS-2034: эффект «при монтировании выставить URL по локальному id»
    // должен запускаться один раз. Зависимости (`gameId`, `analysisId`)
    // не нужны — при их смене `replaceState` бы перезатёр URL,
    // подставленный пользователем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const containerSize = useContainerSize(boardContainerRef);
  const boardWidth = Math.min(containerSize.width, containerSize.height);
  // KS-3320 follow-up: customPieces ОБЯЗАТЕЛЬНО передавать в
  // boardOptions, иначе react-chessboard рендерит свой default-pieceset
  // (внешне как старый cburnett) — пользователь видит «фигуры не
  // изменились» при смене темы в /settings.
  const { boardThemeOptions, customPieces } = useBoardTheme();

  const {
    history, currentMove, currentGlobalIndex, currentFen, initialFen,
    loadMoves, loadFromPgn, setInitialFen, gotoMove, gotoFirst, gotoLast,
    gotoPrevious, gotoNext,
    // KS-3736: оборачиваем makeVariantMove (см. ниже), чтобы каждый ход
    // автора в live-трансляции ретранслировался зрителям через WS.
    makeVariantMove: rawMakeVariantMove,
    removeVariation,
    truncateRemaining, promoteVariation, setNag, setComment,
    // KS-2287 (ADR-038): variation-color через reducer.
    setVariationColor,
    // KS-2152
    currentAnnotations, initialAnnotations, annotationsByIndex, setAnnotationsForCurrent,
  } = useReviewState();

  // KS-3747 / ADR-111 §7: подключение к «full» live-трансляции.
  // В viewer-режиме хук кормит нас актуальным PGN/headers/orientation
  // (см. useEffect ниже), в owner-режиме — даёт emit-методы для
  // KS-3748. Если liveBroadcast пропа нет — хук «спит» (slug=null).
  const liveFull = useLiveAnalysisBroadcast({
    slug: liveSession?.slug ?? null,
    mode: liveSession?.mode ?? 'viewer',
  });

  // KS-3747 / ADR-111 §2.8 п.5 — «применение PGN без сноса контекста».
  // На каждый новый pgn из sync/state-patch:
  //   1. Запоминаем FEN текущей позиции зрителя (currentMove?.fen или
  //      initialFen для root).
  //   2. Парсим новый PGN и грузим через loadFromPgn — это меняет
  //      state.history целиком, но НЕ трогает initialFen (LOAD_FROM_PGN
  //      reducer specifically оставляет initialFen как есть).
  //   3. После apply ищем узел с тем же FEN в новом дереве. Если нашли —
  //      gotoMove на него: зритель остаётся на той же позиции, не теряя
  //      контекста. Stockfish (на currentFen), AI (тоже на currentFen),
  //      ArchiveTreePanel — все они переживут без сброса.
  //   4. Если узла нет (зритель ушёл в локальную ветку, которой не
  //      существует в дереве автора, либо автор откатил свою линию) —
  //      reducer уже выставил currentMove на последний ход, оставляем
  //      как есть. Это «soft drift» вместо жёсткого сноса.
  //
  // Применяем только для viewer-режима. Owner-side state-patch будет
  // обрабатываться в KS-3748 (там автор сам генерирует PGN из своего
  // review-state и шлёт его наружу).
  // KS-3750 / ADR-111 §2.8 риски: если зритель ушёл в локальную
  // ветку (currentFen != authorFen из live-хука), новый state-patch
  // не применяется автоматически — иначе мы перебьём разбор зрителя
  // посреди работы. Вместо этого:
  //   1. кладём свежий PGN в `pendingLivePgn`,
  //   2. показываем badge «Получено обновление от автора» с кнопкой
  //      «Применить» (ниже в JSX),
  //   3. как только зритель сам вернулся на main-line автора (т.е.
  //      `currentFen` совпал с `liveFull.currentFen`) — авто-применяем
  //      pending (так требует acceptance: «возврат к трансляции не
  //      теряет накопленные обновления»).
  // Применённый PGN запоминаем в `lastAppliedLivePgnRef`, чтобы тот
  // же snapshot не применился дважды.
  const lastAppliedLivePgnRef = useRef<string | null>(null);
  // KS-3769: FEN автора на момент последнего apply. Используется чтобы
  // отличить «зритель идёт за автором» (viewerFen === lastAppliedAuthorFen)
  // от «зритель листает дерево сам» (viewerFen ≠ lastAppliedAuthorFen).
  // Null до первого apply — трактуется как «следовать за автором».
  const lastAppliedAuthorFenRef = useRef<string | null>(null);
  const [pendingLivePgn, setPendingLivePgn] = useState<string | null>(null);

  // KS-3768 фикс KS-3750: предикат «зритель находится в дереве автора».
  // Раньше критерием была равенство `viewerFen === liveFull.currentFen` —
  // это ломалось на ПЕРВОМ sync: у зрителя currentMove=null,
  // viewerFen=initialFen, а authorFen — позиция автора (обычно не
  // initialFen), → условие давало false → весь первичный snapshot
  // уходил в pending, висел «Применить», авто-применение никогда не
  // срабатывало. Новый критерий: позиция зрителя «в дереве автора»,
  // если она равна стартовой позиции (root) или существует в дереве
  // ходов через findGlobalIndexByFen. Это покрывает:
  //   - первый sync (зритель на root, дерево автора растёт от root);
  //   - зрителя, листающего main-line / варианты автора (его FEN там есть);
  //   - НЕ покрывает: зрителя, ушедшего в собственную ветку (FEN'а
  //     нет в дереве автора) → попадает в pending, ждёт «Применить»
  //     или возврата к main-line.
  const isViewerFenInAuthorTree = useCallback(
    (viewerFen: string, moves: ChessMove[]): boolean => {
      if (viewerFen === initialFen) return true;
      return findGlobalIndexByFen(moves, viewerFen) !== null;
    },
    [initialFen],
  );

  // Стабильный applier — общий код для авто-apply и для клика по
  // кнопке «Применить» из badge'а.
  const applyLivePgn = useCallback(
    (nextPgn: string) => {
      const viewerFen = currentMove?.fen ?? initialFen;
      const authorFen = liveFull.currentFen;
      try {
        const moves = parseAnnotatedPgn(nextPgn);
        const initialAnn = extractInitialAnnotations(nextPgn);
        loadFromPgn(moves, initialAnn);
        // KS-3769: ключевое решение «куда перевести курсор».
        //   - Первый apply (lastAppliedAuthorFenRef.current === null) →
        //     зритель только что открылся, ведём его на позицию автора.
        //   - Зритель остался синхронизированным с автором
        //     (viewerFen === lastAppliedAuthorFenRef.current) → ведём за
        //     автором на новую позицию. Это покрывает основной сценарий
        //     KS-3769: зритель смотрит, автор делает ход, курсор зрителя
        //     автоматически двигается.
        //   - Зритель ушёл в листание дерева (viewerFen ≠
        //     lastAppliedAuthorFenRef) → сохраняем его позицию через
        //     findGlobalIndexByFen(viewerFen). Не сбиваем зрителя
        //     посреди разбора.
        const followAuthor =
          !lastAppliedAuthorFenRef.current ||
          viewerFen === lastAppliedAuthorFenRef.current;
        let target: ChessMove | null = null;
        if (followAuthor && authorFen) {
          const idx = findGlobalIndexByFen(moves, authorFen);
          if (idx !== null) target = searchInHistory(moves, idx) as ChessMove | null;
          // Fallback по currentPly, если точный FEN не нашёлся
          // (расхождение нормализации FEN, exotic вариант, …).
          if (!target && liveFull.currentPly > 0) {
            for (const m of moves) {
              if (m.ply === liveFull.currentPly) {
                target = m;
                break;
              }
              if (m.ply > liveFull.currentPly) break;
              target = m;
            }
          }
        } else {
          // Зритель листает сам — сохраняем его позицию.
          const idx = findGlobalIndexByFen(moves, viewerFen);
          if (idx !== null) target = searchInHistory(moves, idx) as ChessMove | null;
        }
        if (target) gotoMove(target);
        // Если узла нет — reducer оставит currentMove на последнем ходе
        // (soft drift), это норма.
        lastAppliedLivePgnRef.current = nextPgn;
        lastAppliedAuthorFenRef.current = authorFen;
      } catch {
        /* битый PGN — оставляем дерево как есть, ждём следующего sync. */
      }
    },
    [
      currentMove,
      initialFen,
      liveFull.currentFen,
      liveFull.currentPly,
      loadFromPgn,
      gotoMove,
    ],
  );

  // Шлюз входящих state-patch'ей. Решаем: применить сразу или отложить.
  useEffect(() => {
    if (!isViewerLive) return;
    if (!liveFull.pgn) return;
    if (lastAppliedLivePgnRef.current === liveFull.pgn) return;
    const viewerFen = currentMove?.fen ?? initialFen;
    let inAuthorTree = true;
    try {
      const moves = parseAnnotatedPgn(liveFull.pgn);
      inAuthorTree = isViewerFenInAuthorTree(viewerFen, moves);
    } catch {
      // Битый PGN — пусть applyLivePgn сам отбьётся, мы не хотим
      // удерживать сломанный snapshot в pending'е.
      inAuthorTree = true;
    }
    if (inAuthorTree) {
      applyLivePgn(liveFull.pgn);
      // Если что-то лежало в pending — теперь оно неактуально, очищаем.
      if (pendingLivePgn !== null) setPendingLivePgn(null);
    } else {
      // Локальная ветка: не применяем, держим последний свежий PGN в
      // pending'е (только последний — новые патчи перезаписывают
      // предыдущие, дельты не нужны).
      setPendingLivePgn(liveFull.pgn);
    }
    // currentMove не в deps намеренно: на каждое переключение ходов
    // зрителя — это норма, не сигнал «пришёл новый patch». Авто-apply
    // pending при возврате к дереву автора обрабатывает соседний
    // useEffect ниже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isViewerLive, liveFull.pgn, applyLivePgn, isViewerFenInAuthorTree]);

  // KS-3750 (KS-3768 фикс): авто-apply pending когда зритель снова
  // оказался в дереве автора. Триггер — изменение currentMove (зритель
  // листает или сам делает ходы).
  useEffect(() => {
    if (!isViewerLive) return;
    if (!pendingLivePgn) return;
    const viewerFen = currentMove?.fen ?? initialFen;
    let inAuthorTree = false;
    try {
      const moves = parseAnnotatedPgn(pendingLivePgn);
      inAuthorTree = isViewerFenInAuthorTree(viewerFen, moves);
    } catch {
      inAuthorTree = false;
    }
    if (inAuthorTree) {
      applyLivePgn(pendingLivePgn);
      setPendingLivePgn(null);
    }
  }, [
    isViewerLive,
    pendingLivePgn,
    currentMove,
    initialFen,
    applyLivePgn,
    isViewerFenInAuthorTree,
  ]);

  const handleApplyPendingLive = useCallback(() => {
    if (!pendingLivePgn) return;
    applyLivePgn(pendingLivePgn);
    setPendingLivePgn(null);
  }, [applyLivePgn, pendingLivePgn]);

  // KS-3747: orientation из live перебивает локальный boardOrientation.
  // Зритель не должен сам переворачивать доску — автор задал ориентацию,
  // мы её отображаем. Owner-режим тоже синхронизирует, иначе автор и
  // зритель видели бы разное.
  useEffect(() => {
    if (!liveSession) return;
    if (!liveFull.orientation) return;
    setBoardOrientation((prev) =>
      prev === liveFull.orientation ? prev : liveFull.orientation,
    );
  }, [liveSession, liveFull.orientation]);

  // KS-3747: headers из live — обновляем locale-state. По ADR-111 §2.8.2
  // «при расхождении побеждает PGN», но и `headers` поле служит хинтом
  // для зрительского `GameMetaBar`. Подменяем только если оно реально
  // пришло; пустого объекта/null reducer'ом не трогаем — иначе один
  // sync без headers перетёр бы валидные значения.
  useEffect(() => {
    if (!isViewerLive) return;
    if (!liveFull.headers) return;
    setPgnHeaders(liveFull.headers);
  }, [isViewerLive, liveFull.headers]);

  // KS-3747: в viewer-режиме нет id-based загрузки — стартуем сразу
  // готовыми к рендеру, спиннер не нужен. Загружаемое содержимое
  // подтянет live-хук через useEffect выше.
  useEffect(() => {
    if (!isViewerLive) return;
    setLoading(false);
    setError('');
  }, [isViewerLive]);

  // KS-3736 / ADR-110, KS-3763 / ADR-112: state-автомат live-трансляции
  // анализа. Хук делает REST POST для запуска, REST GET по analysisId
  // для восстановления (привязка к конкретному анализу — backend
  // enforce'ит partial-UNIQUE), держит WS-подписку и self-heal через
  // `reset` при `illegal-move`.
  const liveBroadcast = useAnalysisLiveBroadcast({
    currentFen,
    initialFen,
    orientation: boardOrientation,
    title: analysisTitle,
    userId: user?.id ?? null,
    // KS-3763: ID сохранённого анализа — ключ восстановления через
    // GET /live-analyses/by-analysis/:id. На странице без id
    // (ad-hoc / kind='review' / 'puzzle') — null, хук «спит».
    analysisId: analysisId ?? null,
    // KS-3770: на странице зрителя (/live/:slug → AnalysisPage с
    // liveSession.mode='viewer') хук-стартёр должен молчать. Иначе у
    // авторизованного владельца REST-restore поднимет его собственную
    // трансляцию, эффект эмита KS-3749 начнёт слать обратно state-patch
    // с PGN страницы (зрительский state) и отравит трансляцию.
    disabled: isViewerLive,
  });

  // Обёртка над `rawMakeVariantMove`: пробрасываем UCI в live-трансляцию
  // после успешно применённого хода. Если трансляция не активна — внутри
  // хука это no-op, лишних эмитов не будет.
  const makeVariantMove = useCallback(
    (from: string, to: string, promotion?: string): boolean => {
      const ok = rawMakeVariantMove(from, to, promotion);
      if (ok && !isViewerLive) {
        // KS-3770: на странице зрителя ходы по доске — это локальные
        // движения в своей ветке, в трансляцию автора их слать нельзя.
        // Внутри emitMove дополнительный safety (slug=null в viewer
        // → no-op), но явный гейт читается лучше.
        const uci = `${from}${to}${(promotion ?? '').toLowerCase()}`;
        liveBroadcast.emitMove(uci);
      }
      return ok;
    },
    [isViewerLive, rawMakeVariantMove, liveBroadcast],
  );

  const game = useMemo(() => new Chess(), []);

  // Load puzzle position if navigated from PuzzlePage
  useEffect(() => {
    if (puzzleFen && !gameId && !analysisId) {
      setInitialFen(puzzleFen);
      if (puzzleSide) setBoardOrientation(puzzleSide);
      // KS-2828: ранее ходы из `?pgn=` / `?moves=` парсились вручную
      // (`chess.move(san)` в цикле) и складывались в `ChessMove[]` БЕЗ
      // поля `ply`. `LOAD_FROM_PGN` reducer кладёт их в history as-is,
      // а `formatMoveDisplay` фолбэкает на `move.ply || (moveIndex + 1)`
      // — то есть для первого хода ply=1 (трактуется как белый), даже
      // если стартовая позиция из FEN — ход чёрных. Отсюда жалоба
      // «`1.h6 Nh3 ...` вместо `25...h6 26.Nh3` на пазлах Точности».
      //
      // Лечение: собираем валидный PGN с парой `[SetUp "1"][FEN]`,
      // в movetext вставляем номер полного хода с правильным префиксом
      // (`<N>.` или `<N>...`), и парсим через `parseAnnotatedPgn` —
      // он сам считает startPly из FEN-header и проставляет правильный
      // `ply` каждому ходу.
      const buildPgnAndLoad = (sanList: string[]) => {
        if (sanList.length === 0) return;
        const fenParts = puzzleFen.split(' ');
        const startIsWhite = fenParts[1] !== 'b';
        const startMvNum = parseInt(fenParts[5] || '1', 10) || 1;
        const movetext: string[] = [];
        for (let i = 0; i < sanList.length; i++) {
          const totalHalf = i + (startIsWhite ? 0 : 1);
          const fullMv = startMvNum + Math.floor(totalHalf / 2);
          const isWhiteHalf = totalHalf % 2 === 0;
          if (i === 0 && !startIsWhite) {
            movetext.push(`${fullMv}...`);
          } else if (isWhiteHalf) {
            movetext.push(`${fullMv}.`);
          }
          movetext.push(sanList[i]);
        }
        const pgn =
          `[SetUp "1"]\n[FEN "${puzzleFen}"]\n\n${movetext.join(' ')} *`;
        try {
          loadFromPgn(parseAnnotatedPgn(pgn));
        } catch {
          /* битый PGN — оставляем без ходов, FEN уже выставлен */
        }
      };

      if (puzzlePgn) {
        try {
          // SAN-список из `?pgn=`: вырезаем move-numbers (включая
          // `<N>...`) и result-маркеры, оставляем чистые SAN'ы.
          const sanMoves = puzzlePgn
            .replace(/\d+\.\.\./g, '')
            .replace(/\d+\./g, '')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .filter((tok) => tok !== '*' && tok !== '1-0' && tok !== '0-1' && tok !== '1/2-1/2');
          // Валидируем SAN'ы реплеем на puzzleFen — отбрасываем хвост,
          // который не применяется к позиции (защита от мусора).
          const replay = new Chess(puzzleFen);
          const valid: string[] = [];
          for (const san of sanMoves) {
            const mv = replay.move(san);
            if (!mv) break;
            valid.push(mv.san);
          }
          buildPgnAndLoad(valid);
        } catch { /* ignore parse errors */ }
      } else if (puzzleMovesParam) {
        try {
          const uciMoves = puzzleMovesParam.split(/[\s+]+/).filter(Boolean);
          const replay = new Chess(puzzleFen);
          const sans: string[] = [];
          for (const uci of uciMoves) {
            const mv = replay.move({
              from: uci.slice(0, 2),
              to: uci.slice(2, 4),
              promotion: uci.length > 4 ? uci[4] : undefined,
            });
            if (!mv) break;
            sans.push(mv.san);
          }
          buildPgnAndLoad(sans);
        } catch { /* ignore parse errors */ }
      }
    }
    // KS-2034: эффект «загрузить позицию из puzzle при монтировании»
    // запускается один раз. Если положить `puzzleFen/puzzleSide/...` в
    // deps, при их обновлении (router-state) восстановление позиции
    // перетрёт работу пользователя в редакторе.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // KS-2434: серверный анализ партии удалён (см. KS-2433). На странице
  // анализа теперь только клиентский WASM/external Stockfish.

  // Panel collapse state
  // KS-3687: добавлен collapsible-блок `ai` — отдельная панель
  // AI-комментария. KS-3696: правая колонка — «Движок»/«Нотация»/«Книга»/«AI»
  // в порядке вёрстки. «Движок» и «AI» взаимно исключаются, «Нотация»
  // и «Книга» — независимые.
  // Дефолт на desktop: открыты «Движок», «Нотация», «Книга»; «AI» закрыт
  // (раз «Движок» открыт). На узких экранах всё свёрнуто, чтобы не
  // занимать высоту.
  const [panelStates, setPanelStates] = useState(() => {
    const narrow = typeof window !== 'undefined' && window.innerWidth <= 768;
    return {
      gameInfo: !narrow,
      engine: !narrow,
      moves: !narrow,
      ai: false,
      book: !narrow,
    };
  });
  // KS-3696. Ref-обёртка для «приостановить движок при схлопывании
  // engine-панели». Сама функция `toggleAnalysis`/`stopEngine` объявлена
  // ниже (после useEngine), поэтому здесь читаем её через ref. До
  // инициализации — no-op.
  const pauseEngineForAccordionRef = useRef<() => void>(() => {});
  const togglePanel = useCallback(
    (panel: 'gameInfo' | 'engine' | 'moves' | 'ai' | 'book') => {
      setPanelStates((prev) => {
        const { next, engineWillCollapse } = panelToggleReducer(prev, panel);
        if (engineWillCollapse) {
          // queueMicrotask: вызываем после применения setPanelStates,
          // чтобы стек состояний остался согласованным.
          queueMicrotask(() => pauseEngineForAccordionRef.current());
        }
        return next;
      });
    },
    [],
  );

  const handleTitleClick = useCallback(() => {
    if (gameId) return;
    // KS-2672: в publicMode не-владелец не редактирует title.
    if (publicMode) return;
    setTitleInput(analysisTitle);
    setIsEditingTitle(true);
  }, [gameId, analysisTitle, publicMode]);

  const handleTitleSave = useCallback(() => {
    const trimmed = titleInput.trim() || getDefaultTitle();
    setAnalysisTitle(trimmed);
    setIsEditingTitle(false);
    // KS-2672: в publicMode мутация title запрещена.
    if (publicMode) return;
    if (localIdRef.current) {
      updateAnalysis(localIdRef.current, { title: trimmed }).catch(() => {});
    }
  }, [titleInput, updateAnalysis, publicMode]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleTitleSave();
      if (e.key === 'Escape') setIsEditingTitle(false);
    },
    [handleTitleSave],
  );

  const analysisPageRef = useRef<HTMLDivElement>(null);

  const wasmSupported = typeof WebAssembly !== 'undefined';
  const isTouchDevice =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const [analysisEnabled, setAnalysisEnabled] = useState<boolean>(() => {
    if (typeof WebAssembly === 'undefined') return false;
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return false;
    try { return localStorage.getItem('analysisRunning') === 'true'; } catch { return false; }
  });
  const [engineFailed, setEngineFailed] = useState(false);

  // Engine config (extracted hook)
  const ec = useEngineConfig();
  const [showSetPosition, setShowSetPosition] = useState(false);
  const [showPgnHeaders, setShowPgnHeaders] = useState(false);
  // KS-2958: модал «Сгенерировать пазл» — переиспользует основной
  // PuzzleGeneratorModal с автозапуском от текущего PGN партии.
  const [showPuzzleGen, setShowPuzzleGen] = useState(false);
  const [puzzleGenPgn, setPuzzleGenPgn] = useState<string>('');
  const [bridgePromoDismissed, setBridgePromoDismissed] = useState(() => {
    try { return localStorage.getItem('bridgePromoDismissed') === '1'; } catch { return false; }
  });

  // KS-3603 (ADR-100 §8): originalAnalysisId подгружаем отдельным
  // запросом — он нужен Sidebar для source-link «← Исходный анализ»
  // и для disable кнопки «Разобрать партию» (на дубле). Lazy + best-
  // effort; при ошибке остаётся null, UI рендерит как для оригинала.
  const [analysisOriginalId, setAnalysisOriginalId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const id = localIdRef.current;
    if (!id) {
      setAnalysisOriginalId(null);
      return;
    }
    let cancelled = false;
    api
      .get<{ originalAnalysisId: string | null }>(`/analyses/${id}`)
      .then((res) => {
        if (!cancelled) setAnalysisOriginalId(res.originalAnalysisId ?? null);
      })
      .catch(() => {
        if (!cancelled) setAnalysisOriginalId(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId]);

  // KS-3603 (ADR-100): свежий PGN для оркестратора. Берём
  // `history`-сериализацию, чтобы клик «Разобрать» использовал
  // именно те ходы, что юзер видит на доске сейчас.
  // KS-3720: добавлены PGN-заголовки (White/Black/Event/Date/Result/Elo)
  // и стартовый FEN — без них автодубль `/duplicate-annotated`
  // сохранял партию с пустыми метаданными и в шапке открытой записи
  // ничего не было видно. `buildPgnWithFen` собирает стандартный
  // заголовочный блок в том же порядке что и экспорт PGN.
  const analysisPgn = useMemo<string>(() => {
    if (history.length === 0) return '';
    try {
      const movesOnly = serializeToAnnotatedPgn(
        history,
        initialAnnotations,
        annotationsByIndex,
      );
      return buildPgnWithFen(movesOnly, initialFen, pgnHeaders);
    } catch {
      return '';
    }
  }, [history, initialAnnotations, annotationsByIndex, initialFen, pgnHeaders]);

  // KS-3606: launcher «Разобрать партию» — выносится в пункт меню
  // через `onRunGameReview` (см. ниже buildAnalysisActionsItems).
  // Hook сам управляет modal-state'ом и POST'ом дубля.
  // KS-3616: `openingName` уже вычислен ниже (`openingName` через
  // classifyOpening) и в pgnHeaders. Пока партия не доиграна — берём
  // из ECO-классификатора, иначе fallback на header `Opening`. На
  // вход extractFacts'у нужен текстовый ярлык вроде «Sicilian Defense».
  const opening_for_review =
    classifyOpening(history.map((m) => m.san)) ||
    pgnHeaders['Opening'] ||
    null;
  const gameReviewLauncher = useGameReviewLauncher({
    analysisId: localIdRef.current ?? null,
    pgn: analysisPgn,
    originalAnalysisId: analysisOriginalId,
    historyLength: history.length,
    openingName: opening_for_review,
  });

  // KS-3597 (ADR-099 F2): Maia-hook и sort-режим на уровне AnalysisPage,
  // чтобы `useEngine` мог получить `searchmoves` (Maia top-N) для
  // `sortMode === 'maia'`. Sidebar получает всё через props.
  // KS-3600: ELO Maia больше не зависит от профиля — только настройки
  // (localStorage `analysis.maia.elo` → 1500).
  const maia = useMaiaAnalysis({ fen: currentFen });
  const { sortMode, setSortMode } = useEngineSortMode();

  // KS-3680/KS-3685: контроллер AI-комментария позиции теперь поднят
  // ниже, после объявления `displayedLines`, чтобы пробросить лучшую
  // линию Stockfish 18 как дополнительный фактор. См. блок после
  // `const displayedLines = …`.
  const aiCommentLanguage: 'ru' | 'en' =
    (i18n.language || '').toLowerCase().startsWith('en') ? 'en' : 'ru';

  // KS-3597: финальный массив `searchmoves`. null/[] → обычный go
  // без хвоста (mode=stockfish, или Maia не ready, или engine не
  // поддерживает — последнее знает `useEngine` сам по source).
  const maiaTopMoves = useMemo<string[]>(() => {
    if (sortMode !== 'maia' || maia.status !== 'ready') return [];
    const entries = Object.entries(maia.policyByMove);
    if (entries.length === 0) return [];
    entries.sort(([, a], [, b]) => b - a);
    return entries.slice(0, Math.max(0, ec.multiPv)).map(([uci]) => uci);
  }, [sortMode, maia.status, maia.policyByMove, ec.multiPv]);

  const {
    lines, analysisFen, evaluate, stop: stopEngine, setOption: setEngineOption,
    isReady, state: sfState, engineName, engineSource: activeSource,
    errorMessage: engineErrorMessage,
    loadProgress: engineLoadProgress, errorReason: engineErrorReason,
    init: engineInit,
    supportsSearchmoves: engineSupportsSearchmoves,
  } = useEngine({
    source: ec.engineSource,
    externalConfig: ec.externalConfig,
    // KS-3404: окно анализа ВСЕГДА идёт бесконечно (go infinite, без
    // потолка глубины — как live-анализ точности). UI-опции глубины нет.
    // Для WASM `depth` игнорируется (infinite); для external — 99
    // («бесконечно», серверная сторона ограничивает сама).
    depth: ec.engineSource === 'external' ? 99 : 20,
    infinite: true,
    multiPv: ec.multiPv,
    autoStart: analysisEnabled,
    // KS-3597: Maia top-N (или null) для sortMode=maia.
    searchmoves: maiaTopMoves.length > 0 ? maiaTopMoves : null,
  });

  const lastLinesRef = useRef<EvalLine[]>([]);
  const prevSourceRef = useRef<EngineSource>(activeSource);
  const prevAnalysisFenRef = useRef<string | null>(analysisFen);
  if (prevSourceRef.current !== activeSource) {
    lastLinesRef.current = [];
    prevSourceRef.current = activeSource;
  }
  // KS-3043: при смене анализируемой позиции сбрасываем «замороженные»
  // прошлые линии. Иначе для новой позиции с малым числом легальных
  // ходов (legalMoves < ec.multiPv, см. KS-3041 clamp) свежие `lines`
  // не достигают `ec.multiPv` строк, freeze-условие ниже не срабатывает,
  // и UI продолжает показывать stale-эвалы прошлой позиции с пустыми
  // SAN — `formatPv` не может применить UCI-ходы прошлой PV к новому FEN.
  if (prevAnalysisFenRef.current !== analysisFen) {
    lastLinesRef.current = [];
    prevAnalysisFenRef.current = analysisFen;
  }
  // KS-3043: для WASM-движка эффективное число линий = clamp(multiPv,
  // legalMoves). На позициях с legalMoves < ec.multiPv движок возвращает
  // legalMoves строк, и условие `lines.length === ec.multiPv` никогда не
  // выполнится → freeze никогда не обновляется. Считаем «полный набор»
  // относительно того, сколько движок реально может вернуть для текущей
  // анализируемой позиции.
  const expectedLineCount = analysisFen
    ? clampMultiPvToLegalMoves(analysisFen, ec.multiPv)
    : ec.multiPv;
  if (activeSource === 'external' ? lines.length > 0 : lines.length === expectedLineCount) {
    lastLinesRef.current = lines;
  }
  const displayedLines = lastLinesRef.current.length > 0 ? lastLinesRef.current : lines;

  // KS-3680/KS-3685/KS-3687: контроллер AI-комментария поднят ниже
  // объявления `toggleAnalysis`, чтобы `engineProbe` мог дёргать
  // движок при выключенном анализе. См. блок после `toggleAnalysis`.

  // --- Data loading ---
  useEffect(() => {
    if (!gameId) {
      // KS-3182: embedded-инстанс получает PGN из пропа (а не из URL/
      // location.state/БД). Тот же inline-PGN путь, что используется при
      // открытии PGN-файла через `navigate('/analysis', { state: { pgn } })`
      // — отсюда и старшинство `embeddedPgn` над `location.state.pgn`.
      //
      // KS-3262: при dedup-hit (`openedExisting === true` в state)
      // ИГНОРИРУЕМ state.pgn — это входящий source-pgn от broadcast/
      // archive (movetext без сохранённых вариантов/NAG/стрелок).
      // Существующий analysis в БД имеет полный PGN с аннотациями,
      // его подгружает getById-ветка ниже.
      //
      // KS-3263: ВСЕГДА игнорируем state.pgn если у нас есть
      // `analysisId` в URL — это значит запись точно есть в БД
      // (openAnalysis уже сделал POST и navigate'нул на `/analysis/:id`).
      // PGN читаем только через `getById(analysisId)`. state.pgn
      // остаётся актуальным только для no-id flow (paste-PGN из
      // LobbyPage / `navigate('/analysis', { state: { pgn } })` без id).
      const openedExisting =
        (location.state as { openedExisting?: boolean } | null)
          ?.openedExisting === true;
      const pgn = openedExisting || analysisId
        ? undefined
        : embeddedPgn ??
          (location.state as { pgn?: string } | null)?.pgn;
      if (pgn) {
        // KS-2502 fix: новая ad-hoc сессия из `state.pgn` (например
        // клик «Открыть партию» из загруженного PGN-файла →
        // `navigate('/analysis', { state: { pgn } })`). URL остаётся
        // `/analysis` без `:id`, поэтому `useParams` не сообщает о
        // смене записи, а `localIdRef.current` мог остаться
        // привязанным к ранее созданному auto-save'ом entry.id —
        // тогда auto-save через 600мс перезаписывал старую запись
        // содержимым новой партии (все записи в DB становились
        // одинаковыми). Сбрасываем ref, чтобы createAnalysis создал
        // новую запись (либо привязываемся к state.localId если
        // host явно его передал).
        localIdRef.current =
          (location.state as { localId?: string } | null)?.localId ?? undefined;
        try {
          const fenMatch = pgn.match(/\[FEN\s+"([^"]+)"\]/);
          if (fenMatch) setInitialFen(fenMatch[1]);
          loadFromPgn(parseAnnotatedPgn(pgn), extractInitialAnnotations(pgn));
          // KS-3724: state.pgn-путь — это явный «открой эту партию», и в
          // нём заведомо есть PGN-тело. Помечаем pgnLoadedRef, чтобы
          // первый autosave-PATCH ниже не перетёр загруженный PGN
          // ре-сериализацией через chess.js (см. KS-3619 hotfix).
          pgnLoadedRef.current = true;
          // KS-3092: viewer должен встать на `initialPly` (полу-ход,
          // на котором искомая позиция встретилась — by-position click
          // из архива). Используем уже существующий отложенный
          // механизм `pendingPositionRef` — он сработает, как только
          // history populated reducer'ом (см. useEffect ниже,
          // dispatch(GOTO_MOVE)). globalIndex главной линии = ply-1
          // (0-based индекс в `history[]`), см. apiMovesToHistory.
          const initialPly = parseInitialPly(
            location.state,
            analysisSearchParams,
          );
          if (typeof initialPly === 'number') {
            pendingPositionRef.current = initialPly - 1;
          }
        } catch { /* ignore */ }
        setPgnHeaders(parsePgnHeaders(pgn));
      } else if (localIdRef.current) {
        const id = localIdRef.current;
        (publicMode ? getPublicById(id) : getById(id)).then((saved) => {
          // KS-3724: предпочитаем колонку `analyses.fen` (источник
          // истины с момента таска). Регексп по PGN — fallback на
          // случай legacy-записей, где fen хранился ТОЛЬКО в хедере
          // `[FEN "..."]` PGN, а отдельная колонка не заполнялась
          // (до этого тикета — поведение фронта по умолчанию для
          // анализов без ходов).
          if (saved?.fen) {
            setInitialFen(saved.fen);
          }
          if (saved?.pgn) {
            try {
              // Fallback для legacy-записей без `saved.fen`.
              if (!saved.fen) {
                const fenMatch = saved.pgn.match(/\[FEN\s+"([^"]+)"\]/);
                if (fenMatch) setInitialFen(fenMatch[1]);
              }
              loadFromPgn(parseAnnotatedPgn(saved.pgn), extractInitialAnnotations(saved.pgn));
              if (saved.currentPosition != null && saved.currentPosition > 0) {
                pendingPositionRef.current = saved.currentPosition;
              }
              // KS-3724: пометить «PGN был загружен» — это сигнал
              // autosave'у пропустить первый PATCH, чтобы не потерять
              // UTF-8 NAG (см. KS-3619 hotfix). Для фреш-анализа
              // без pgn флаг остаётся false и первый PATCH дойдёт
              // до бэка с актуальным fen.
              pgnLoadedRef.current = true;
            } catch { /* ignore */ }
            setPgnHeaders(parsePgnHeaders(saved.pgn));
          }
          // KS-3046: ориентация доски теперь приходит с бэка
          // (`AnalysisResponse.boardOrientation`, поле добавлено в
          // KS-3045 миграции). `null` — старые записи без сохранённого
          // значения → оставляем дефолт ('white'). Применяем после PGN,
          // потому что getById асинхронен — микро-флэш в стандартной
          // ориентации до ответа допустим (это уже после spinner'а
          // загрузки, а на старых анализах вообще нет переворота).
          if (saved?.boardOrientation === 'white' || saved?.boardOrientation === 'black') {
            setBoardOrientation(saved.boardOrientation);
          }
          if (saved?.title) { setAnalysisTitle(saved.title); setTitleInput(saved.title); }
          // KS-2666: захватываем owner + публичность для share-кнопки.
          if (saved?.userId) setSavedOwnerId(saved.userId);
          if (saved && 'isPublic' in saved) {
            setSavedIsPublic(Boolean((saved as { isPublic?: boolean }).isPublic));
          }
          setLoading(false);
        });
        return;
      }
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        const isAuthenticated = Boolean(localStorage.getItem('token'));
        const requests: [Promise<GameData>, Promise<MoveData[]>, Promise<{ analysisPgn: string | null } | null>] = [
          api.get<GameData>(`/games/${gameId}`),
          api.get<MoveData[]>(`/games/${gameId}/moves`),
          isAuthenticated ? api.get<{ analysisPgn: string | null }>(`/games/${gameId}/analysis`).catch(() => null) : Promise.resolve(null),
        ];
        const [gData, mData, analysisData] = await Promise.all(requests);
        setGameData(gData);
        if (analysisData?.analysisPgn) {
          try { loadFromPgn(parseAnnotatedPgn(analysisData.analysisPgn), extractInitialAnnotations(analysisData.analysisPgn)); } catch { loadMoves(mData); }
        } else { loadMoves(mData); }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('review.loadError'));
      } finally { setLoading(false); }
    };
    fetchData();
    // Safety-net: `analysisId` в deps — при смене `:id` без remount'а
    // обёртки (теоретический edge-case к KS-2403) этот effect перезапустит
    // `getById` с актуальным id, иначе stale-state предыдущей партии
    // оставался бы при любом открытии следующей.
    // KS-3182: `embeddedPgn` тоже в deps — смена PGN в embedded-инстансе
    // должна перезагрузить history. Сам инстанс пересоздаётся через
    // `key={...embedded:embeddedPgn}` в `AnalysisPage`, но deps оставляем
    // ради явности (effect повторно вызовется даже без remount).
  }, [gameId, analysisId, embeddedPgn, location.state, t, loadMoves, loadFromPgn, getById, setInitialFen, analysisSearchParams, publicMode, getPublicById]);

  useAnalysisPersistenceResolver(
    ctx,
    history,
    initialAnnotations,
    annotationsByIndex,
  );

  // KS-2281: ad-hoc autosave (localStorage). Активен только когда нет
  // gameId и нет сохранённого analysisId — для review (gameId) работает
  // useAnalysisPersistence через PUT /games/:id/analysis, для saved
  // (analysisId) — useSavedAnalyses.update; для puzzleFen / "/analysis"
  // / custom-position'а раньше autosave не было совсем.
  //
  // KS-2502: при `navigate('/analysis', { state: { pgn } })` —
  // например клик «Открыть партию» из загруженного PGN-файла или
  // из puzzle-страницы — restore из localStorage перетирал переданный
  // pgn ad-hoc-снимком предыдущей сессии (видна «чужая» партия).
  // Отключаем autosave полностью при наличии `state.pgn` или
  // `puzzleFen`/`puzzlePgn` в URL — это явный сигнал «новая ad-hoc
  // сессия с этими данными», восстанавливать чужой снимок нельзя.
  //
  // KS-2904: жёстко выключаем autosave для не-analysis контекста
  // (review/puzzle), иначе при возврате в эти режимы из ad-hoc-сессии
  // localStorage подгружает чужой снимок. Ad-hoc-сценарий —
  // только `ctx.kind==='analysis'`.
  const stateHasPgn = !!(location.state as { pgn?: string } | null)?.pgn;
  useAdHocAnalysisAutosave({
    enabled:
      ctx.kind === 'analysis' &&
      !gameId &&
      !analysisId &&
      !stateHasPgn &&
      !puzzleFen &&
      !puzzlePgn,
    initialFen,
    history,
    initialAnnotations,
    annotationsByIndex,
    onRestore: useCallback(
      (pgn: string) => {
        try {
          loadFromPgn(parseAnnotatedPgn(pgn), extractInitialAnnotations(pgn));
        } catch {
          /* пропуск битого snapshot'а — autosave best-effort */
        }
      },
      [loadFromPgn],
    ),
  });

  // --- Position save/restore ---
  const suppressPositionSaveRef = useRef(true);

  useEffect(() => {
    if (pendingPositionRef.current == null || history.length === 0) return;
    const target = pendingPositionRef.current;
    const timer = setTimeout(() => {
      pendingPositionRef.current = null;
      const targetMove = searchInHistory(history, target);
      if (targetMove) gotoMove(targetMove);
      setTimeout(() => { suppressPositionSaveRef.current = false; }, 1500);
    }, 100);
    return () => clearTimeout(timer);
  }, [history, gotoNext, gotoFirst]);

  useEffect(() => {
    if (pendingPositionRef.current == null && history.length > 0) {
      suppressPositionSaveRef.current = false;
    }
  }, [history]);

  const positionSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentGlobalIndexRef = useRef(currentGlobalIndex);
  currentGlobalIndexRef.current = currentGlobalIndex;
  const currentFenRef = useRef(currentFen);
  currentFenRef.current = currentFen;

  useEffect(() => {
    if (suppressPositionSaveRef.current) return;
    // KS-2672: в publicMode не сохраняем currentPosition — read-only.
    if (publicMode) return;
    if (positionSaveRef.current) clearTimeout(positionSaveRef.current);
    positionSaveRef.current = setTimeout(() => {
      const id = localIdRef.current;
      if (!id) return;
      const fen = currentFenRef.current;
      let position = currentGlobalIndexRef.current;
      if (fen && fen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
        try {
          const pgn = serializeToAnnotatedPgn(history);
          const reparsed = parseAnnotatedPgn(pgn);
          const idx = findGlobalIndexByFen(reparsed, fen);
          if (idx !== null) position = idx;
        } catch { /* keep runtime index */ }
      }
      updateAnalysis(id, { currentPosition: position }).catch(() => {});
    }, 1000);
    return () => { if (positionSaveRef.current) clearTimeout(positionSaveRef.current); };
  }, [currentGlobalIndex, updateAnalysis, history, publicMode]);

  // Auto-save standalone analysis to API
  const localSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // KS-3619 hotfix: при первой загрузке дубля/saved analysis (новый
  // localId, ещё ни одного autosave) запоминаем сериализованный
  // снапшот и пропускаем первый PATCH — иначе фронт ре-сериализует
  // загруженный PGN через chess.js, теряет UTF-8 NAG (±/⩲/+−/...) и
  // обрезает PGN. Запись делаем только при реальной правке.
  const lastSavedPgnRef = useRef<string | null>(null);
  // KS-3724: первый PATCH пропускаем ТОЛЬКО когда мы действительно
  // загрузили сохранённый PGN (round-trip-safety для UTF-8 NAG). Для
  // фреш-анализа из Мастерской («+ Новый» → POST с пустым pgn) загрузки
  // не было, и первый PATCH после пользовательского `setInitialFen`
  // обязан долететь до бэка — иначе кастомная стартовая позиция
  // теряется при reload (см. описание KS-3724).
  const pgnLoadedRef = useRef(false);
  const hasPgnHeaders = Object.keys(pgnHeaders).length > 0;
  const hasInitialAnnotations = !!initialAnnotations;
  useEffect(() => {
    if (!user) return;
    if (gameId) return;
    // KS-2672: в publicMode autosave полностью выключен — не-владелец
    // не должен случайно мутировать чужой анализ. Авторизованный
    // владелец, открывший public-URL своего анализа, тоже read-only —
    // для редактирования пусть перейдёт на /analysis/:id.
    if (publicMode) return;
    // KS-3724: `hasCustomFen` — кастомная стартовая позиция,
    // выставленная пользователем через «Установить позицию», тоже
    // должна триггерить autosave даже когда история ходов пустая и
    // нет ни PGN-заголовков, ни startup-аннотаций. Без этого
    // условия autosave молча возвращался — и FEN терялся при
    // reload (root cause KS-3724).
    const hasCustomFen = initialFen !== DEFAULT_FEN;
    if (
      history.length === 0 &&
      !hasPgnHeaders &&
      !hasInitialAnnotations &&
      !hasCustomFen
    ) return;
    if (positionSaveRef.current) { clearTimeout(positionSaveRef.current); positionSaveRef.current = null; }
    if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current);

    localSaveTimerRef.current = setTimeout(async () => {
      // KS-2152: initialAnnotations попадают в leading-комментарий PGN
      const movesOnly = serializeToAnnotatedPgn(history, initialAnnotations, annotationsByIndex);
      const pgn = buildPgnWithFen(movesOnly, initialFen, pgnHeaders);
      // KS-3724: кастомная стартовая позиция уходит отдельной колонкой
      // `analyses.fen` (см. CreateAnalysisRequest / UpdateAnalysisRequest).
      // Отправляем поле ТОЛЬКО когда FEN отличается от стандартной
      // начальной позиции — это совпадает с серверным DTO `fen?: string`
      // (отдельная семантика «сбросить в null» в текущей версии бэка
      // не нужна: для нового анализа `analyses.fen` уже null).
      if (!localIdRef.current) {
        try {
          const category = gameId ? 'game_review' : puzzleFen ? 'puzzle' : 'analysis';
          const entry = await createAnalysis(
            pgn,
            analysisTitle,
            category,
            // POST принимает только определённое значение fen — иначе
            // оставляем undefined, бэк по умолчанию пишет null.
            hasCustomFen ? initialFen : undefined,
          );
          localIdRef.current = entry.id;
          window.history.replaceState(null, '', '/analysis/' + entry.id);
          // KS-3046: до этого момента у анализа не было id и PATCH
          // в `flipBoardOrientation` был no-op (id отсутствовал в БД).
          // Если пользователь успел перевернуть доску в ad-hoc-сессии до
          // первого autosave — догоняем текущую ориентацию отдельным
          // PATCH под новым id. Отправляем только не-дефолт ('black'),
          // т.к. backend для новых записей кладёт null (= 'white' на
          // фронте), лишний апдейт на 'white' не нужен.
          if (boardOrientationRef.current === 'black') {
            updateAnalysis(entry.id, { boardOrientation: 'black' }).catch(() => {});
          }
          // KS-2669: только что создали анализ — мы автор. Установим
          // savedOwnerId сразу, чтобы Share-кнопка появилась без
          // ожидания дополнительного getById. savedIsPublic=false
          // по умолчанию у новых анализов.
          if (entry.userId) setSavedOwnerId(entry.userId);
          setSavedIsPublic(
            Boolean((entry as { isPublic?: boolean }).isPublic),
          );
        } catch { /* ignore */ }
      } else {
        // KS-3619 hotfix: первый snapshot после загрузки не пишем
        // (см. lastSavedPgnRef комментарий выше). Если pgn не
        // изменился с прошлого сохранения — тоже пропускаем (нет
        // смысла генерировать запросы).
        //
        // KS-3724: пропуск действует ТОЛЬКО когда мы реально загрузили
        // PGN из БД (`pgnLoadedRef.current === true`). Для фреш-анализа
        // из Мастерской pgn не был загружен — первый PATCH с актуальным
        // fen обязан долететь до бэка, иначе кастомная стартовая
        // позиция теряется (root cause тикета).
        if (lastSavedPgnRef.current === null) {
          lastSavedPgnRef.current = pgn;
          if (pgnLoadedRef.current) return;
        } else {
          if (lastSavedPgnRef.current === pgn) return;
          lastSavedPgnRef.current = pgn;
        }
        let savedPosition: number | null = null;
        const fen = currentFenRef.current;
        if (fen && fen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
          try {
            const reparsed = parseAnnotatedPgn(pgn);
            savedPosition = findGlobalIndexByFen(reparsed, fen);
          } catch { savedPosition = currentGlobalIndexRef.current; }
        }
        updateAnalysis(localIdRef.current, {
          pgn,
          ...(hasCustomFen && { fen: initialFen }),
          ...(savedPosition != null && { currentPosition: savedPosition }),
        }).catch(() => {});
      }
      // KS-2152: debounce 600мс — иначе пользователь успевает перезагрузить
      // страницу до сохранения, и при reload подгружается старый PGN с
      // прошлыми аннотациями (выглядит как «цвет стрелки сменился сам»).
    }, 600);
    return () => { if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current); };
  }, [gameId, history, analysisTitle, initialFen, pgnHeaders, hasPgnHeaders, hasInitialAnnotations, initialAnnotations, annotationsByIndex, createAnalysis, updateAnalysis]);

  // KS-2152: при unload/visibility hidden flush'им несохранённое — чтобы
  // ALT-tab или close window не съели только что нарисованные аннотации.
  const flushSaveOnHide = useCallback(() => {
    if (!user) return;
    if (gameId) return;
    // KS-2672: в publicMode не сохраняем PGN на unload — read-only.
    if (publicMode) return;
    if (!localIdRef.current) return;
    // KS-3724: учитываем кастомный FEN в guard'е unload-flush — иначе
    // пользователь, который успел задать позицию и сразу закрыл вкладку
    // до debounce'а 600мс, всё равно потеряет старт-позицию.
    const hasCustomFen = initialFen !== DEFAULT_FEN;
    if (
      history.length === 0 &&
      !hasPgnHeaders &&
      !hasInitialAnnotations &&
      !hasCustomFen
    ) return;
    if (localSaveTimerRef.current) {
      clearTimeout(localSaveTimerRef.current);
      localSaveTimerRef.current = null;
    }
    const movesOnly = serializeToAnnotatedPgn(history, initialAnnotations, annotationsByIndex);
    const pgn = buildPgnWithFen(movesOnly, initialFen, pgnHeaders);
    // KS-3724: тот же контракт, что у debounced autosave выше —
    // отдельная колонка `analyses.fen` отправляется ТОЛЬКО когда
    // стартовая позиция кастомная.
    const body: { pgn: string; fen?: string } = {
      pgn,
      ...(hasCustomFen && { fen: initialFen }),
    };
    // sendBeacon — единственный надёжный способ сохранить во время unload.
    try {
      const url = `${import.meta.env.VITE_API_URL ?? ''}/analyses/${localIdRef.current}`;
      const token = localStorage.getItem('token');
      const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      // sendBeacon does PATCH-like POST; fallback на updateAnalysis
      if (navigator.sendBeacon && !token) {
        navigator.sendBeacon(url, blob);
      } else {
        updateAnalysis(localIdRef.current, body).catch(() => {});
      }
    } catch {
      updateAnalysis(localIdRef.current, body).catch(() => {});
    }
  }, [user, gameId, history, hasPgnHeaders, hasInitialAnnotations, initialFen, pgnHeaders, initialAnnotations, annotationsByIndex, updateAnalysis, publicMode]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushSaveOnHide();
    };
    window.addEventListener('pagehide', flushSaveOnHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flushSaveOnHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flushSaveOnHide]);

  useEffect(() => { game.load(currentFen); }, [currentFen, game]);

  // KS-3682. Выставляем currentFen в window.__sfTraceFen для devtools-
  // утилиты `window.__sfTrace()` — пользователь из консоли браузера
  // может получить массив positional_subterms по текущей позиции на
  // доске, чтобы проверить работу stockfish-16-trace.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__sfTraceFen = currentFen;
    }
  }, [currentFen]);

  // --- Promotion detection ---
  const isPromotionMove = useCallback((from: string, to: string): boolean => {
    const piece = game.get(from as Square);
    if (!piece || piece.type !== 'p') return false;
    const targetRank = to[1];
    return (piece.color === 'w' && targetRank === '8') || (piece.color === 'b' && targetRank === '1');
  }, [game]);

  const handlePromotionChoice = useCallback((piece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromotion) return;
    makeVariantMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }, [pendingPromotion, makeVariantMove]);

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  // --- Engine control ---
  const toggleAnalysis = useCallback(() => {
    setAnalysisEnabled((prev) => {
      const next = !prev;
      if (prev) { stopEngine(); } else { setEngineFailed(false); }
      try { localStorage.setItem('analysisRunning', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // KS-3696. Реализация ref-функции «приостановить движок при
  // схлопывании engine-панели». Если анализ активен — выключаем (то же
  // самое, что нажать кнопку «Стоп»); если уже выключен — ничего не
  // делаем. Stockfish-воркер остаётся, при повторном открытии engine
  // пользователь нажмёт «Старт» и анализ возобновится.
  pauseEngineForAccordionRef.current = () => {
    setAnalysisEnabled((cur) => {
      if (!cur) return cur;
      stopEngine();
      try {
        localStorage.setItem('analysisRunning', 'false');
      } catch {
        /* ignore */
      }
      return false;
    });
  };

  // KS-3680/KS-3685/KS-3687/KS-3703: контроллер AI-комментария позиции
  // для отдельной вкладки/блока «AI». В options два ключевых параметра:
  //   - `engineBestLine` — снимок displayedLines[0] для случая, когда
  //     движок уже думает и линия есть;
  //   - `engineProbe`    — обязательный путь при выключенном анализе:
  //     включаем движок, ждём `isReady` + первую линию + ~1 с думания
  //     (потолок 7 с, чтобы укладываться в ENGINE_PROBE_TIMEOUT_MS=8 с
  //     с запасом). Возвращаем линию и выключаем движок, если включали.
  //     Если линия так и не пришла — `null`, хук уходит в KS-3685-
  //     поведение (запрос без `sf18_eval`/`sf18_pv`).
  const displayedLinesRef = useRef(displayedLines);
  displayedLinesRef.current = displayedLines;
  const analysisEnabledRef = useRef(analysisEnabled);
  analysisEnabledRef.current = analysisEnabled;
  const currentFenForProbeRef = useRef(currentFen);
  currentFenForProbeRef.current = currentFen;
  // KS-3702 повторное открытие: `displayedLines[0]` принадлежит позиции
  // `analysisFen`, которая может отставать от `currentFen` сразу после
  // перехода по дереву (движок ещё думает над предыдущим ходом, новые
  // линии не пришли). Если в этот момент взять `score` из старой линии,
  // нормализация со стороны белых (`useAiPositionComment`) применит
  // инверсию по второму полю нового `currentFen` — а сам знак числа уже
  // относится к другой позиции с другим side-to-move. Итог: в запрос
  // ИИ уходит мусорный знак. Защита — сравнить `analysisFen` с текущим.
  const analysisFenForProbeRef = useRef(analysisFen);
  analysisFenForProbeRef.current = analysisFen;
  const engineProbeForAi = useCallback(async () => {
    const ready = displayedLinesRef.current[0];
    const readyFenMatches =
      analysisFenForProbeRef.current === currentFenForProbeRef.current;
    if (ready && readyFenMatches) {
      return {
        depth: ready.depth,
        multipv: ready.multipv,
        score: ready.score,
        pv: ready.pv,
      };
    }
    const wasOff = !analysisEnabledRef.current;
    if (wasOff) toggleAnalysis();
    const fenAtStart = currentFenForProbeRef.current;
    const start = performance.now();
    const POLL_MS = 80;
    // KS-3703: при холодном WASM-движке инициализация (`isReady`) сама по
    // себе занимает 1–2 секунды, плюс хочется дать ~1 с настоящего думания.
    // Старого потолка 2 с не хватало — probe возвращал `null`, `sf18_*`
    // в payload не попадали. 7 с укладывается в ENGINE_PROBE_TIMEOUT_MS=8 с
    // (см. useAiPositionComment.ts) с запасом на сетевые задержки.
    const WAIT_MAX_MS = 7000;
    return new Promise<{
      depth: number;
      multipv: number;
      score: { type: 'cp' | 'mate'; value: number };
      pv: string;
    } | null>((resolve) => {
      const interval = setInterval(() => {
        const elapsed = performance.now() - start;
        const fenStillSame =
          currentFenForProbeRef.current === fenAtStart;
        if (!fenStillSame) {
          clearInterval(interval);
          if (wasOff && analysisEnabledRef.current) toggleAnalysis();
          resolve(null);
          return;
        }
        const line = displayedLinesRef.current[0];
        // KS-3702 повторное открытие: линию принимаем только если она
        // относится к ТЕКУЩЕЙ позиции. Иначе знак нормализуется не той
        // стороной — см. комментарий выше.
        const lineFenMatches =
          analysisFenForProbeRef.current === fenAtStart;
        if (line && lineFenMatches && elapsed >= 1000) {
          clearInterval(interval);
          if (wasOff && analysisEnabledRef.current) toggleAnalysis();
          resolve({
            depth: line.depth,
            multipv: line.multipv,
            score: line.score,
            pv: line.pv,
          });
          return;
        }
        if (elapsed >= WAIT_MAX_MS) {
          clearInterval(interval);
          if (wasOff && analysisEnabledRef.current) toggleAnalysis();
          if (line && lineFenMatches) {
            resolve({
              depth: line.depth,
              multipv: line.multipv,
              score: line.score,
              pv: line.pv,
            });
          } else {
            resolve(null);
          }
        }
      }, POLL_MS);
    });
  }, [toggleAnalysis]);

  const aiPositionComment = useAiPositionComment({
    fen: currentFen,
    user: user ? { id: user.id } : null,
    // KS-3725: `currentGlobalIndex` — это сквозной счётчик по всему
    // дереву (mainline + variations), а `history[]` содержит только
    // mainline. После первой же вариации индексы в mainline начинают
    // расходиться с globalIndex (вариации тоже инкрементируют счётчик
    // в `parseAnnotatedPgn`), поэтому `history[currentGlobalIndex]`
    // промахивается уже на 2-м и 3-м комментарии «полного разбора» в
    // PGN — пользователь видел корректный текст только на первом ходе
    // до любой вариации. `searchInHistory` рекурсивно ходит по дереву
    // (см. ChessHistoryUtils.ts) и возвращает узел по globalIndex
    // независимо от того, mainline это или ветка.
    fullReviewComment:
      (searchInHistory(history, currentGlobalIndex) as ChessMove | null)?.comment ?? null,
    language: aiCommentLanguage,
    // KS-3702 повторное открытие: пробрасываем `engineBestLine` только
    // если линия относится к текущему FEN. Иначе хук нормализует знак
    // по второму полю `currentFen`, а число пришло от другой позиции
    // (другого side-to-move) — в payload улетает мусорный знак.
    engineBestLine:
      displayedLines[0] && analysisFen === currentFen
        ? {
            depth: displayedLines[0].depth,
            multipv: displayedLines[0].multipv,
            score: displayedLines[0].score,
            pv: displayedLines[0].pv,
          }
        : null,
    engineProbe: engineProbeForAi,
  });

  // KS-3726. Текущий комментарий узла дерева, на котором стоит
  // пользователь — нужен и для AI-панели (показать «Добавлено» когда
  // AI-текст уже в комментарии), и для handleAddAiCommentToMove
  // (merge с существующим). `searchInHistory` ходит по mainline +
  // recursive variations (см. KS-3725) и возвращает узел по globalIndex.
  const currentMoveCommentForAi: string | null =
    (searchInHistory(history, currentGlobalIndex) as ChessMove | null)
      ?.comment ?? null;
  const handleAddAiCommentToMove = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const move = searchInHistory(history, currentGlobalIndex) as
        | ChessMove
        | null;
      if (!move) return;
      const existing = (move.comment ?? '').trim();
      // Идемпотентность: если AI-текст уже в комментарии — ничего не
      // делаем (AiPositionCommentPanel и сам показывает «Добавлено»,
      // disabled, но защита нужна на случай прямого вызова).
      if (existing.includes(trimmed)) return;
      const merged = existing.length === 0 ? trimmed : `${existing}\n${trimmed}`;
      // setComment лежит в reducer'е useReviewState и использует
      // searchInHistory внутри — ок для веток. PGN обновится в
      // следующем рендере, autosave-effect (см. KS-3724) подхватит
      // изменение и сделает PATCH /analyses/:id.
      setComment(move.globalIndex, merged);
    },
    [history, currentGlobalIndex, setComment],
  );

  useEffect(() => {
    if (sfState === 'error' && analysisEnabled) {
      if (ec.engineSource === 'external') {
        const timer = setTimeout(() => {
          ec.setEngineSource('wasm');
          ec.setExternalConfig(null);
        }, 3000);
        return () => clearTimeout(timer);
      } else {
        // KS-3067: для wasm-ошибки НЕ сбрасываем analysisEnabled — иначе
        // EngineLoader-плашка с понятным сообщением и кнопкой
        // «Попробовать снова» сразу скрывается, пользователь видит лишь
        // суффикс «Ошибка движка» в заголовке. engineFailed-флаг
        // продолжаем выставлять — он нужен для touch-device fallback.
        setEngineFailed(true);
      }
    }
    return undefined;
  }, [sfState, analysisEnabled, ec.engineSource]);

  const initialMountRef = useRef(true);

  useEffect(() => {
    if (!analysisEnabled || !isReady || !currentFen) return;
    if (initialMountRef.current && ec.engineSource === 'external' && sfState === 'analyzing') {
      initialMountRef.current = false;
      return;
    }
    initialMountRef.current = false;
    const timer = setTimeout(() => { evaluate(currentFen); }, 150);
    return () => clearTimeout(timer);
  }, [currentFen, isReady, evaluate, analysisEnabled, ec.engineSource]);

  // KS-1576: helper — вычисляет следующий ход основной линии и альтернативные ветки
  const getNextOptions = useCallback((): { mainLine: ChessMove; variations: ChessMove[][] } | null => {
    let mainLine: ChessMove | null = null;
    if (currentMove === null) {
      if (history.length === 0) return null;
      mainLine = history[0] as ChessMove;
    } else {
      if (!currentMove.next) return null;
      mainLine = currentMove.next as ChessMove;
    }
    const variations = (mainLine.variations ?? []) as ChessMove[][];
    return { mainLine, variations };
  }, [currentMove, history]);

  const handleArrowRight = useCallback(() => {
    // Если окошко выбора уже открыто — ничего не делаем (сценарий: повторное нажатие не открывает второе)
    if (variationChooser) return;
    const options = getNextOptions();
    if (!options) {
      gotoNext();
      return;
    }
    if (options.variations.length > 0) {
      setVariationChooser(options);
      return;
    }
    gotoNext();
  }, [variationChooser, getNextOptions, gotoNext]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Пока открыт variation chooser — он сам управляет клавиатурой
      if (variationChooser) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); gotoPrevious(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); handleArrowRight(); }
      else if (e.key === 'Home') { e.preventDefault(); gotoFirst(); }
      else if (e.key === 'End') { e.preventDefault(); gotoLast(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gotoPrevious, handleArrowRight, gotoFirst, gotoLast, variationChooser]);

  // Close overflow menu on click outside
  useEffect(() => {
    if (!showOverflowMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showOverflowMenu]);

  // KS-2220: сериализация PGN вынесена из handleExportPgn в общий
  // helper, чтобы handleCopyPgn использовал ровно тот же текст, что и
  // скачивание файла (включая заголовки + аннотации).
  const buildAnalysisPgn = useCallback((): string | null => {
    if (history.length === 0) return null;
    const headers: string[] = [];
    headers.push(`[Event "${pgnHeaders['Event'] || analysisTitle || 'Analysis'}"]`);
    headers.push(`[Site "${pgnHeaders['Site'] || 'Kingside'}"]`);
    headers.push(`[Date "${pgnHeaders['Date'] || new Date().toISOString().slice(0, 10).replace(/-/g, '.')}"]`);
    if (pgnHeaders['Round']) headers.push(`[Round "${pgnHeaders['Round']}"]`);
    if (pgnHeaders['White']) headers.push(`[White "${pgnHeaders['White']}"]`);
    if (pgnHeaders['Black']) headers.push(`[Black "${pgnHeaders['Black']}"]`);
    headers.push(`[Result "${pgnHeaders['Result'] || '*'}"]`);
    if (pgnHeaders['WhiteElo']) headers.push(`[WhiteElo "${pgnHeaders['WhiteElo']}"]`);
    if (pgnHeaders['BlackElo']) headers.push(`[BlackElo "${pgnHeaders['BlackElo']}"]`);
    if (initialFen !== DEFAULT_FEN) {
      // KS-2828: пара `[SetUp "1"][FEN ...]` обязательна по PGN §9.7.3.
      headers.push(`[SetUp "1"]`);
      headers.push(`[FEN "${initialFen}"]`);
    }
    // KS-2152: initialAnnotations попадают в leading-комментарий, а
    // node-annotations берутся из annotationsByIndex (state useReviewState).
    const moves = serializeToAnnotatedPgn(history, initialAnnotations, annotationsByIndex);
    return headers.join('\n') + '\n\n' + moves + '\n';
  }, [history, analysisTitle, initialFen, pgnHeaders, initialAnnotations, annotationsByIndex]);

  // KS-3755 / ADR-112: обработчики управления трансляцией. Переехали из
  // верхнего LiveBroadcastControl-блока в пункты AnalysisActionsMenu —
  // выносим в стабильные useCallback'и, чтобы передавать в
  // buildAnalysisActionsItems без перерасчёта items на каждый рендер.
  const handleLiveStart = useCallback(() => {
    if (!analysisId) return;
    void liveBroadcast.start(analysisId);
  }, [analysisId, liveBroadcast]);
  const handleLiveSaveAndStart = useCallback(() => {
    if (liveBroadcast.isStarting) return;
    // Race: autosave мог успеть создать запись раньше клика.
    const existingId = localIdRef.current;
    if (existingId) {
      void liveBroadcast.start(existingId);
      return;
    }
    const pgn = buildAnalysisPgn() ?? '';
    const category =
      gameId ? 'game_review' : puzzleFen ? 'puzzle' : 'analysis';
    const hasCustomFen = initialFen !== DEFAULT_FEN;
    void (async () => {
      try {
        const entry = await createAnalysis(
          pgn,
          analysisTitle,
          category,
          hasCustomFen ? initialFen : undefined,
        );
        localIdRef.current = entry.id;
        window.history.replaceState(null, '', '/analysis/' + entry.id);
        if (entry.userId) setSavedOwnerId(entry.userId);
        setSavedIsPublic(
          Boolean((entry as { isPublic?: boolean }).isPublic),
        );
        void liveBroadcast.start(entry.id);
      } catch {
        /* error попадёт в liveBroadcast.error через хук */
      }
    })();
  }, [
    analysisTitle,
    buildAnalysisPgn,
    createAnalysis,
    gameId,
    initialFen,
    liveBroadcast,
    puzzleFen,
  ]);
  const handleLiveCopyLink = useCallback(async () => {
    if (!liveBroadcast.publicUrl) return;
    try {
      await navigator.clipboard.writeText(liveBroadcast.publicUrl);
    } catch {
      /* clipboard может быть закрыт permissions — игнорируем */
    }
  }, [liveBroadcast.publicUrl]);
  const handleLiveStop = useCallback(() => {
    liveBroadcast.stop();
  }, [liveBroadcast]);

  // KS-3749 / ADR-111 §7. Авторский emit `state-patch`. Запускается на
  // любое изменение review-state (новые ходы, NAGs, комментарии,
  // вариации, стрелки, headers, переключение currentPly, переворот
  // доски). Хук `useAnalysisLiveBroadcast` сам глушит шквал
  // trailing-edge дебаунсом 500 мс и не отправляет дубликаты — мы
  // здесь просто кормим его актуальным snapshot'ом каждый рендер,
  // когда live-сессия активна.
  //
  // Emit `move` уже мгновенен (обёртка `makeVariantMove` выше зовёт
  // `liveBroadcast.emitMove(uci)` сразу после успешного хода — это
  // быстрая анимация у зрителей до прихода state-patch'а).
  useEffect(() => {
    // KS-3770: на странице зрителя (/live/:slug → liveSession.mode='viewer')
    // эмит state-patch'ей запрещён — это не наша трансляция, мы только
    // её отображаем. У авторизованного владельца без этого гейта возник
    // бы feedback-цикл: REST-restore поднимает его трансляцию (даже
    // несмотря на disabled-флаг хука, береги и здесь явный гейт),
    // и зрительский state улетал бы обратно как авторский patch.
    if (isViewerLive) return;
    if (!liveBroadcast.isLive) return;
    // KS-3763 / ADR-112: «тихий» restore больше невозможен — slug
    // приходит только от REST-восстановления по analysisId, то есть
    // ровно для этой страницы. Дополнительный гейт против отравления
    // чужой трансляции, добавленный в KS-3754, больше не нужен:
    // backend гарантирует партицию (userId, analysisId).
    const pgn = buildAnalysisPgn();
    if (!pgn) return;
    liveBroadcast.emitStatePatch({
      pgn,
      headers: pgnHeaders,
      currentPly: currentMove?.ply ?? 0,
      orientation: boardOrientation,
    });
  }, [
    isViewerLive,
    liveBroadcast,
    buildAnalysisPgn,
    pgnHeaders,
    currentMove,
    boardOrientation,
  ]);

  // Export PGN handler
  const handleExportPgn = useCallback(() => {
    try {
      const pgn = buildAnalysisPgn();
      if (pgn === null) return;
      const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(analysisTitle || 'analysis').replace(/[^a-zA-Z0-9_-]/g, '_')}.pgn`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (err) {
      console.error('[Export PGN] Failed:', err);
    }
  }, [buildAnalysisPgn, analysisTitle]);

  // KS-2220: handleCopyPgn — копирует тот же PGN, что и handleExportPgn,
  // в буфер обмена через `navigator.clipboard.writeText`. Inline-сообщение
  // возле кнопок (success/error) автоматически скрывается через 1.8 сек.
  const handleCopyPgn = useCallback(async () => {
    const pgn = buildAnalysisPgn();
    if (pgn === null) return;
    try {
      await navigator.clipboard.writeText(pgn);
      setPgnCopyMsg(t('review.pgnCopied', 'PGN copied to clipboard'));
    } catch (err) {
      console.error('[Copy PGN] Failed:', err);
      setPgnCopyMsg(t('review.pgnCopyError', 'Failed to copy PGN'));
    }
    if (pgnCopyTimerRef.current) {
      window.clearTimeout(pgnCopyTimerRef.current);
    }
    pgnCopyTimerRef.current = window.setTimeout(() => setPgnCopyMsg(null), 1800);
  }, [buildAnalysisPgn, t]);

  // KS-3299 (M2 F5) + KS-3302: «Использовать как репертуар». POST
  // /opening-trainer/repertoires/from-analysis передаёт id + side —
  // backend сам берёт PGN из Analysis (owner-check). При успехе
  // редиректим на /opening-trainer/:id. При ошибке — alert.
  //
  // KS-3302: открываем небольшой inline-picker для выбора стороны
  // (side фиксируется при создании репертуара).
  const [creatingRepertoire, setCreatingRepertoire] = useState(false);
  const [sidePickerOpen, setSidePickerOpen] = useState(false);
  const handleUseAsRepertoire = useCallback(
    async (side: 'white' | 'black') => {
      if (creatingRepertoire) return;
      if (!localIdRef.current) return;
      setCreatingRepertoire(true);
      setSidePickerOpen(false);
      try {
        const repertoire = await openingTrainerApi.createRepertoireFromAnalysis({
          analysisId: localIdRef.current,
          title: analysisTitle || undefined,
          side,
        });
        navigate(`/opening-trainer/${repertoire.id}`);
      } catch (err) {
        const msg =
          err instanceof ApiErrorClass
            ? err.message
            : t(
                'analysis.useAsRepertoire.error',
                'Failed to create repertoire from this analysis.',
              );
        window.alert(msg);
        setCreatingRepertoire(false);
      }
    },
    [creatingRepertoire, analysisTitle, navigate, t],
  );

  // KS-3331 (ADR-078 §5.3): «Добавить в существующий репертуар…». Список
  // репертуаров грузим лениво при открытии overflow-меню (только для
  // владельца своего анализа) — чтобы знать, не пуст ли он (пункт меню
  // disabled при пустом). Выбор репертуара → POST from-analysis с
  // `repertoireId` → backend добавляет PGN анализа как источник и
  // возвращает обновлённый репертуар; редиректим на его страницу.
  const [repertoires, setRepertoires] = useState<
    Array<OpeningRepertoireDto | OpeningRepertoireWithStatsDto> | null
  >(null);
  const [repertoiresLoading, setRepertoiresLoading] = useState(false);
  const [addToRepertoireOpen, setAddToRepertoireOpen] = useState(false);
  const [addingToRepertoireId, setAddingToRepertoireId] = useState<string | null>(
    null,
  );
  const loadRepertoires = useCallback(async () => {
    if (repertoires !== null || repertoiresLoading) return;
    setRepertoiresLoading(true);
    try {
      const res = await openingTrainerApi.listRepertoires();
      setRepertoires(res.repertoires);
    } catch {
      // Сеть/доступ — оставляем пустой список (пункт станет disabled).
      setRepertoires([]);
    } finally {
      setRepertoiresLoading(false);
    }
  }, [repertoires, repertoiresLoading]);

  const handleAddToExistingRepertoire = useCallback(
    async (repertoireId: string) => {
      if (addingToRepertoireId) return;
      if (!localIdRef.current) return;
      setAddingToRepertoireId(repertoireId);
      try {
        const repertoire = await openingTrainerApi.createRepertoireFromAnalysis({
          analysisId: localIdRef.current,
          title: analysisTitle || undefined,
          repertoireId,
        });
        navigate(`/opening-trainer/${repertoire.id}`);
      } catch (err) {
        const msg =
          err instanceof ApiErrorClass
            ? err.message
            : t(
                'analysis.useAsRepertoire.addError',
                'Failed to add analysis to the repertoire.',
              );
        window.alert(msg);
        setAddingToRepertoireId(null);
      }
    },
    [addingToRepertoireId, analysisTitle, navigate, t],
  );

  // Очистка таймера при unmount, чтобы setState не дёргался на размонтированный компонент.
  useEffect(() => {
    return () => {
      if (pgnCopyTimerRef.current) {
        window.clearTimeout(pgnCopyTimerRef.current);
      }
    };
  }, []);

  // --- Board setup ---
  const stablePosition = useStablePosition(currentFen);
  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const onClickMove = useCallback(
    (from: Square, to: Square): boolean => {
      if (isPromotionMove(from, to)) {
        // KS-3098: убрана повторная валидация через `new Chess(currentFen)` +
        // `testGame.move(...)` — `useBoardHighlights.onSquareClick` уже
        // отфильтровал нелегальные клики через `game.moves({ square })`
        // перед вызовом `onMove`. Лишний парс FEN добавлял десятки мс
        // к open-frame'у диалога и создавал ощущение фриза.
        setPendingPromotion({ from, to });
        return true;
      }
      return makeVariantMove(from, to);
    },
    [makeVariantMove, isPromotionMove],
  );

  const { squareStyles, arrows, lastMoveSquares, setLastMove, onSquareClick, setSuggestedArrow } = useBoardHighlights({
    game, playerColor: null, enabled: true,
    onMove: onClickMove,
  });

  // KS-2152: highlight-стили для клеток из текущей ноды/стартовой позиции.
  // Сама логика toggle (ПКМ-click и ПКМ-drag) теперь в handleBoardMouseUp —
  // это единая точка, чтобы Chrome contextmenu (пуляющийся на mousedown)
  // не подсвечивал start-клетку при ПКМ-drag.
  const highlightStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    const list = currentAnnotations?.highlights;
    if (list) {
      for (const h of list) {
        styles[h.square] = { backgroundColor: HIGHLIGHT_COLORS[h.color] };
      }
    }
    return styles;
  }, [currentAnnotations]);

  // KS-2152: запоминаем start-клетку для последующего mouseUp.
  // onSquareRightClick library НЕ используется — Chrome шлёт contextmenu
  // на mousedown right (до завершения drag), library тут же вызывает
  // onSquareRightClick на START-клетке, и highlight приклеивается к
  // начальной клетке стрелки. Поэтому весь right-click-функционал
  // (highlight + drag-toggle стрелок) обрабатываем в одной точке —
  // в handleBoardMouseUp.
  const handleBoardMouseDown = useCallback(
    (_args: { square: string }, e: React.MouseEvent) => {
      if (e.button === 2) {
        arrowDragStartRef.current = _args.square;
        arrowDragModsRef.current = {
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        };
        // KS-2157: фиксируем цвет preview по модификаторам в момент mousedown.
        // Library знает Shift и Ctrl — для них устанавливаются
        // secondaryColor/tertiaryColor в arrowOptions. Alt library не
        // различает: при Alt-only подменяем default `color` на синий, чтобы
        // preview совпадал с финальным.
        if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          setPreviewDefaultColor(HIGHLIGHT_COLORS.blue);
        } else {
          setPreviewDefaultColor(HIGHLIGHT_COLORS.red);
        }
      }
    },
    [],
  );

  const handleBoardMouseUp = useCallback(
    (args: { square: string }, e: React.MouseEvent) => {
      const dragStart = arrowDragStartRef.current;
      const dragMods = arrowDragModsRef.current;
      arrowDragStartRef.current = null;
      arrowDragModsRef.current = null;
      if (e.button !== 2 || !dragStart) return;

      // Используем модификаторы из mouseDown (пользователь мог отпустить
      // клавишу до отпускания мыши); если по какой-то причине ref пуст —
      // fallback на текущее состояние event'а.
      const mods = dragMods ?? {
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      };

      const highlightsCurrent = currentAnnotations?.highlights;
      const arrowsCurrent = currentAnnotations?.arrows;

      if (dragStart === args.square) {
        // Одиночный ПКМ-клик по той же клетке → toggle highlight.
        const color: AnnotationColor = annotationColorByModifiers(mods);
        const list = highlightsCurrent ?? [];
        const idx = list.findIndex((h) => h.square === args.square);
        let newHighlights: SquareHighlight[];
        if (idx >= 0 && list[idx].color === color) {
          newHighlights = list.slice(0, idx).concat(list.slice(idx + 1));
        } else if (idx >= 0) {
          newHighlights = list.slice();
          newHighlights[idx] = { square: args.square, color };
        } else {
          newHighlights = list.concat({ square: args.square, color });
        }
        const next: NodeAnnotations | undefined =
          newHighlights.length === 0 && (!arrowsCurrent || arrowsCurrent.length === 0)
            ? undefined
            : {
                ...(newHighlights.length > 0 && { highlights: newHighlights }),
                ...(arrowsCurrent && { arrows: arrowsCurrent }),
              };
        setAnnotationsForCurrent(next);
        return;
      }

      // Drag — toggle стрелки.
      const list = arrowsCurrent ?? [];
      const idx = list.findIndex((a) => a.from === dragStart && a.to === args.square);
      let newArrows: ArrowAnnotation[];
      if (idx >= 0) {
        newArrows = list.slice(0, idx).concat(list.slice(idx + 1));
      } else {
        const color: AnnotationColor = annotationColorByModifiers(mods);
        newArrows = list.concat({ from: dragStart, to: args.square, color });
      }
      const next: NodeAnnotations | undefined =
        newArrows.length === 0 && (!highlightsCurrent || highlightsCurrent.length === 0)
          ? undefined
          : {
              ...(highlightsCurrent && { highlights: highlightsCurrent }),
              ...(newArrows.length > 0 && { arrows: newArrows }),
            };
      setAnnotationsForCurrent(next);
    },
    [currentAnnotations, setAnnotationsForCurrent],
  );

  // KS-2152: стрелки обрабатываем сами через onSquareMouseDown/MouseUp.
  //
  // Полагаться на library `onArrowsChange` нельзя: react-chessboard в своём
  // drawArrow проверяет `arrows.some((a) => a.startSquare === ... && a.endSquare === ...)`
  // (внешний `arrows`-prop) и если стрелка там есть — РАННИЙ return,
  // internal не меняется, onArrowsChange не вызывается. Это блокирует
  // повторный drag по сохранённой стрелке (toggle off). Поэтому всю
  // логику drag-toggle ведём на нашей стороне:
  //  - onSquareMouseDown с button=2 → запоминаем `from`-клетку;
  //  - onSquareMouseUp с button=2 на ДРУГОЙ клетке → drag завершён,
  //    делаем toggle в state.annotationsByIndex;
  //  - mouseUp на той же клетке → одиночный ПКМ-клик, library сама
  //    вызовет onSquareRightClick (наш highlight-toggle).
  // А `onArrowsChange` оставляем no-op — нам ничего не надо синхронизировать
  // от library, она лишь визуально дублирует наш external arrows до
  // ремоунта (см. `annotationsKey`).
  const arrowDragStartRef = useRef<string | null>(null);
  // KS-2152: модификаторы клавиатуры запоминаются в mouseDown — пользователь
  // мог отпустить Shift/Alt/Ctrl до того, как отпустил мышь, и mouseUp event
  // уже не содержит флага. Финальный цвет аннотации должен быть тем, что
  // был зафиксирован в начале действия.
  const arrowDragModsRef = useRef<{
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  } | null>(null);

  // KS-2157: цвет preview-стрелки (library default `color`) во время drag.
  // Library сама умеет Shift → secondaryColor и Ctrl → tertiaryColor.
  // Alt library не различает — для Alt подменяем default `color` на синий
  // в момент mousedown, чтобы preview совпадал с финальным.
  // По спеке: без модификаторов = красный (= default), Alt = синий.
  const [previewDefaultColor, setPreviewDefaultColor] = useState<string>(HIGHLIGHT_COLORS.red);

  const handleArrowsChange = useCallback(() => {
    // no-op (см. комментарий выше)
  }, []);

  // Стрелки текущей ноды → внешние arrows для react-chessboard.
  const annotationArrows = useMemo(() => {
    const list = currentAnnotations?.arrows ?? [];
    return list.map((a) => ({
      startSquare: a.from,
      endSquare: a.to,
      color: HIGHLIGHT_COLORS[a.color],
    }));
  }, [currentAnnotations]);

  // KS-3691 / ADR-108b §7. AI overlay подмешиваем между системным слоем
  // (last-move/selected/legal из useBoardHighlights) и пользовательскими
  // правыми кликами/стрелками. Если пользователь скрыл overlay через
  // переключатель в панели — слой пуст.
  const aiOverlayVisible =
    aiPositionComment.overlay !== null && !aiPositionComment.overlayHidden;
  const aiSquareStyles = useMemo<
    Record<string, React.CSSProperties>
  >(() => {
    if (!aiOverlayVisible || !aiPositionComment.overlay) return {};
    const styles: Record<string, React.CSSProperties> = {};
    for (const h of aiPositionComment.overlay.highlights) {
      styles[h.square] = { backgroundColor: HIGHLIGHT_COLORS[h.color] };
    }
    return styles;
  }, [aiOverlayVisible, aiPositionComment.overlay]);
  const aiArrows = useMemo(() => {
    if (!aiOverlayVisible || !aiPositionComment.overlay) {
      return [] as Array<{ startSquare: string; endSquare: string; color: string }>;
    }
    return aiPositionComment.overlay.arrows.map((a) => ({
      startSquare: a.from,
      endSquare: a.to,
      color: HIGHLIGHT_COLORS[a.color],
    }));
  }, [aiOverlayVisible, aiPositionComment.overlay]);

  // KS-3695: когда поверх доски активен AI overlay, last-move-подсветка
  // системного слоя мешает восприятию цветных пометок модели. Убираем
  // её, оставляя selected/legal (это другая семантика интерактива).
  // Сравниваем `backgroundColor` с экспортированной константой —
  // если квадрат уже стал selected/legal (другой цвет), оставляем как
  // есть, чтобы не сбрасывать пользовательский клик.
  const systemStylesEffective = useMemo(
    () =>
      omitLastMoveIfAiOverlayActive(
        squareStyles,
        lastMoveSquares ?? null,
        LAST_MOVE_COLOR,
        aiOverlayVisible,
      ),
    [squareStyles, lastMoveSquares, aiOverlayVisible],
  );

  // Объединённые стили: системный слой → AI overlay → пользовательские
  // правые клики. Каждый следующий слой перезаписывает background-color
  // предыдущего по той же клетке. Сама логика — в чистом хелпере, чтобы
  // её можно было проверять без подъёма всего AnalysisPage (см.
  // aiOverlayMerge.test.ts).
  const mergedSquareStyles = useMemo(
    () => mergeSquareStyleLayers(systemStylesEffective, aiSquareStyles, highlightStyles),
    [systemStylesEffective, aiSquareStyles, highlightStyles],
  );

  // Объединённые стрелки: hover-suggestion → AI стрелки → пользовательские
  // аннотации.
  const mergedArrows = useMemo(
    () => composeArrowLayers(arrows, aiArrows, annotationArrows),
    [arrows, aiArrows, annotationArrows],
  );

  // KS-2152: Ремоунт MemoChessboard при смене ноды/позиции И при изменении
  // arrows. Highlights в key НЕ кладём — для них достаточно identity-сравнения
  // squareStyles в areOptionsEqual.
  //
  // Зачем ремоунт на arrows: library кэширует свой internalArrows и при
  // повторном drag не очищает их (она ранний return, если стрелка есть в
  // external). Ремоунт сбрасывает internalArrows → новый external из
  // currentAnnotations.arrows становится единственным источником.
  //
  // handleArrowsChange — no-op, поэтому initial useEffect onArrowsChange
  // в Chessboard после ремоунта ничего не сбросит.
  const annotationsKey = useMemo(
    () =>
      // KS-3691: ключ ремоунта дополнительно зависит от AI-стрелок —
      // иначе react-chessboard не сбрасывает internal-arrows при смене
      // overlay (показал/скрыл/обновил по новому ответу модели).
      `${currentGlobalIndex}|${currentFen}|${JSON.stringify(currentAnnotations?.arrows ?? null)}|${JSON.stringify(aiArrows)}`,
    [currentGlobalIndex, currentFen, currentAnnotations?.arrows, aiArrows],
  );

  // --- Archive tree handlers ---
  const handleTreeMove = useCallback(
    (uci: string) => {
      if (uci.length < 4) return;
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      makeVariantMove(from, to, promotion);
    },
    [makeVariantMove],
  );

  const handleTreeHover = useCallback(
    (uci: string | null) => {
      if (!uci || uci.length < 4) {
        setSuggestedArrow(null, null);
        return;
      }
      setSuggestedArrow(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square);
    },
    [setSuggestedArrow],
  );

  useEffect(() => {
    if (currentMove) setLastMove(currentMove.from as Square, currentMove.to as Square);
  }, [currentMove, setLastMove]);

  // KS-2215: стрелка-подсказка от hover на ход из дерева/книги обязана
  // исчезать при любой смене позиции на доске. На touch-устройствах
  // mouseLeave у строки дерева после tap не приходит, поэтому стрелка
  // «прилипала» к доске после выбора хода. Любая смена currentFen
  // (стрелки управления, клик в линию движка, ход на доске, выбор строки
  // в дереве) безусловно сбрасывает suggestedArrow.
  useEffect(() => {
    setSuggestedArrow(null, null);
  }, [currentFen, setSuggestedArrow]);

  // KS-2151: звук ходов в Мастерской.
  // Триггерим на смену currentMove — это покрывает оба источника:
  //  - ход пользователя (makeVariantMove → новый currentMove);
  //  - навигация по дереву (gotoNext/Previous/Last/First/gotoMove).
  // Первый рендер (prevIndex === null) НЕ озвучиваем — иначе при открытии
  // сохранённой партии с last-position будет лишний звук на старте.
  // soundEventFromSan различает move/capture/check/castle по SAN.
  const { playSound } = useSounds();
  const prevMoveGlobalIndexRef = useRef<number | null>(null);
  const isFirstSoundRenderRef = useRef(true);
  useEffect(() => {
    const currentIndex = currentMove?.globalIndex ?? null;
    const prevIndex = prevMoveGlobalIndexRef.current;
    if (isFirstSoundRenderRef.current) {
      isFirstSoundRenderRef.current = false;
      prevMoveGlobalIndexRef.current = currentIndex;
      return;
    }
    if (currentIndex !== prevIndex) {
      if (currentMove) {
        playSound(soundEventFromSan(currentMove.san));
      } else {
        // Возврат к стартовой позиции (gotoFirst) — короткий «плик» хода
        playSound('move');
      }
    }
    prevMoveGlobalIndexRef.current = currentIndex;
  }, [currentMove, playSound]);

  // KS-2152: левый клик НЕ сбрасывает аннотации — они привязаны к ноде и
  // должны жить вместе с ней. Сброс происходит автоматически при смене ноды
  // (currentMove → новый currentAnnotations).
  const handleSquareClick = useCallback(
    ({ square }: { piece?: unknown; square: string }) => onSquareClick(square as Square),
    [onSquareClick],
  );

  const handlePieceClick = useCallback(
    ({ square }: { isSparePiece?: boolean; piece?: unknown; square: string | null }) => {
      if (square) onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  // KS-2034: legacy `handlePieceDrop` удалён — вместо него используется
  // `handleFastDragDrop` (быстрый drop без анимации). Если потребуется
  // вернуть «классический» drop — восстановить из истории git.

  const handleFastDragDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (isPromotionMove(sourceSquare, targetSquare)) {
        const testGame = new Chess(currentFen);
        const testMove = testGame.move({ from: sourceSquare as Square, to: targetSquare as Square, promotion: 'q' });
        if (!testMove) return false;
        setPendingPromotion({ from: sourceSquare, to: targetSquare });
        return true;
      }
      return makeVariantMove(sourceSquare, targetSquare);
    },
    [makeVariantMove, isPromotionMove, currentFen],
  );

  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop: handleFastDragDrop,
    boardOrientation,
    allowBothColors: true,
    // KS-2868/KS-2869: read-only mode (publicMode) — drag отключён.
    enabled: !loading && !ctx.readOnly,
  });

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation,
      animationDurationInMs: suppressAnimationRef.current ? 0 : 200,
      allowDragging: false,
      showNotation: true,
      squareStyles: mergedSquareStyles,
      arrows: mergedArrows,
      onSquareClick: handleSquareClick,
      onPieceClick: handlePieceClick,
      onSquareMouseDown: handleBoardMouseDown,
      onSquareMouseUp: handleBoardMouseUp,
      // KS-2157: цвета preview-стрелки во время ПКМ-drag.
      // Спека: без модификаторов = red, Shift = green, Alt = blue, Ctrl = yellow.
      // Library поддерживает Shift и Ctrl — secondaryColor/tertiaryColor.
      // Alt library не знает: для Alt-only мы динамически меняем `color` через
      // previewDefaultColor (см. handleBoardMouseDown).
      arrowOptions: {
        color: previewDefaultColor,
        secondaryColor: HIGHLIGHT_COLORS.green,
        tertiaryColor: HIGHLIGHT_COLORS.yellow,
        // Дефолтные значения react-chessboard.
        arrowLengthReducerDenominator: 8,
        sameTargetArrowLengthReducerDenominator: 4,
        arrowWidthDenominator: 5,
        activeArrowWidthMultiplier: 0.9,
        opacity: 0.65,
        activeOpacity: 0.5,
        arrowStartOffset: 0,
      },
      // KS-2152: onSquareRightClick НЕ передаём — Chrome шлёт contextmenu
      // ещё на mousedown (до завершения drag). Если library вызовет наш
      // right-click-handler, highlight приклеится к старт-клетке drag'а
      // (ПКМ-drag e2→e4 подсвечивал бы e2). Highlight + arrow toggle
      // обрабатываем в handleBoardMouseUp по сравнению start/end.
      // onArrowsChange — no-op; ремоунт через `key={annotationsKey}` сбрасывает
      // library internalArrows, наш external из state — единственный источник.
      onArrowsChange: handleArrowsChange,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      // KS-3320 follow-up: подключаем выбранный piece-set (из настроек).
      ...(customPieces && { pieces: customPieces }),
    }),
    [stablePosition, boardOrientation, boardStyle, boardThemeOptions, customPieces, mergedSquareStyles, mergedArrows, handleSquareClick, handlePieceClick, handleBoardMouseDown, handleBoardMouseUp, handleArrowsChange, previewDefaultColor],
  );

  // SAN path from the root to the currently viewed position (follows variations).
  // Used for the Database panel's opening heading — must reflect the active branch.
  // NOTE: must live above the early returns below — hooks cannot be conditional.
  const currentSanPath = useMemo(() => {
    if (!currentMove) return [];
    const path: string[] = [];
    let cur: ChessMove | null | undefined = currentMove;
    while (cur) {
      path.push(cur.san);
      cur = cur.previous ?? null;
    }
    return path.reverse();
  }, [currentMove]);

  // --- Computed values ---
  const isBlackTurn = currentFen.split(' ')[1] === 'b';
  const evalIsBlackTurn = analysisFen ? analysisFen.split(' ')[1] === 'b' : isBlackTurn;
  const isAtStart = currentMove === null;
  const isAtEnd = currentMove !== null && !currentMove.next;

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  if (gameId && !gameData) return null;

  const resultPgn = gameData
    ? gameData.result === 'draw' ? '½–½' : gameData.result === 'white' ? '1–0' : '0–1'
    : undefined;

  const openingName = classifyOpening(history.map((m) => m.san));
  const treeOpeningName = classifyOpening(currentSanPath);

  const gameInfo: GameMetaInfo | undefined = gameData
    ? {
        white: { username: gameData.white.username, rating: gameData.whiteRatingBefore ?? null },
        black: { username: gameData.black.username, rating: gameData.blackRatingBefore ?? null },
        opening: openingName || undefined,
        result: resultPgn,
        ratingChange: gameData.ratingChange || undefined,
      }
    : pgnHeaders['White'] && pgnHeaders['Black']
      ? {
          white: { username: pgnHeaders['White'], rating: pgnHeaders['WhiteElo'] ? Number(pgnHeaders['WhiteElo']) : undefined },
          black: { username: pgnHeaders['Black'], rating: pgnHeaders['BlackElo'] ? Number(pgnHeaders['BlackElo']) : undefined },
          opening: openingName || pgnHeaders['Opening'] || undefined,
          result: pgnHeaders['Result'] && pgnHeaders['Result'] !== '*' ? pgnHeaders['Result'] : undefined,
          event: pgnHeaders['Event'] && pgnHeaders['Event'] !== '?' ? pgnHeaders['Event'] : undefined,
          date: pgnHeaders['Date'] && pgnHeaders['Date'] !== '????.??.??' ? pgnHeaders['Date'] : undefined,
        }
      : undefined;

  const topLine = displayedLines[0];
  const engineStats = analysisEnabled && sfState === 'analyzing' && topLine
    ? (() => {
        const parts = [`d${topLine.depth}`];
        if (activeSource === 'external' && ec.uciThreads !== '1') parts.push(`${ec.uciThreads}cores`);
        if (topLine.nodes) parts.push(`${formatCompact(topLine.nodes)}n`);
        if (topLine.nps) parts.push(`${formatCompact(topLine.nps)}nps`);
        return ` · ${parts.join(' · ')}`;
      })()
    : null;

  const engineStatusSuffix = !wasmSupported
    ? ` · ${t('analysis.notSupported', 'Not supported')}`
    : isTouchDevice && engineFailed
      ? ` · ${t('analysis.notSupportedMobile', 'Not supported on mobile')}`
      : engineStats ?? (
          analysisEnabled && sfState === 'loading' ? ` · ${t('common.loading')}`
          : analysisEnabled && sfState === 'error' ? ` · ${t('analysis.engineError', 'Engine error')}`
          : analysisEnabled && sfState === 'ready' && displayedLines.length === 0 ? ` · ${t('analysis.ready', 'Ready')}`
          : !analysisEnabled && engineFailed ? ` · ${t('analysis.engineError', 'Engine error')}`
          : !analysisEnabled ? ` · ${t('analysis.off', 'Off')}`
          : ''
        );

  return (
    <div
      className="analysis-page"
      data-analysis-context={ctx.kind}
      ref={analysisPageRef}
    >
      <div className="analysis-board-area">
        {/* KS-3182: в embedded-режиме шапка не нужна — шаг урока сам
            подписан, breadcrumb/title-edit/Share — это не контекст
            ученика. */}
        {!gameId && !embedded && (
          <AnalysisHeader
            context={{
              mode: 'analysis',
              breadcrumbRootTitle,
              breadcrumbRootUrl,
              breadcrumbSection,
              breadcrumbBackUrl,
              breadcrumbBackState,
              breadcrumbFileName,
              breadcrumbFileBackUrl,
              breadcrumbFileBackState,
            }}
            analysisTitle={analysisTitle}
            isEditingTitle={isEditingTitle}
            titleInput={titleInput}
            onTitleInputChange={setTitleInput}
            onTitleSave={handleTitleSave}
            onTitleKeyDown={handleTitleKeyDown}
            onTitleClick={handleTitleClick}
          />
        )}
        {/* KS-3755 / ADR-112: лёгкий бейдж «В эфире · N зрителей»
            (заменил тяжёлый LiveBroadcastControl). Виден только
            владельцу на собственной странице и только когда трансляция
            активна. Управление (старт/стоп/копирование ссылки) —
            в AnalysisActionsMenu под доской, см. broadcast-группу. */}
        {!embedded && !publicMode && user && (
          <LiveBroadcastBadge
            isLive={liveBroadcast.isLive}
            publicUrl={liveBroadcast.publicUrl}
            errorMessage={liveBroadcast.error}
          />
        )}
        {/* KS-3750: badge «получено обновление от автора». Виден
            только в зрительском live-режиме и только когда зритель
            находится в локальной ветке (`pendingLivePgn != null`). По
            клику применяет накопленный pending к review-state
            (`applyLivePgn` сохраняет позицию через findGlobalIndexByFen).
            Авто-применение при возврате на main-line автора уже
            обрабатывается соседним useEffect — badge нужен только пока
            зритель действительно в стороне. */}
        {isViewerLive && pendingLivePgn && (
          <div
            className="analysis-live-update-badge"
            data-testid="analysis-live-update-badge"
            role="status"
            aria-live="polite"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 12,
              padding: '6px 12px',
              borderRadius: 16,
              background: '#fff8e1',
              border: '1px solid #f4b400',
              color: '#5d4037',
              fontSize: 13,
              margin: '8px 0',
            }}
          >
            <span>
              {t(
                'liveAnalysisViewer.updateAvailable',
                'New update from the author',
              )}
            </span>
            <button
              type="button"
              onClick={handleApplyPendingLive}
              data-testid="analysis-live-update-apply"
              style={{
                padding: '4px 10px',
                borderRadius: 12,
                border: 'none',
                background: '#f4b400',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {t('liveAnalysisViewer.applyUpdate', 'Apply')}
            </button>
          </div>
        )}
        {/* KS-3261: toast «Открыли существующий анализ» — показывается
            после dedup-hit'а на backend (POST /analyses вернул
            existing=true). Скрывается автоматом через 3 секунды.
            Источник — `location.state.openedExisting`, выставленный
            `openAnalysisFromPgn`. */}
        {openedExistingToast && (
          <div
            className="analysis-existing-toast"
            data-testid="analysis-opened-existing-toast"
            role="status"
            aria-live="polite"
          >
            {t(
              'analysis.openedExisting',
              'Opened your existing analysis for this game',
            )}
          </div>
        )}
        {/* KS-2674: Share-кнопка УБРАНА из шапки. Теперь это пункт
            в action-bar под доской (desktop) и в overflow-menu
            (mobile). См. ShareAnalysisButton ниже + handler в
            overflow-menu. Шапка освободилась — особенно над доской
            на mobile. */}
        <div className="analysis-board-wrapper">
          <AnalysisBoard
            gameInfo={gameInfo}
            boardContainerRef={boardContainerRef}
            boardOptions={boardOptions}
            annotationsKey={annotationsKey}
            displayedLines={displayedLines}
            evalIsBlackTurn={evalIsBlackTurn}
            pendingPromotion={pendingPromotion}
            onPromotionChoice={handlePromotionChoice}
            onPromotionCancel={handlePromotionCancel}
            variationChooser={variationChooser}
            onVariationSelect={(move) => {
              setVariationChooser(null);
              gotoMove(move);
            }}
            onVariationClose={() => setVariationChooser(null)}
          />

          <div className="analysis-board-controls">
            {/* KS-3198: NavButton добавляет long-press авто-перемотку.
                Поведение onClick (single tap) полностью совместимо со
                старой обычной <button>. Скорость авто-tick'а берётся
                из `BoardSettingsContext.navAutoRepeatSpeed` (настройки). */}
            <NavButton onClick={gotoFirst} disabled={isAtStart} title={t('review.toStart')} testId="analysis-nav-first">&#x21E4;</NavButton>
            <NavButton onClick={gotoPrevious} disabled={isAtStart} title={t('review.back')} testId="analysis-nav-prev">&#x2190;</NavButton>
            <NavButton onClick={handleArrowRight} disabled={isAtEnd} title={t('review.forward')} testId="analysis-nav-next">&#x2192;</NavButton>
            <NavButton onClick={gotoLast} disabled={isAtEnd} title={t('review.toEnd')} testId="analysis-nav-last">&#x21E5;</NavButton>
            <button
              className="analysis-flip-btn"
              onClick={flipBoardOrientation}
              title={t('analysis.flipBoard', 'Flip board')}
            >
              ⇅
            </button>
            {/* KS-2114: переключатель размера доски S/M/L. Значение
                сохраняется в localStorage через BoardSettingsContext и
                применяется к `.analysis-page .board-container` через
                CSS-переменную `--analysis-board-size-scale`. */}
            <div
              className="analysis-board-size"
              role="group"
              aria-label={t('analysis.boardSize', 'Board size')}
            >
              {BOARD_SIZES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`analysis-board-size__btn${boardSize === preset.id ? ' is-active' : ''}`}
                  onClick={() => setBoardSize(preset.id)}
                  title={t('analysis.boardSize', 'Board size') + ': ' + preset.label}
                  aria-pressed={boardSize === preset.id}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {/* Inline eval indicator - mobile only */}
            {topLine && analysisEnabled && sfState === 'analyzing' && (
              <span className="analysis-inline-eval">
                <span className={`analysis-inline-eval__score${topLine.score.type === 'mate' ? ' mate' : ''}`}>
                  {formatEval(topLine, evalIsBlackTurn)}
                </span>
                <span className="analysis-inline-eval__depth">d{topLine.depth}</span>
              </span>
            )}
            <span className="analysis-controls-spacer" />
            {/* KS-2678: на desktop под доской раньше дублировались
                отдельные кнопки FEN/Info/PGN/iPGN/Share — слишком
                много элементов смешивалось с навигацией по ходам.
                Все вспомогательные действия теперь живут в overflow-
                меню («…»), которое отображается одинаково на desktop
                и mobile. KS-2220 inline-«PGN скопирован» сохраняем — он
                по-прежнему появляется при копировании из меню. */}
            {pgnCopyMsg && (
              <span
                className="analysis-copy-msg"
                role="status"
                data-testid="analysis-copy-pgn-msg"
              >
                {pgnCopyMsg}
              </span>
            )}
            {/* KS-3182: overflow-меню (Share / Export / Import / FEN /
                Find games) бесполезно ученику внутри шага урока — он не
                автор анализа и не должен экспортировать чужую партию.
                В embedded-режиме wrapper полностью убран из дерева. */}
            {!embedded && (
            <div className="analysis-overflow-wrapper" ref={overflowMenuRef}>
              <button
                className="analysis-overflow-btn"
                onClick={() => {
                  setShowOverflowMenu((v) => !v);
                  // KS-3331: лениво грузим репертуары при открытии меню
                  // (только владелец своего анализа), чтобы знать, не пуст
                  // ли список для disabled-состояния пункта «Добавить в
                  // существующий».
                  if (
                    !publicMode &&
                    user &&
                    localIdRef.current &&
                    savedOwnerId === user.id &&
                    ctx.kind === 'analysis' &&
                    history.length > 0
                  ) {
                    void loadRepertoires();
                  }
                }}
                title={t('common.more', 'More')}
                data-testid="analysis-overflow-btn"
              >
                &#x22EF;
              </button>
              {/* KS-2678: ShareAnalysisButton живёт ВНУТРИ overflow-
                  wrapper'а, чтобы popup рендерился absolute relative
                  именно к меню. Сам trigger скрыт CSS на всех
                  разрешениях (видно только из пункта меню «Share»). */}
              {!publicMode &&
                user &&
                localIdRef.current &&
                savedOwnerId === user.id && (
                  <ShareAnalysisButton
                    ref={shareButtonRef}
                    analysisId={localIdRef.current}
                    initialIsPublic={savedIsPublic}
                    onPublicChanged={setSavedIsPublic}
                  />
                )}
              {/* KS-3421 (ADR-087 §8 F1): новое единое меню действий
                  с двумя режимами (dropdown desktop / bottom-sheet
                  mobile) поверх общего items-source. За гейтом
                  ANALYSIS_ACTIONS_MENU_V2_ENABLED. При откате (флип
                  гейта в false + redeploy) ниже рендерится legacy
                  overflow с тем же набором пунктов. */}
              {ANALYSIS_ACTIONS_MENU_V2_ENABLED ? (
                <AnalysisActionsMenu
                  open={showOverflowMenu}
                  onClose={() => setShowOverflowMenu(false)}
                  items={buildAnalysisActionsItems({
                    t,
                    gameId,
                    navigate,
                    currentFen,
                    historyLen: history.length,
                    kind: ctx.kind,
                    publicMode,
                    user,
                    localIdRef,
                    savedOwnerId,
                    creatingRepertoire,
                    repertoires,
                    repertoiresLoading,
                    analysisTitle,
                    buildAnalysisPgn,
                    handleExportPgn,
                    handleCopyPgn,
                    setShowSetPosition,
                    setShowPgnHeaders,
                    liveViewer: isViewerLive,
                    setPuzzleGenPgn,
                    setShowPuzzleGen,
                    setSidePickerOpen,
                    setAddToRepertoireOpen,
                    shareButtonRef,
                    openArchiveRepertoireModal: () =>
                      setShowArchiveRepMovetimeModal(true),
                    onRunGameReview: gameReviewLauncher.trigger,
                    gameReviewDisabled: gameReviewLauncher.disabled,
                    gameReviewDisabledHint: gameReviewLauncher.disabledHint,
                    // KS-3755 / ADR-112: broadcast-группа в меню.
                    liveAnalysisId: analysisId ?? null,
                    liveIsLive: liveBroadcast.isLive,
                    liveIsStarting: liveBroadcast.isStarting,
                    livePublicUrl: liveBroadcast.publicUrl,
                    onLiveStart: handleLiveStart,
                    onLiveSaveAndStart: handleLiveSaveAndStart,
                    onLiveCopyLink: handleLiveCopyLink,
                    onLiveStop: handleLiveStop,
                  })}
                />
              ) : (
                showOverflowMenu && (
                  <div className="analysis-overflow-menu">
                    {!gameId && (
                      <>
                        <button onClick={() => { setShowSetPosition(true); setShowOverflowMenu(false); }}>
                          {t('position.title', 'Set Position')} (FEN)
                        </button>
                        <button onClick={() => { setShowPgnHeaders(true); setShowOverflowMenu(false); }}>
                          {t('analysis.gameInfo', 'Game Info')}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => {
                        navigate(
                          `/archive?fen=${encodeURIComponent(currentFen)}&sort=topElo`,
                        );
                        setShowOverflowMenu(false);
                      }}
                      data-testid="analysis-find-by-position-overflow"
                    >
                      {t('analysis.findByPosition', 'Find games with this position')}
                    </button>
                    <button
                      onClick={() => { handleExportPgn(); setShowOverflowMenu(false); }}
                      disabled={history.length === 0}
                    >
                      {t('review.exportPgn', 'Export PGN')}
                    </button>
                    <button
                      onClick={() => { void handleCopyPgn(); setShowOverflowMenu(false); }}
                      disabled={history.length === 0}
                      data-testid="analysis-copy-pgn-overflow"
                    >
                      {t('review.copyPgn', 'Copy PGN to clipboard')}
                    </button>
                    {(ctx.kind === 'analysis' || ctx.kind === 'review') && (
                      <button
                        onClick={() => {
                          const pgn = buildAnalysisPgn();
                          if (!pgn) return;
                          setPuzzleGenPgn(pgn);
                          setShowPuzzleGen(true);
                          setShowOverflowMenu(false);
                        }}
                        disabled={history.length === 0}
                        data-testid="analysis-generate-puzzle-overflow"
                      >
                        {t('analysis.generatePuzzle', 'Generate puzzle')}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        const pgn = buildAnalysisPgn();
                        if (!pgn) return;
                        setShowOverflowMenu(false);
                        navigate('/guess', {
                          state: { pgn, title: analysisTitle || undefined },
                        });
                      }}
                      disabled={history.length === 0}
                      data-testid="analysis-guess-moves-overflow"
                    >
                      {t('analysis.guessMoves', 'Guess the moves')}
                    </button>
                    {!publicMode &&
                      user &&
                      localIdRef.current &&
                      savedOwnerId === user.id &&
                      ctx.kind === 'analysis' &&
                      history.length > 0 && (
                        <button
                          onClick={() => {
                            setShowOverflowMenu(false);
                            setSidePickerOpen(true);
                          }}
                          disabled={creatingRepertoire}
                          data-testid="analysis-use-as-repertoire"
                        >
                          {creatingRepertoire
                            ? t('analysis.useAsRepertoire.creating', 'Creating…')
                            : t(
                                'analysis.useAsRepertoire.menuItem',
                                'Use as new repertoire',
                              )}
                        </button>
                      )}
                    {!publicMode &&
                      user &&
                      localIdRef.current &&
                      savedOwnerId === user.id &&
                      ctx.kind === 'analysis' &&
                      history.length > 0 && (
                        <button
                          onClick={() => {
                            setShowOverflowMenu(false);
                            setAddToRepertoireOpen(true);
                          }}
                          disabled={
                            repertoiresLoading ||
                            (repertoires !== null && repertoires.length === 0)
                          }
                          title={
                            repertoires !== null && repertoires.length === 0
                              ? t(
                                  'analysis.useAsRepertoire.addToExistingEmpty',
                                  'You have no repertoires yet',
                                )
                              : undefined
                          }
                          data-testid="analysis-add-to-repertoire"
                        >
                          {repertoiresLoading
                            ? t(
                                'analysis.useAsRepertoire.addToExistingLoading',
                                'Loading repertoires…',
                              )
                            : t(
                                'analysis.useAsRepertoire.addToExistingMenuItem',
                                'Add to existing repertoire…',
                              )}
                        </button>
                      )}
                    {!publicMode &&
                      user &&
                      localIdRef.current &&
                      savedOwnerId === user.id && (
                        <button
                          onClick={() => {
                            setShowOverflowMenu(false);
                            window.setTimeout(() => {
                              shareButtonRef.current?.open();
                            }, 0);
                          }}
                          data-testid="analysis-share-overflow"
                        >
                          {t('analysis.share.menuItem', 'Share')}
                        </button>
                      )}
                  </div>
                )
              )}
            </div>
            )}
          </div>
        </div>
      </div>

      <AnalysisSidebar
        gameInfo={gameInfo}
        activeSource={activeSource}
        bridgePromoDismissed={bridgePromoDismissed}
        onDismissBridgePromo={() => {
          setBridgePromoDismissed(true);
          try { localStorage.setItem('bridgePromoDismissed', '1'); } catch { /* ignore */ }
        }}
        engineName={engineName}
        engineStatusSuffix={engineStatusSuffix}
        engineErrorMessage={engineErrorMessage}
        sfState={sfState}
        analysisEnabled={analysisEnabled}
        wasmSupported={wasmSupported}
        isTouchDevice={isTouchDevice}
        engineFailed={engineFailed}
        onToggleAnalysis={toggleAnalysis}
        ec={ec}
        engineLoadProgress={engineLoadProgress}
        engineErrorReason={engineErrorReason}
        onEngineRetry={engineInit}
        panelStates={panelStates}
        onTogglePanel={togglePanel}
        displayedLines={displayedLines}
        evalIsBlackTurn={evalIsBlackTurn}
        currentFen={currentFen}
        treeOpeningName={treeOpeningName || null}
        onTreeMove={handleTreeMove}
        onTreeHover={handleTreeHover}
        history={history}
        currentGlobalIndex={currentGlobalIndex}
        onMoveClick={gotoMove}
        onPromoteVariation={(m) => promoteVariation(m as ChessMove)}
        onDeleteVariation={(m) => removeVariation(m as ChessMove)}
        onTruncateRemaining={(m) => truncateRemaining(m as ChessMove)}
        onSetNag={setNag}
        onSetComment={setComment}
        onSetVariationColor={setVariationColor}
        mobileTab={mobileTab}
        onMobileTabChange={setMobileTab}
        /* KS-3597 (ADR-099 F2): поднятые на уровень страницы Maia-hook
           и sort-режим, чтобы `useEngine` мог получить `searchmoves`
           без дублирования экземпляров. */
        maia={maia}
        sortMode={sortMode}
        onSortModeChange={setSortMode}
        engineSupportsSearchmoves={engineSupportsSearchmoves}
        maiaTopMoves={maiaTopMoves}
        /* KS-3680 (ADR-108): контроллер AI-комментария позиции. */
        aiPositionComment={aiPositionComment}
        /* KS-3726: «Добавить в комментарий» — переносит AI-текст в
           комментарий узла дерева, на котором стоит пользователь.
           Узел адресуется через searchInHistory (после KS-3725).
           Append-merge: если у узла уже есть свой текст — дописываем
           через перевод строки, не затираем. */
        onAddAiCommentToMove={handleAddAiCommentToMove}
        currentMoveComment={currentMoveCommentForAi}
        /* KS-3606 (ADR-100 §9): source-link «← Исходный анализ» на
           дубле. `analysisOriginalId` lazy-fetch'ится отдельным
           useEffect (см. ниже). Кнопка «Разобрать партию» переехала
           в AnalysisActionsMenu — Sidebar её больше не получает. */
        originalAnalysisId={analysisOriginalId}
        readOnly={ctx.readOnly}
        concealAfterPly={null}
        // KS-3258 follow-up: пробрасываем headers, чтобы при пустой
        // history и [Termination "Unplayed"] / Result != "*" вместо
        // «No moves» отрисовался <ForfeitPlaceholder>. PGN-headers
        // парсятся в initial-state из location.state.pgn (см. строку
        // ~346).
        pgnHeaders={pgnHeaders}
      />

      {ec.showEngineModal && (
        <EngineSettingsModal
          engineSource={ec.engineSource}
          multiPv={ec.multiPv}
          setMultiPv={(v) => ec.setMultiPv(v)}
          extUrlInput={ec.extUrlInput}
          setExtUrlInput={ec.setExtUrlInput}
          extKeyInput={ec.extKeyInput}
          setExtKeyInput={ec.setExtKeyInput}
          extNameInput={ec.extNameInput}
          setExtNameInput={ec.setExtNameInput}
          uciThreads={ec.uciThreads}
          setUciThreads={ec.setUciThreads}
          uciHash={ec.uciHash}
          setUciHash={ec.setUciHash}
          savedConfigs={ec.savedConfigs}
          externalConfig={ec.externalConfig}
          setEngineOption={setEngineOption}
          connectionState={sfState}
          errorMessage={engineErrorMessage}
          onClose={() => ec.setShowEngineModal(false)}
          onSwitchToWasm={ec.handleSwitchToWasm}
          onSwitchToExternal={() => ec.setEngineSource('external')}
          onConnectExternal={ec.handleConnectExternal}
          onSelectSavedConfig={ec.handleSelectSavedConfig}
          onDeleteConfig={ec.handleDeleteConfig}
        />
      )}

      {showSetPosition && (
        <SetPositionModal
          initialFen={currentFen}
          onApply={(fen) => {
            setInitialFen(fen);
            setShowSetPosition(false);
          }}
          onClose={() => setShowSetPosition(false)}
        />
      )}

      {showPgnHeaders && (
        <PgnHeadersModal
          headers={pgnHeaders}
          onApply={(h) => setPgnHeaders(h)}
          onClose={() => setShowPgnHeaders(false)}
        />
      )}

      {/* KS-3606 (ADR-100 §9): прогресс-модалка «Разобрать партию» —
          рендерится только когда пункт меню был нажат; hook сам
          управляет open/close и редиректит на дубль. */}
      {gameReviewLauncher.modal}

      {/* KS-3616 (ADR-102): toast «комментарии не сгенерированы».
          Показывается когда LLM-фаза провалилась; дубль всё равно
          создан со всеми NAG/variations. UI-стиль повторяет
          существующий `analysis-existing-toast` (см. KS-3261). */}
      {gameReviewLauncher.commentsWarning && (
        <div
          className="analysis-existing-toast"
          data-testid="analysis-comments-unavailable-toast"
          role="status"
        >
          {t(
            'analysis.review.commentsUnavailable',
            'Comments unavailable, try later',
          )}
        </div>
      )}

      {/* KS-2958: тот же PuzzleGeneratorModal, что в разделе «Тренировка
          точности» — единое окно с прогрессом и пост-flow (My drafts /
          Publish all). PGN подставляется автоматически, ввод скрыт. */}
      {showPuzzleGen && (
        <PuzzleGeneratorModal
          initialPgn={puzzleGenPgn}
          autoStart
          onClose={() => setShowPuzzleGen(false)}
        />
      )}
      {/* KS-3302: picker стороны при конверсии анализа в репертуар. */}
      {sidePickerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="analysis-use-as-repertoire-picker"
          onClick={() => setSidePickerOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-surface, #1f2937)',
              color: 'var(--text-primary, #fff)',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
              borderRadius: 8,
              padding: '18px 20px',
              maxWidth: 320,
              width: '90%',
              textAlign: 'center',
            }}
          >
            <h3 style={{ margin: '0 0 8px' }}>
              {t('analysis.useAsRepertoire.pickerTitle', 'Train as')}
            </h3>
            <p
              style={{
                margin: '0 0 16px',
                fontSize: 13,
                opacity: 0.75,
              }}
            >
              {t(
                'analysis.useAsRepertoire.pickerHint',
                'Which side will you train this repertoire for?',
              )}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                className="btn btn-primary"
                onClick={() => void handleUseAsRepertoire('white')}
                disabled={creatingRepertoire}
                data-testid="analysis-use-as-repertoire-white"
              >
                {t('openingTrainer.detail.start.white', 'White')}
              </button>
              <button
                className="btn"
                onClick={() => void handleUseAsRepertoire('black')}
                disabled={creatingRepertoire}
                data-testid="analysis-use-as-repertoire-black"
              >
                {t('openingTrainer.detail.start.black', 'Black')}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setSidePickerOpen(false)}
              disabled={creatingRepertoire}
              style={{
                marginTop: 12,
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                opacity: 0.7,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}
      {/* KS-3331 (ADR-078 §5.3): модалка выбора существующего репертуара. */}
      {addToRepertoireOpen && repertoires !== null && repertoires.length > 0 && (
        <AddToRepertoireModal
          repertoires={repertoires}
          submitting={addingToRepertoireId !== null}
          submittingId={addingToRepertoireId}
          onSelect={(id) => void handleAddToExistingRepertoire(id)}
          onClose={() => setAddToRepertoireOpen(false)}
        />
      )}

      {/* KS-3471 (ADR-090 V4 F1): модалка выбора movetime → F2 поток. */}
      <ArchiveRepertoireMovetimeModal
        open={showArchiveRepMovetimeModal}
        onClose={() => setShowArchiveRepMovetimeModal(false)}
        onConfirm={(movetime: ArchiveRepertoireMovetime) => {
          setShowArchiveRepMovetimeModal(false);
          setArchiveRepProgressOpen(true);
          // KS-3472 F2: тренируем сторону, которая ходит в target-FEN
          // (то есть тот, для кого мы строим репертуар). chess.js
          // достанем через split на side-to-move; альтернативно тут
          // используем boardOrientation как «удобный» выбор стороны.
          // Backend по умолчанию строит white-репертуар (см.
          // CreateOpeningRepertoireRequest.side), но мы передадим
          // явно сторону, которой ходит в текущей позиции — для неё
          // и считаем loss.
          const sideToMove = currentFen.split(' ')[1] === 'b' ? 'black' : 'white';
          const title =
            (analysisTitle && analysisTitle.trim()) ||
            t(
              'analysis.archiveRepertoire.defaultTitle',
              'Master games 2400+ from position',
            );
          void archiveRep.start({
            fen: currentFen,
            side: sideToMove,
            movetime,
            title,
          });
        }}
      />

      {/* KS-3472 (F2): прогресс-модалка. */}
      {archiveRepProgressOpen && (
        <RepertoireFromArchiveProgress
          state={archiveRep.state}
          onClose={() => {
            setArchiveRepProgressOpen(false);
            archiveRep.reset();
          }}
          onCancel={() => {
            archiveRep.cancel();
          }}
        />
      )}
    </div>
  );
}
