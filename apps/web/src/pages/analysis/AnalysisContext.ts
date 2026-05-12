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
 * FR4 объединяет это в discriminated union `AnalysisContext`. На FS1/FS2
 * добавится подтип `study` — backbone готов уже сейчас.
 *
 * `readOnly` — производное от kind/mode. UI-компоненты на FR3 могут
 * принимать его как один проп вместо «угадывания» по publicMode.
 */

export type StudyMode = 'editor' | 'public-readonly' | 'embed';

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
    }
  | {
      kind: 'study';
      /** Slug студии (`/studies/:slug/:chapterId`). Для public-роута `/studies/c/:chapterId` — пустая строка. */
      slug: string;
      chapterId: string;
      mode: StudyMode;
      readOnly: boolean;
    };

export interface ResolveAnalysisContextInput {
  params: {
    id?: string;
    gameId?: string;
    slug?: string;
    chapterId?: string;
  };
  /** `location.state` из react-router. */
  state: unknown;
  /** `location.search` (raw query-string, например `?fen=...&side=white`). */
  search: string;
  /** `publicMode` flag (передаётся в AnalysisPage как prop из роута). */
  publicMode?: boolean;
  /**
   * Опциональный override для study-режима. На FR4 не используется
   * (study-роуты пока не подключены) — параметр под FS1/FS2.
   */
  studyMode?: StudyMode;
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
  studyMode,
}: ResolveAnalysisContextInput): AnalysisContext {
  const urlParams = new URLSearchParams(search);
  const stateRecord = (state ?? null) as Record<string, unknown> | null;

  // 1) Study-роут (chapterId присутствует). На FR4 эта ветка живёт
  //    «вхолостую» — routes ещё не подключены к AnalysisPage, но FS1/FS2
  //    будут вызывать `useAnalysisContext({ studyMode: 'editor' })`
  //    из обёртки.
  if (params.chapterId) {
    const slug = params.slug ?? '';
    // Если studyMode явно не указан: slug есть → editor, slug нет →
    // public-readonly (роут `/studies/c/:chapterId`).
    const mode: StudyMode = studyMode ?? (params.slug ? 'editor' : 'public-readonly');
    return {
      kind: 'study',
      slug,
      chapterId: params.chapterId,
      mode,
      readOnly: mode !== 'editor',
    };
  }

  // 2) Game review: `/games/:gameId`.
  if (params.gameId !== undefined) {
    return {
      kind: 'review',
      gameId: params.gameId,
      // KS-2672: для review (партии из архива) publicMode не имеет смысла
      // (партии всегда public), но в существующих тестах review-роут
      // никогда не получает publicMode=true. Оставляем эту ветку
      // последовательной: readOnly наследуется от publicMode для будущих
      // расширений.
      readOnly: publicMode,
    };
  }

  // 3) Analysis route с id: `/analysis/:id` или `/analysis/public/:id`.
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

  // 4) Никакого id в URL — может быть puzzle-from-URL или fresh analysis.
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

  // 5) Fresh ad-hoc analysis: `/analysis` без id и без `?fen=`.
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
 * Возвращает стабильный объект `AnalysisContext` при каждом рендере;
 * react-router сам мемоизирует location, так что в большинстве случаев
 * результат идентичен по reference между ренда́ми.
 */
export function useAnalysisContext(
  opts: { publicMode?: boolean; studyMode?: StudyMode } = {},
): AnalysisContext {
  const params = useParams<{
    id?: string;
    gameId?: string;
    slug?: string;
    chapterId?: string;
  }>();
  const location = useLocation();
  return resolveAnalysisContext({
    params,
    state: location.state,
    search: location.search,
    publicMode: opts.publicMode,
    studyMode: opts.studyMode,
  });
}
