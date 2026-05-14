import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';

/**
 * KS-2890 / ADR-060 §3.5 (FC5). Юнит-тесты StudyEmbedPage:
 *  - страница рендерится без Sidebar/Header сайта (это покрыто
 *    отдельным роутом ВНЕ MainLayout; тут проверяем что markup сам по
 *    себе минимален: только board-area + footer);
 *  - footer-link ведёт на `/studies/:studyId` с target="_blank";
 *  - `?theme=brown` ставит `data-board-theme="brown"` на body;
 *  - невалидный `?theme=junk` оставляет body без изменений.
 */

// Мокаем AnalysisPage — тяжёлый компонент тянет socket/engine/pgn, в
// embed-тесте важна только обёртка StudyEmbedPage.
vi.mock('./AnalysisPage', () => ({
  AnalysisPage: ({ studyMode }: { studyMode?: string }) => (
    <div data-testid="analysis-page-mock" data-study-mode={studyMode ?? ''}>
      mock AnalysisPage
    </div>
  ),
}));

const params: { studyId: string; chapterId: string } = {
  studyId: 'study-abc',
  chapterId: 'chapter-xyz',
};
const queryRef = { current: new URLSearchParams() };
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return {
    ...actual,
    useParams: () => params,
    useSearchParams: () =>
      [queryRef.current, vi.fn()] as const,
  };
});

import { StudyEmbedPage } from './StudyEmbedPage';

beforeEach(() => {
  params.studyId = 'study-abc';
  params.chapterId = 'chapter-xyz';
  queryRef.current = new URLSearchParams();
  document.body.removeAttribute('data-board-theme');
  // BoardSettingsProvider читает тему из localStorage — между тестами
  // её нужно сбрасывать, иначе предыдущий `selectTheme('green')` утечёт.
  localStorage.clear();
});

describe('StudyEmbedPage (KS-2890 FC5)', () => {
  it('рендерит AnalysisPage в studyMode="embed" + минимальный footer', () => {
    renderWithProviders(<StudyEmbedPage />);
    const page = screen.getByTestId('study-embed-page');
    expect(page.getAttribute('data-study-id')).toBe('study-abc');
    expect(page.getAttribute('data-chapter-id')).toBe('chapter-xyz');
    const inner = screen.getByTestId('analysis-page-mock');
    expect(inner.getAttribute('data-study-mode')).toBe('embed');
    // Footer обязательно есть.
    expect(screen.getByTestId('study-embed-footer')).toBeInTheDocument();
  });

  it('footer-link ведёт на /studies/:studyId с target="_blank" + rel noopener', () => {
    renderWithProviders(<StudyEmbedPage />);
    const link = screen.getByTestId(
      'study-embed-footer-link',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/studies/study-abc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toBe('Powered by Kingside');
  });

  it('?theme=brown → body[data-board-theme="brown"]', () => {
    queryRef.current = new URLSearchParams('theme=brown');
    renderWithProviders(<StudyEmbedPage />);
    expect(document.body.getAttribute('data-board-theme')).toBe('brown');
  });

  it('?theme=blue/green валидные', () => {
    queryRef.current = new URLSearchParams('theme=blue');
    renderWithProviders(<StudyEmbedPage />);
    expect(document.body.getAttribute('data-board-theme')).toBe('blue');
    cleanup();

    queryRef.current = new URLSearchParams('theme=green');
    renderWithProviders(<StudyEmbedPage />);
    expect(document.body.getAttribute('data-board-theme')).toBe('green');
  });

  it('?theme=junk → атрибут body не изменяется', () => {
    queryRef.current = new URLSearchParams('theme=garbage');
    renderWithProviders(<StudyEmbedPage />);
    // BoardSettingsProvider в test-utils выставляет 'default' через
    // свой useEffect. Главное — embed не подменяет body на «garbage».
    const attr = document.body.getAttribute('data-board-theme');
    expect(attr === null || attr === 'default').toBe(true);
  });

  it('без studyId → footer-link ведёт на корень', () => {
    params.studyId = '';
    renderWithProviders(<StudyEmbedPage />);
    const link = screen.getByTestId(
      'study-embed-footer-link',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/');
  });
});
