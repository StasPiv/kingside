import type { NavigateFunction } from 'react-router-dom';

import { api } from '../api';

/**
 * KS-2603 (ADR-051 §4 этап B1): унифицированный helper перехода в
 * `/analysis/<id>` для всех точек входа в анализ — мастерская «+ Новый»
 * (B2), `WorkshopPgnList` «Открыть партию» (B3), `PuzzlePage` «Анализ»
 * (B4), `LobbyPage` «Свободный анализ» (B5), а также legacy-точки
 * Archive/Broadcast через тонкую обёртку `openAnalysisFromPgn`.
 *
 * # Зачем helper
 *
 * Раньше каждая точка входа `navigate('/analysis', { state })` без id;
 * `AnalysisPage` сам создавал запись на mount и менял URL через
 * `window.history.replaceState`. React Router об этой подмене не знал,
 * второй клик из той же сессии приходил на тот же `/analysis`,
 * `localIdRef.current` оставался от первого id, autosave перезаписывал
 * первую партию телом второй (KS-2403). После A1+A2 (KS-2598/KS-2599)
 * backend принимает пустой PGN, и helper всегда создаёт уникальный id
 * перед navigate — даже для сценария «новый чистый анализ».
 *
 * # 3 режима
 *
 * 1. `existingId` задан → navigate(`/analysis/<existingId>`) без POST.
 *    Используется для «открыть из списка» (B3 WorkshopPgnList) — запись
 *    уже создана раньше.
 *
 * 2. `pgn` задан (включая `''`) → POST `/analyses {pgn, title, category}`
 *    → navigate(`/analysis/<created.id>`). Поддержка пустого PGN — это
 *    как раз сценарий B2/B5: «свободный анализ» / «новая партия».
 *
 * 3. Ничего не задано → POST с `pgn=''` и default title — эквивалент
 *    «свободный анализ». Краткая запись для callsite'ов где нет PGN.
 *
 * # Error path
 *
 * Если POST упал (network, 4xx/5xx, auth) — вызывается `onError(message)`
 * с локализованным текстом. По умолчанию `onError` — `alert(message)`,
 * чтобы пользователь видел проблему. Helper НЕ navigate'ит на
 * `/analysis` без id (это и есть симптом из KS-2403, который ADR-051
 * чинит). Вызывающее место остаётся текущей страницей.
 *
 * Опц. `t` — i18n-функция, помогающая собрать сообщение. Если не задана,
 * используется fallback EN-строка.
 */
/**
 * KS-3261: source-game идентификаторы для dedup. Если бэкенд найдёт
 * существующий analysis того же пользователя с тем же lichessGameId
 * или archiveGameId — он вернёт `{id, existing: true}` без записи
 * новой строки + обновит `lastOpenedAt`. Helper кладёт `openedExisting:
 * true` в `state` навигации; AnalysisPage показывает toast «Открыли
 * существующий анализ».
 */
export interface OpenAnalysisArgs {
  /**
   * Если задан — navigate сразу на `/analysis/<existingId>` без POST.
   * Используется для «открыть существующий анализ» (B3).
   */
  existingId?: string;
  /**
   * PGN для нового анализа. Допустима пустая строка `''` — для сценария
   * «свободный анализ». Игнорируется если задан `existingId`.
   */
  pgn?: string;
  /**
   * Заголовок для POST. Игнорируется если `existingId`. По умолчанию
   * `'New analysis'` (EN). Для разных entry-point'ов вызывающее место
   * передаёт свой осмысленный title (например, имя файла, имена игроков).
   */
  title?: string;
  /** Доп. поля state навигации (breadcrumb*, прочее). */
  state?: Record<string, unknown>;
  /** `replace` вместо push — для редиректов из legacy URL. */
  replace?: boolean;
  /**
   * Кастомный обработчик ошибки POST. По умолчанию `alert(message)` —
   * минимальный видимый сигнал, т. к. глобального toast в проекте пока
   * нет (см. SetPositionModal#KS-2220 — inline-сообщение, не toast).
   * Каждое callsite может передать свой обработчик (например, setState
   * для inline-баннера).
   */
  onError?: (message: string) => void;
  /**
   * Опциональная i18n t-функция. Если задана — error-message берётся
   * из `analysis.openError`. Если нет — используется fallback EN.
   */
  t?: (key: string, defaultValue: string) => string;
  /**
   * KS-2605 (ADR-051 §4 B3): по умолчанию helper НЕ кладёт `pgn`/`title`
   * в `state` навигации — id в URL уникальный, `AnalysisPage` подгружает
   * запись по id через GET /analyses/:id, передача PGN через state не
   * нужна и противоречит цели ADR-051. Старая обёртка
   * `openAnalysisFromPgn` для legacy Archive/Broadcast сохраняет прежний
   * контракт через `includePgnInState: true` — там AnalysisPage умеет
   * показать initial-render по `state.pgn` до прихода ответа GET.
   */
  includePgnInState?: boolean;
  /**
   * KS-3261: lichess game id (например `Iw3wAwFB`) для dedup. Передаётся
   * legacy-callsite'ами Broadcast (BroadcastGamePage / BroadcastLiveGamePage).
   * Backend сравнивает с `analyses.lichessGameId` индексом.
   */
  lichessGameId?: string;
  /**
   * KS-3261: archive game UUID для dedup. Передаётся `ArchiveGamePage`.
   */
  archiveGameId?: string;
}

const DEFAULT_TITLE = 'New analysis';
const DEFAULT_ERROR_FALLBACK_EN = 'Could not open analysis. Please try again.';

export async function openAnalysis(
  navigate: NavigateFunction,
  args: OpenAnalysisArgs = {},
): Promise<void> {
  const navOpts: { state: Record<string, unknown>; replace?: true } = {
    state: { ...(args.state ?? {}) },
  };
  if (args.replace) navOpts.replace = true;

  // 1. existingId — переход без POST.
  if (args.existingId) {
    navigate(`/analysis/${args.existingId}`, navOpts);
    return;
  }

  // 2. POST /analyses (pgn — может быть '' для «свободного анализа»).
  const pgn = args.pgn ?? '';
  const title = args.title ?? DEFAULT_TITLE;
  // KS-2605: pgn/title в state — только если явно запрошено через
  // `includePgnInState`. По умолчанию state не содержит PGN — id в URL
  // уникальный, AnalysisPage подгружает по id (GET /analyses/:id).
  // Legacy-обёртка `openAnalysisFromPgn` задаёт флаг для back-compat.
  if (args.includePgnInState) {
    navOpts.state = { ...navOpts.state, pgn, title };
  }

  try {
    // KS-3261: пробрасываем source-IDs, если переданы. Backend (commit
    // 1b18d16f, task-def 290) делает dedup-lookup и возвращает `existing:
    // true` если у пользователя уже есть analysis по этому источнику.
    const body: {
      pgn: string;
      title: string;
      category: string;
      lichessGameId?: string;
      archiveGameId?: string;
    } = { pgn, title, category: 'analysis' };
    if (args.lichessGameId) body.lichessGameId = args.lichessGameId;
    if (args.archiveGameId) body.archiveGameId = args.archiveGameId;
    const created = await api.post<{ id: string; existing?: boolean }>(
      '/analyses',
      body,
    );
    // KS-3261: при dedup-hit — кладём флаг в state, AnalysisPage покажет
    // toast «Открыли существующий анализ».
    //
    // KS-3262: при existing=true ВЫРЕЗАЕМ pgn/title из state. Иначе
    // AnalysisPage в useState initial читает state.pgn (входящий PGN
    // из source — broadcast/archive movetext без аннотаций) и
    // инициализирует board из него, теряя сохранённые варианты/NAG/
    // стрелки. Сам PGN в БД цел (backend не перезаписывает при dedup-
    // hit), но фронт-render идёт из state.pgn до getById ответа. Без
    // pgn в state AnalysisPage сразу делает getById(id) и
    // рендерит сохранённый PGN с аннотациями.
    if (created.existing) {
      const { pgn: _droppedPgn, title: _droppedTitle, ...rest } =
        navOpts.state as { pgn?: string; title?: string };
      navOpts.state = { ...rest, openedExisting: true };
    }
    navigate(`/analysis/${created.id}`, navOpts);
  } catch (err) {
    const message = args.t
      ? args.t('analysis.openError', DEFAULT_ERROR_FALLBACK_EN)
      : DEFAULT_ERROR_FALLBACK_EN;
    if (args.onError) {
      args.onError(message);
    } else if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message);
    }
    // Логируем причину для отладки — `err` может содержать ApiError
    // с дополнительным контекстом (status, тело ответа).
    console.error('[openAnalysis] POST /analyses failed', err);
  }
}
