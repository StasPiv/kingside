/**
 * KS-4325. Публичный SEO-лендинг `/analyze-pgn-online`.
 * Контент — длинный SEO-текст из `/tmp/seo-texts/03-analysis-import.md`,
 * вынесенный в `AnalyzePgnOnlineSeoSection`. CTA внутри секции ведёт
 * на `/analysis` (рабочий анализатор).
 *
 * SEO-параметры (title/description/canonical/hreflang/ogImage/JSON-LD)
 * берутся из i18n-ключей `seo.analyzePgnOnline.*` через `PageSeo`.
 */
import { PageSeo } from '../components/seo/PageSeo';
import { AnalyzePgnOnlineSeoSection } from '../components/seo/sections/AnalyzePgnOnlineSeoSection';

export function AnalyzePgnOnlinePage() {
  return (
    <>
      <PageSeo
        ns="analyzePgnOnline"
        path="/analyze-pgn-online"
        ogImage="/og/analyze-pgn-online.png"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebApplication',
          name: 'Kingside PGN Import',
          applicationCategory: 'GameApplication',
          operatingSystem: 'Web',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        }}
      />
      <AnalyzePgnOnlineSeoSection />
    </>
  );
}
