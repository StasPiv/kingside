import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api';
import { useStudySchedules } from '../hooks/useStudySchedules';
import type {
  StudyHistoryItemDto,
  StudyHistoryResponse,
  StudySessionDto,
  StudySessionsCurrentResponse,
  StudyTaskDto,
} from '@kingside/shared';

/**
 * KS-4883 / ADR-160 (задача 4 из 6). Страница `/study` — занятия дня.
 *
 * KS-4929 / ADR-163: тренировок может быть несколько — GET
 * /study/sessions/current отдаёт ближайшее занятие каждой активной
 * тренировки; карточка занятия подписана именем тренировки
 * (`scheduleName`). GET /study/schedules — для различения состояний
 * «нет тренировок» (CTA в /settings?tab=study) и «занятие ещё не
 * сгенерировано».
 *
 * Прогресс заданий (`doneCount`) наполняет reconciliation-трекинг
 * (KS-4884): до его выхода значения нулевые — UI это не ломает.
 */

/** Внутренний маршрут активности задания; null — ссылки нет. */
export function taskLink(task: StudyTaskDto): string | null {
  const p = (task.params ?? {}) as Record<string, unknown>;
  switch (task.type) {
    case 'puzzle_theme': {
      const q = new URLSearchParams();
      if (typeof p.theme === 'string' && p.theme) q.set('themes', p.theme);
      if (typeof p.ratingMin === 'number') q.set('ratingMin', String(p.ratingMin));
      if (typeof p.ratingMax === 'number') q.set('ratingMax', String(p.ratingMax));
      const qs = q.toString();
      return qs ? `/puzzles?${qs}` : '/puzzles';
    }
    case 'sm2_review':
      // Блок «повторения к сроку» живёт на лобби уроков.
      return '/lessons';
    case 'lesson':
      return typeof p.courseSlug === 'string' && p.courseSlug
        ? `/lessons/${p.courseSlug}`
        : '/lessons';
    case 'mistakes':
      return '/puzzles/mistakes-practice';
    case 'precision':
      return '/precision';
    case 'drill':
      return '/drills';
    case 'rated_game':
      return '/play';
    case 'game_review':
      // Разбор стартует из списка своих партий (профиль).
      return '/profile';
    case 'puzzle_rush':
      return '/puzzle-rush';
    case 'external_games':
      return null; // внешняя площадка, внутренней страницы нет
    default:
      return null;
  }
}

/** Человекочитаемая подпись задания по типу и params. */
export function taskLabel(t: TFunction, task: StudyTaskDto): string {
  const p = (task.params ?? {}) as Record<string, unknown>;
  switch (task.type) {
    case 'puzzle_theme': {
      const raw = typeof p.theme === 'string' && p.theme ? p.theme : null;
      const theme = raw
        ? t(`puzzleBrowser.themes.${raw}`, raw)
        : t('study.page.block.tactics', 'Tactics');
      return t('study.page.task.puzzle_theme', { count: task.targetCount, theme });
    }
    case 'sm2_review':
      return t('study.page.task.sm2_review', { count: task.targetCount });
    case 'lesson': {
      const title =
        (typeof p.lessonTitle === 'string' && p.lessonTitle) ||
        (typeof p.courseSlug === 'string' && p.courseSlug) ||
        '';
      return t('study.page.task.lesson', { lessonTitle: title });
    }
    case 'mistakes':
      return t('study.page.task.mistakes', { count: task.targetCount });
    case 'precision':
      return t('study.page.task.precision', { count: task.targetCount });
    case 'drill':
      return t('study.page.task.drill', { count: task.targetCount });
    case 'rated_game': {
      const tc = typeof p.timeControl === 'string' && p.timeControl ? p.timeControl : null;
      return tc
        ? t('study.page.task.rated_game', { timeControl: tc })
        : t('study.page.task.rated_game_plain', 'Rated game');
    }
    case 'game_review':
      return t('study.page.task.game_review');
    case 'puzzle_rush': {
      const target = p.targetScore ?? p.target ?? null;
      return target != null
        ? t('study.page.task.puzzle_rush', { target })
        : t('study.page.task.puzzle_rush_plain', 'Puzzle Rush');
    }
    case 'external_games':
      return t('study.page.task.external_games', {
        count: task.targetCount,
        provider: typeof p.provider === 'string' ? p.provider : 'lichess',
      });
    default:
      return task.type;
  }
}

function TaskRow({ task }: { task: StudyTaskDto }): ReactElement {
  const { t } = useTranslation();
  const link = taskLink(task);
  const label = taskLabel(t, task);
  const done = task.status === 'done';
  return (
    <li
      data-testid={`study-task-${task.position}`}
      className={`study-task${task.status === 'skipped' ? ' study-task-skipped' : ''}`}
    >
      <span aria-hidden className={`study-task-num${done ? ' study-task-num-done' : ''}`}>
        {done ? '✓' : task.position + 1 + '.'}
      </span>
      <span className="study-task-label">
        {link ? <Link to={link}>{label}</Link> : label}
      </span>
      <span
        data-testid={`study-task-${task.position}-progress`}
        className="study-task-progress"
      >
        {task.doneCount}/{task.targetCount}
      </span>
      <span className={`study-badge${done ? ' study-badge-done' : ''}`}>
        {t(`study.page.taskStatus.${task.status}`)}
      </span>
    </li>
  );
}

/**
 * KS-4912 / ADR-162 §2.2: main-задача занятия v2 — единственная задача
 * `type='lesson'` с `params.lessonId` (персональный урок). Роут плеера:
 * `/lessons/:courseSlug/:lessonId` — для user-курсов `:lessonSlug`
 * несёт UUID урока (см. LessonPage, KS-2645).
 */
export function findMainLesson(session: StudySessionDto): {
  task: StudyTaskDto;
  lessonId: string;
  courseSlug: string;
  themeLabel: string | null;
} | null {
  for (const task of session.tasks) {
    // KS-4916: role в DTO — homework-задачи (в т.ч. типа lesson) main
    // быть не могут. У сессий v1 все задачи role='main' (default
    // миграции), поэтому дополнительно требуем type='lesson' + params.
    if (task.role === 'homework' || task.type !== 'lesson') continue;
    const p = (task.params ?? {}) as Record<string, unknown>;
    if (typeof p.lessonId === 'string' && p.lessonId && typeof p.courseSlug === 'string' && p.courseSlug) {
      return {
        task,
        lessonId: p.lessonId,
        courseSlug: p.courseSlug,
        themeLabel: typeof p.themeLabel === 'string' && p.themeLabel ? p.themeLabel : null,
      };
    }
  }
  return null;
}

function SessionView({
  session,
  onRecheck,
  rechecking,
}: {
  session: StudySessionDto;
  onRecheck: () => void;
  rechecking: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const doneTasks = session.tasks.filter((task) => task.status === 'done').length;
  const total = session.tasks.length;

  // KS-4912: урок-центричный вид. main-урок — главная кнопка в плеер;
  // остальные задачи — блок «Домашнее задание». Сессии v1 (без урока
  // с lessonId в params) рендерятся прежним списком.
  const main = findMainLesson(session);
  const homework = main
    ? session.tasks.filter((task) => task.id !== main.task.id)
    : session.tasks;
  return (
    <section className="settings-section" data-testid="study-session">
      {/* KS-4929 / ADR-163: имя тренировки — занятий может быть несколько. */}
      {session.scheduleName && (
        <h2 className="study-session-schedule" data-testid="study-session-schedule-name">
          {session.scheduleName}
        </h2>
      )}
      <div className="study-session-head">
        <span
          data-testid="study-session-status"
          className={`study-badge study-badge-status study-badge-${session.status}`}
        >
          {t(`study.page.status.${session.status}`)}
        </span>
        <span data-testid="study-session-progress" className="study-session-progress">
          {t('study.page.progress', { done: doneTasks, total })}
        </span>
        <button
          type="button"
          data-testid="study-session-recheck"
          onClick={onRecheck}
          disabled={rechecking}
          className="study-recheck-btn"
        >
          {t('study.page.recheck')}
        </button>
      </div>

      {session.status === 'completed' && (
        <p data-testid="study-session-completed" className="study-banner study-banner-ok">
          <strong>{t('study.page.completed.title')}</strong>{' '}
          {t('study.page.completed.body')}
          {/* KS-4916: score завершённого урока. */}
          {session.score != null && (
            <span data-testid="study-session-score" className="study-session-score">
              {' '}
              {t('study.page.history.score', 'Score: {{score}}', { score: session.score })}
            </span>
          )}
        </p>
      )}
      {session.status === 'expired' && (
        <p data-testid="study-session-expired" className="study-banner study-banner-muted">
          <strong>{t('study.page.expired.title')}</strong> {t('study.page.expired.body')}
        </p>
      )}

      {/* KS-4912: карточка персонального урока — главное действие. */}
      {main && (
        <div className="study-lesson-card" data-testid="study-lesson-card">
          <h3 className="study-lesson-card__title">
            {t('study.page.lesson.title', 'Personal lesson')}
          </h3>
          {main.themeLabel && (
            <p className="study-lesson-card__theme" data-testid="study-lesson-theme">
              {t('study.page.lesson.theme', 'Topic: {{theme}}', { theme: main.themeLabel })}
            </p>
          )}
          <p className="study-lesson-card__hint">
            {t(
              'study.page.lesson.hint',
              'Built from your games and stats. Complete it — homework follows.',
            )}
          </p>
          {main.task.status === 'done' ? (
            <span className="study-lesson-card__done" data-testid="study-lesson-done">
              ✓ {t('study.page.lesson.done', 'Lesson completed')}
            </span>
          ) : (
            <Link
              to={`/lessons/${main.courseSlug}/${main.lessonId}`}
              data-testid="study-lesson-start"
            >
              <button type="button" className="study-lesson-card__cta">
                {session.status === 'in_progress'
                  ? t('study.page.continue', 'Continue session')
                  : t('study.page.start', 'Start session')}
              </button>
            </Link>
          )}
        </div>
      )}

      {homework.length > 0 && (
        <>
          {main && (
            <h3 className="study-homework-title" data-testid="study-homework-title">
              {t('study.page.homework.title', 'Homework')}
            </h3>
          )}
          <ul className="study-task-list">
            {homework
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * KS-4916 / ADR-162 §5: история занятий со score — видимый контроль
 * прогресса. GET /study/history (последние 10): дата, статус, тема,
 * score урока, сводка домашки.
 */
function HistoryBlock(): ReactElement | null {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<StudyHistoryItemDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<StudyHistoryResponse>('/study/history?limit=10')
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!items || items.length === 0) return null;
  const fmt = new Intl.DateTimeFormat(i18n.language || 'en', {
    day: 'numeric',
    month: 'short',
  });
  return (
    <section className="settings-section" data-testid="study-history">
      <h2>{t('study.page.history.title', 'Session history')}</h2>
      <ul className="study-history-list">
        {items.map((item) => (
          <li key={item.id} className="study-history-item" data-testid={`study-history-${item.id}`}>
            <span className="study-history-item__date">
              {fmt.format(new Date(item.scheduledAt))}
            </span>
            {/* KS-4929 / ADR-163: имя тренировки, породившей занятие. */}
            {item.scheduleName && (
              <span
                className="study-history-item__schedule"
                data-testid={`study-history-${item.id}-schedule`}
              >
                {item.scheduleName}
              </span>
            )}
            {item.themeLabel && (
              <span className="study-history-item__theme">{item.themeLabel}</span>
            )}
            <span className={`study-badge study-badge-status study-badge-${item.status}`}>
              {t(`study.page.status.${item.status}`)}
            </span>
            <span className="study-history-item__score" data-testid={`study-history-${item.id}-score`}>
              {item.score != null
                ? t('study.page.history.score', 'Score: {{score}}', { score: item.score })
                : '—'}
            </span>
            {item.homeworkTotal > 0 && (
              <span className="study-history-item__homework">
                {t('study.page.history.homework', 'Homework {{done}}/{{total}}', {
                  done: item.homeworkDone,
                  total: item.homeworkTotal,
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * KS-4912 / ADR-162 §3.2: онбординг источников партий. Персональный
 * урок собирается из партий пользователя; если нет ни привязанных
 * внешних аккаунтов (chess.com/lichess), ни загруженных PGN — баннер
 * с двумя действиями. Источники — существующие API:
 * GET /users/me/settings (usernames), GET /workshop/pgn-files.
 */
function MaterialOnboardingBanner(): ReactElement | null {
  const { t } = useTranslation();
  const [state, setState] = useState<'loading' | 'has-material' | 'no-material'>('loading');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ chesscomUsername?: string | null; lichessUsername?: string | null }>(
        '/users/me/settings',
      ),
      api.get<{ data?: unknown[] } | unknown[]>('/workshop/pgn-files'),
    ])
      .then(([settings, filesRaw]) => {
        if (cancelled) return;
        const hasAccounts = Boolean(settings.chesscomUsername || settings.lichessUsername);
        const files = Array.isArray(filesRaw) ? filesRaw : (filesRaw.data ?? []);
        setState(hasAccounts || files.length > 0 ? 'has-material' : 'no-material');
      })
      .catch(() => {
        // Не удалось определить — баннер не показываем (не пугаем зря).
        if (!cancelled) setState('has-material');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state !== 'no-material') return null;
  return (
    <section
      className="settings-section study-material-banner"
      data-testid="study-material-banner"
    >
      <h2>{t('study.page.material.title', 'Add your games')}</h2>
      <p className="study-material-banner__body">
        {t(
          'study.page.material.body',
          'Personal lessons are built from your games. Link your chess.com or lichess account, or upload a PGN file — until then lessons use general material for your level.',
        )}
      </p>
      <div className="study-material-banner__actions">
        <Link to="/settings?tab=account" data-testid="study-material-link-accounts">
          <button type="button">
            {t('study.page.material.linkAccounts', 'Link accounts')}
          </button>
        </Link>
        <Link to="/workshop/pgn-files" data-testid="study-material-upload-pgn">
          <button type="button">
            {t('study.page.material.uploadPgn', 'Upload PGN')}
          </button>
        </Link>
      </div>
    </section>
  );
}

export function StudyPage(): ReactElement {
  const { t } = useTranslation();
  const { schedules, loading: schedulesLoading, error: schedulesError } = useStudySchedules();

  // KS-4929 / ADR-163: ближайшее занятие каждой активной тренировки.
  const [sessions, setSessions] = useState<StudySessionDto[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.get<StudySessionsCurrentResponse>('/study/sessions/current');
      setSessions(res.sessions);
      setSessionError(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'error');
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const handleRecheck = useCallback(async () => {
    setRechecking(true);
    await fetchSessions();
    setRechecking(false);
  }, [fetchSessions]);

  const loading = schedulesLoading || sessionLoading;
  const error = schedulesError || sessionError;
  const hasSchedules = schedules.length > 0;

  return (
    <div className="study-page">
      <h1>{t('study.page.title', "Today's session")}</h1>
      <p className="study-subtitle">
        {t('study.page.subtitle', 'Prepared for you based on your level and progress')}
      </p>

      {loading && <p>{t('common.loading', 'Loading…')}</p>}

      {!loading && error && (
        <p className="study-error" data-testid="study-page-error">
          {t('study.page.loadError', 'Failed to load. Try again later.')}
        </p>
      )}

      {!loading && !error && <MaterialOnboardingBanner />}

      {!loading && !error &&
        sessions.map((session) => (
          <SessionView
            key={session.id}
            session={session}
            onRecheck={() => void handleRecheck()}
            rechecking={rechecking}
          />
        ))}

      {!loading && !error && sessions.length === 0 && !hasSchedules && (
        <section className="settings-section" data-testid="study-empty-no-schedule">
          <p>{t('study.page.empty.noSchedule')}</p>
          <Link to="/settings?tab=study">
            <button type="button">{t('study.page.empty.noScheduleCta')}</button>
          </Link>
        </section>
      )}

      {!loading && !error && sessions.length === 0 && hasSchedules && (
        <section className="settings-section" data-testid="study-empty-no-session">
          <p>{t('study.page.empty.noSession')}</p>
        </section>
      )}

      {!loading && !error && <HistoryBlock />}

      {!loading && !error && (
        <section className="settings-section">
          <h2>{t('study.page.why.title')}</h2>
          <p className="study-why-body">{t('study.page.why.body')}</p>
        </section>
      )}
    </div>
  );
}
