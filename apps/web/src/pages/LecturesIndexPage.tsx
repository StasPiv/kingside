/**
 * KS-3969 / ADR-119 §8 эпик B. Маршрут `/lectures`.
 *
 * KS-4192 / ADR-128 §7.6.1.2 L1 + L1.UI. Развилка по статусу
 * пользователя:
 *
 *   - Гость (нет `useAuth().user`): показываем гостевой
 *     `<PublicLecturesCatalog mode="full">` — единая публичная
 *     витрина с Hero, inline-CTA «войти», вкладками статусов,
 *     гридом карточек и «Show more». Никаких «As a coach / student»
 *     для гостя.
 *
 *   - Авторизованный без `?view=discover`: классические две секции
 *     («As a coach» = MyLecturesPage, «As a student» =
 *     StudentLecturesPage), плюс третья «Discover public lectures» —
 *     `<PublicLecturesCatalog mode="preview" limit={6}>` с CTA
 *     «See all» → `/lectures?view=discover`.
 *
 *   - Авторизованный с `?view=discover` — принудительно показываем
 *     гостевой каталог (без guest-CTA баннера, он там не нужен).
 *
 * SEO (бывшая KS-4189): `<SeoHelmet>` на корневом уровне со
 * списочными `seo.lectures.list.*`, JSON-LD `CollectionPage`
 * (`numberOfItems` подменим, когда backend начнёт отдавать total
 * через отдельный probe; пока — без `ItemList`, fallback по
 * §L1.UI.7).
 */
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import { MyLecturesPage } from './MyLecturesPage';
import { StudentLecturesPage } from './StudentLecturesPage';
import { PublicLecturesCatalog } from '../components/lectures/PublicLecturesCatalog';
import { SeoHelmet } from '../components/seo/SeoHelmet';

const SECTION_HEADING_STYLE: React.CSSProperties = {
  margin: '24px auto 0',
  maxWidth: 1100,
  padding: '0 16px',
  fontSize: 14,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  opacity: 0.6,
};

export function LecturesIndexPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const forceDiscover = searchParams.get('view') === 'discover';

  const seoBlock = (
    <SeoHelmet
      title={t('seo.lectures.list.title')}
      description={t('seo.lectures.list.description')}
      ogType="website"
      ogImage="/og/lecture.png"
      jsonLd={{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: t('seo.lectures.list.title'),
        description: t('seo.lectures.list.description'),
      }}
    />
  );

  // Гость или принудительный discover-режим у авторизованного: только
  // гостевой каталог. Guest-CTA баннер показываем именно гостям, у
  // авторизованного он не нужен (есть навигация в собственных секциях).
  if (!user || forceDiscover) {
    return (
      <div
        className="lectures-index-page lectures-index-page--public"
        data-testid="lectures-index-page"
        style={{ paddingBottom: 32 }}
      >
        {seoBlock}
        <PublicLecturesCatalog mode="full" showGuestCta={!user} />
      </div>
    );
  }

  // Авторизованный без discover: исходные две секции + блок-превью.
  return (
    <div
      className="lectures-index-page"
      data-testid="lectures-index-page"
      style={{ paddingBottom: 32 }}
    >
      {seoBlock}
      <section
        aria-labelledby="lectures-index-coach-heading"
        data-testid="lectures-index-coach-section"
      >
        <h2 id="lectures-index-coach-heading" style={SECTION_HEADING_STYLE}>
          {t('lecturesIndex.coachSection', 'As a coach')}
        </h2>
        <MyLecturesPage />
      </section>

      <section
        aria-labelledby="lectures-index-student-heading"
        data-testid="lectures-index-student-section"
      >
        <h2 id="lectures-index-student-heading" style={SECTION_HEADING_STYLE}>
          {t('lecturesIndex.studentSection', 'As a student')}
        </h2>
        <StudentLecturesPage />
      </section>

      <section
        aria-labelledby="lectures-index-discover-heading"
        data-testid="lectures-index-discover-section"
        style={{ margin: '24px auto 0', maxWidth: 1100, padding: '0 16px' }}
      >
        <h2 id="lectures-index-discover-heading" style={SECTION_HEADING_STYLE}>
          {t('lecturesIndex.discoverSection', 'Discover public lectures')}
        </h2>
        <PublicLecturesCatalog mode="preview" limit={6} showGuestCta={false} />
      </section>
    </div>
  );
}
