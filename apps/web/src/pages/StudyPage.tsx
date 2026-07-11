import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api';
import { useStudySchedule } from '../hooks/useStudySchedule';
import type { StudySessionDto, StudySessionResponse, StudyTaskDto } from '@kingside/shared';

/**
 * KS-4883 / ADR-160 (задача 4 из 6). Страница `/study` — занятие дня.
 *
 * Данные: GET /study/session (KS-4886) — текущее занятие с заданиями;
 * GET /study/schedule — для различения состояний «нет расписания»
 * (CTA в /settings?tab=study) и «занятие ещё не сгенерировано».
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
  return (
    <section className="settings-section" data-testid="study-session">
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
        </p>
      )}
      {session.status === 'expired' && (
        <p data-testid="study-session-expired" className="study-banner study-banner-muted">
          <strong>{t('study.page.expired.title')}</strong> {t('study.page.expired.body')}
        </p>
      )}

      <ul className="study-task-list">
        {session.tasks
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
      </ul>
    </section>
  );
}

export function StudyPage(): ReactElement {
  const { t } = useTranslation();
  const { schedule, loading: scheduleLoading, error: scheduleError } = useStudySchedule();

  const [session, setSession] = useState<StudySessionDto | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const fetchSession = useCallback(async () => {
    try {
      const res = await api.get<StudySessionResponse>('/study/session');
      setSession(res.session);
      setSessionError(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'error');
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSession();
  }, [fetchSession]);

  const handleRecheck = useCallback(async () => {
    setRechecking(true);
    await fetchSession();
    setRechecking(false);
  }, [fetchSession]);

  const loading = scheduleLoading || sessionLoading;
  const error = scheduleError || sessionError;

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

      {!loading && !error && session && (
        <SessionView session={session} onRecheck={() => void handleRecheck()} rechecking={rechecking} />
      )}

      {!loading && !error && !session && !schedule && (
        <section className="settings-section" data-testid="study-empty-no-schedule">
          <p>{t('study.page.empty.noSchedule')}</p>
          <Link to="/settings?tab=study">
            <button type="button">{t('study.page.empty.noScheduleCta')}</button>
          </Link>
        </section>
      )}

      {!loading && !error && !session && schedule && (
        <section className="settings-section" data-testid="study-empty-no-session">
          <p>{t('study.page.empty.noSession')}</p>
        </section>
      )}

      {!loading && !error && (
        <section className="settings-section">
          <h2>{t('study.page.why.title')}</h2>
          <p className="study-why-body">{t('study.page.why.body')}</p>
        </section>
      )}
    </div>
  );
}
