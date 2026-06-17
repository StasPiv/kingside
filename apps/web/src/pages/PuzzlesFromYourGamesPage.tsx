/**
 * KS-4325. Публичный SEO-лендинг `/puzzles-from-your-games`.
 * Контент — длинный SEO-текст из `/tmp/seo-texts/02-puzzles-mistakes.md`,
 * вынесенный в `PuzzlesFromYourGamesSeoSection`. CTA внутри секции
 * ведёт на `/puzzles/mistakes` (рабочий раздел тематических ошибок,
 * вход — после логина).
 *
 * SEO-параметры (title/description/canonical/hreflang/ogImage/JSON-LD)
 * берутся из i18n-ключей `seo.puzzlesFromYourGames.*` через `PageSeo`.
 */
import { PageSeo } from '../components/seo/PageSeo';
import { PuzzlesFromYourGamesSeoSection } from '../components/seo/sections/PuzzlesFromYourGamesSeoSection';

export function PuzzlesFromYourGamesPage() {
  return (
    <>
      <PageSeo
        ns="puzzlesFromYourGames"
        path="/puzzles-from-your-games"
        ogImage="/og/puzzles-from-your-games.png"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'WebApplication',
          name: 'Kingside Puzzles from your games',
          applicationCategory: 'GameApplication',
          operatingSystem: 'Web',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        }}
      />
      <PuzzlesFromYourGamesSeoSection />
    </>
  );
}
