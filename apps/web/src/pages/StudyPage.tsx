import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStudySchedule } from '../hooks/useStudySchedule';

/**
 * KS-4883 / ADR-160 (задача 4 из 6). Страница `/study` — занятие дня.
 *
 * Состояния по данным живого API (KS-4880):
 *   - расписания нет → приглашение настроить (CTA в /settings?tab=study);
 *   - расписание есть, занятие ещё не сгенерировано → «появится ближе
 *     к назначенному времени».
 *
 * Блок «текущее занятие + задания с прогрессом» требует REST чтения
 * StudySession/StudyTask — endpoint в apps/api отсутствует (зона
 * backend, см. комментарий в KS-4883). Подключается после появления
 * контракта в packages/shared.
 */
export function StudyPage(): ReactElement {
  const { t } = useTranslation();
  const { schedule, loading, error } = useStudySchedule();

  return (
    <div className="study-page" style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1>{t('study.page.title', "Today's session")}</h1>
      <p style={{ opacity: 0.8, marginTop: 0 }}>
        {t('study.page.subtitle', 'Prepared for you based on your level and progress')}
      </p>

      {loading && <p>{t('common.loading', 'Loading…')}</p>}

      {!loading && error && (
        <p style={{ color: 'var(--c-ef4444)' }} data-testid="study-page-error">
          {t('study.page.loadError', 'Failed to load. Try again later.')}
        </p>
      )}

      {!loading && !error && !schedule && (
        <section className="settings-section" data-testid="study-empty-no-schedule">
          <p>{t('study.page.empty.noSchedule')}</p>
          <Link to="/settings?tab=study">
            <button type="button">{t('study.page.empty.noScheduleCta')}</button>
          </Link>
        </section>
      )}

      {!loading && !error && schedule && (
        <section className="settings-section" data-testid="study-empty-no-session">
          <p>{t('study.page.empty.noSession')}</p>
        </section>
      )}

      {!loading && !error && (
        <section className="settings-section">
          <h2>{t('study.page.why.title')}</h2>
          <p style={{ opacity: 0.85 }}>{t('study.page.why.body')}</p>
        </section>
      )}
    </div>
  );
}
