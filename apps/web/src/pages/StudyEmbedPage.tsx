import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { AnalysisPage } from './AnalysisPage';
import {
  useBoardSettings,
  type BoardThemeId,
} from '../hooks/useBoardSettings';

/**
 * KS-2890 / ADR-060 §3.5 (FC5) — embed-страница студии для iframe.
 *
 * Маршрут: `/study/embed/:studyId/:chapterId?theme=brown|blue|green`.
 *
 * Особенности:
 *  • роут рендерится ВНЕ `MainLayout` → нет Sidebar/Header сайта;
 *  • композиция — `<AnalysisPage studyMode="embed">` (тот же engine,
 *    что у public-readonly главы) + минимальный footer «Powered by
 *    Kingside» с ссылкой на родительскую студию (`target="_blank"`);
 *  • `?theme=` переключает board-theme через body[data-board-theme]
 *    локально, БЕЗ записи в localStorage. Если параметр пустой/мусор —
 *    оставляем тему пользователя из BoardSettingsContext;
 *  • iframe-embedability обеспечена D1 (nginx X-Frame-Options).
 */

const ALLOWED_THEMES: ReadonlySet<BoardThemeId> = new Set<BoardThemeId>([
  'default',
  'green',
  'blue',
  'brown',
]);

function isAllowedTheme(value: string | null): value is BoardThemeId {
  return value !== null && ALLOWED_THEMES.has(value as BoardThemeId);
}

export function StudyEmbedPage() {
  const { studyId, chapterId } = useParams<{
    studyId: string;
    chapterId: string;
  }>();
  const [searchParams] = useSearchParams();
  const themeParam = searchParams.get('theme');
  const themeOverride: BoardThemeId | null = isAllowedTheme(themeParam)
    ? themeParam
    : null;

  // KS-2890: применяем тему через `selectTheme` из BoardSettingsContext.
  // Контекст сам обновляет `body[data-board-theme]` через свой
  // useEffect — иначе наш inline-override был бы перезаписан
  // родительским useEffect провайдера (children-first order).
  // Запись в localStorage внутри iframe — это уже изолированный
  // domain-storage, юзер-настройки на родительском сайте не
  // затрагиваются.
  const { selectTheme } = useBoardSettings();
  useEffect(() => {
    if (!themeOverride) return;
    selectTheme(themeOverride);
  }, [themeOverride, selectTheme]);

  // Минимальный layout-маркер для embed-страницы — на корне ставим
  // класс `.study-embed-page`, чтобы L4 (отдельная задача) мог
  // притушить декорации сайта (стиль hr, scrollbar и т.п.) без CSS,
  // дёргающего весь дизайн.
  return (
    <div
      className="study-embed-page"
      data-testid="study-embed-page"
      data-study-id={studyId}
      data-chapter-id={chapterId}
      data-theme={themeOverride ?? ''}
    >
      <div className="study-embed-page__board">
        <AnalysisPage studyMode="embed" />
      </div>

      <footer
        className="study-embed-page__footer"
        data-testid="study-embed-footer"
      >
        <a
          href={studyId ? `/studies/${encodeURIComponent(studyId)}` : '/'}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="study-embed-footer-link"
        >
          Powered by Kingside
        </a>
      </footer>
    </div>
  );
}
