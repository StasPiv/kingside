import { useLocation, useParams } from 'react-router-dom';

/**
 * KS-2867 (ADR-060 §3.1 FR4) — единый источник «что мы открываем».
 *
 * До FR4 в `AnalysisPage` было разбросано:
 * - `params.id`/`params.gameId` через `useParams`,
 * - `analysisId`/`gameId`/`isAnalysisRoute`/`isGameRoute` — производные,
 * - `puzzleFen`/`puzzlePgn`/`puzzleMovesParam`/`puzzleSide` — из URL/state,
 * - `publicMode` — prop сверху.
 *
 * FR4 объединяет это в discriminated union `AnalysisContext`.
 *
 * `readOnly` — производное от kind/mode. UI-компоненты могут принимать
 * его как один проп вместо «угадывания» по publicMode.
 *
 * ADR-067 (KS-3014/KS-3131): модуль Studies удалён, AnalysisPage
 * обслуживает только review / analysis / puzzle.
 */

export type AnalysisContext =
  | {
      kind: 'review';
      /** Идентификатор партии (route `/games/:gameId`). */
      gameId: string;
      readOnly: boolean;
    }
  | {
      kind: 'analysis';
      /** UUID сохранённого анализа (route `/analysis/:id`). Может быть undefined для `/analysis` или `/analysis/new`. */
      analysisId?: string;
      /** Локальный id (для URL-syncing) — приходит из `location.state` или = `analysisId`. */
      localId?: string;
      /** Public read-only режим: `/analysis/public/:id` (любой пользователь без auth). */
      publicMode: boolean;
      readOnly: boolean;
    }
  | {
      kind: 'puzzle';
      /** FEN, переданный через `?fen=` или `location.state.puzzleFen`. */
      fen: string;
      /** Опциональный PGN-список ходов от стартовой позиции. */
      pgn?: string;
      /** Опциональный список UCI/SAN ходов из `?moves=`. */
      moves?: string;
      /** Цвет, которым играет пользователь, из `?side=`. */
      side?: 'white' | 'black';
      readOnly: false;
    };

export interface ResolveAnalysisContextInput {
  params: {
    id?: string;
    gameId?: string;
  };
  /** `location.state` из react-router. */
  state: unknown;
  /** `location.search` (raw query-string, например `?fen=...&side=white`). */
  search: string;
  /** `publicMode` flag (передаётся в AnalysisPage как prop из роута). */
  publicMode?: boolean;
}

/**
 * Pure-функция: единая логика «route → context». Вынесена из хука для
 * тестов без обёрток MemoryRouter.
 */
export function resolveAnalysisContext({
  params,
  state,
  search,
  publicMode = false,
}: ResolveAnalysisContextInput): AnalysisContext {
  const urlParams = new URLSearchParams(search);
  const stateRecord = (state ?? null) as Record<string, unknown> | null;

  // 1) Game review: `/games/:gameId`.
  if (params.gameId !== undefined) {
    return {
      kind: 'review',
      gameId: params.gameId,
      readOnly: publicMode,
    };
  }

  // 2) Analysis route с id: `/analysis/:id` или `/analysis/public/:id`.
  if (params.id !== undefined) {
    const rawId = params.id;
    const analysisId = rawId !== 'new' ? rawId : undefined;
    const stateLocalId =
      (stateRecord?.localId as string | undefined) ?? undefined;
    return {
      kind: 'analysis',
      analysisId,
      localId: stateLocalId ?? analysisId,
      publicMode,
      readOnly: publicMode,
    };
  }

  // 3) Никакого id в URL — может быть puzzle-from-URL или fresh analysis.
  //    Puzzle опознаём по наличию `?fen=` или `state.puzzleFen`.
  const fen =
    (stateRecord?.puzzleFen as string | undefined) ??
    urlParams.get('fen') ??
    undefined;
  if (fen) {
    const pgn =
      (stateRecord?.puzzlePgn as string | undefined) ??
      urlParams.get('pgn') ??
      undefined;
    const sideRaw = urlParams.get('side');
    return {
      kind: 'puzzle',
      fen,
      pgn,
      moves: urlParams.get('moves') ?? undefined,
      side: sideRaw === 'white' || sideRaw === 'black' ? sideRaw : undefined,
      readOnly: false,
    };
  }

  // 4) Fresh ad-hoc analysis: `/analysis` без id и без `?fen=`.
  return {
    kind: 'analysis',
    analysisId: undefined,
    localId: stateRecord?.localId as string | undefined,
    publicMode,
    readOnly: publicMode,
  };
}

/**
 * React-хук — оборачивает resolver, читая `useParams` + `useLocation`.
 */
export function useAnalysisContext(
  opts: { publicMode?: boolean } = {},
): AnalysisContext {
  const params = useParams<{
    id?: string;
    gameId?: string;
  }>();
  const location = useLocation();
  return resolveAnalysisContext({
    params,
    state: location.state,
    search: location.search,
    publicMode: opts.publicMode,
  });
}
