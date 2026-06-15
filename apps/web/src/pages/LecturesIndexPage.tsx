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
import { usePublicLectures } from '../hooks/usePublicLectures';

const SECTION_HEADING_STYLE: React.CSSProperties = {
  margin: '24px 0 12px',
  fontSize: 13,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
};

export function LecturesIndexPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const forceDiscover = searchParams.get('view') === 'discover';

  // KS-4217 / ADR-128 §7.6.1.2 L1. Лёгкий probe-запрос за публичным
  // списком лекций для JSON-LD `ItemList`. `limit=20` достаточно для
  // SEO-среза (Google всё равно ограничит вывод первой страницы).
  // Этот запрос дублирует то, что внутри делает `PublicLecturesCatalog`
  // (`limit=24`); вынос общего state — отдельная задача (см. README в
  // `PublicLecturesCatalog`). Здесь — приоритет SEO-контракта.
  const probe = usePublicLectures({ limit: 20 });

  const seoBlock = (
    <SeoHelmet
      title={t('seo.lectures.list.title')}
      description={t('seo.lectures.list.description')}
      canonical="https://kingside.site/lectures"
      ogType="website"
      ogImage="/og/lecture.png"
      jsonLd={{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: t('seo.lectures.list.title'),
        description: t('seo.lectures.list.description'),
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: probe.total || probe.items.length,
          itemListElement: probe.items.slice(0, 20).map((l, idx) => ({
            '@type': 'ListItem',
            position: idx + 1,
            url: `https://kingside.site/lectures/${encodeURIComponent(l.id)}`,
            name: l.title,
          })),
        },
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
      >
        <h2 id="lectures-index-discover-heading" style={SECTION_HEADING_STYLE}>
          {t('lecturesIndex.discoverSection', 'Discover public lectures')}
        </h2>
        <PublicLecturesCatalog mode="preview" limit={6} showGuestCta={false} />
      </section>
    </div>
  );
}
