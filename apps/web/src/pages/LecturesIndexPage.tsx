/**
 * KS-3969 / ADR-119 §8 эпик B (B04). Маршрут `/lectures`. В этой
 * первой итерации страница показывает оба раздела сразу:
 *   1. Тренерская часть (`MyLecturesPage`) — таблица, фильтры,
 *      ⋮-меню. Если у пользователя нет собственных лекций, она
 *      отобразит пустой список — это допустимое поведение по
 *      описанию задачи.
 *   2. Ученическая часть (`StudentLecturesPage`) — три секции
 *      live/scheduled/recorded по лекциям из allowlist.
 *
 * Эпик C добавит «контекст»: автоматический выбор режима по
 * наличию собственных лекций / админ-флагам. Сейчас осознанно
 * избегаем эвристик — пользователь, у которого нет ни своих
 * лекций, ни записей в allowlist, увидит оба пустых раздела и
 * поймёт, где будут появляться будущие лекции.
 *
 * Маршрут `/lectures` ссылается на этот компонент через
 * `LecturesListPage`-переэкспорт (см. `LecturesListPage.tsx`).
 */
import { useTranslation } from 'react-i18next';
import { MyLecturesPage } from './MyLecturesPage';
import { StudentLecturesPage } from './StudentLecturesPage';

export function LecturesIndexPage() {
  const { t } = useTranslation();
  return (
    <div
      className="lectures-index-page"
      data-testid="lectures-index-page"
      style={{ paddingBottom: 32 }}
    >
      <section
        aria-labelledby="lectures-index-coach-heading"
        data-testid="lectures-index-coach-section"
      >
        <h2
          id="lectures-index-coach-heading"
          style={{
            margin: '24px auto 0',
            maxWidth: 1100,
            padding: '0 16px',
            fontSize: 14,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            opacity: 0.6,
          }}
        >
          {t('lecturesIndex.coachSection', 'As a coach')}
        </h2>
        <MyLecturesPage />
      </section>

      <section
        aria-labelledby="lectures-index-student-heading"
        data-testid="lectures-index-student-section"
      >
        <h2
          id="lectures-index-student-heading"
          style={{
            margin: '24px auto 0',
            maxWidth: 1100,
            padding: '0 16px',
            fontSize: 14,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            opacity: 0.6,
          }}
        >
          {t('lecturesIndex.studentSection', 'As a student')}
        </h2>
        <StudentLecturesPage />
      </section>
    </div>
  );
}
