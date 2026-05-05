import { Routes, Route, Navigate } from 'react-router-dom';

import { DevPositionStepPage } from '../pages/DevPositionStepPage';
import { DevVideoStepPage } from '../pages/DevVideoStepPage';
// KS-2434: dev-sandbox разбора партии удалён вместе с серверным анализом.
import { DevReviewsUiPage } from '../pages/DevReviewsUiPage';
import { DevEndgameDrillStepPage } from '../pages/DevEndgameDrillStepPage';
import { DevOpeningDrillStepPage } from '../pages/DevOpeningDrillStepPage';
import { DevPlayoffBracketPage } from '../pages/DevPlayoffBracketPage';
import { DevNagPalettePage } from '../pages/DevNagPalettePage';

/**
 * Suspense-child: контейнер dev-страниц `/dev/*` (KS-1820 / KS-1821).
 *
 * Отдельный модуль, чтобы весь этот набор импортов и компонентов попадал
 * в чанк, который App.tsx подгружает через `lazy(() => import('./dev/DevRoutes'))`.
 * В prod-сборке (`import.meta.env.DEV === false`) вызов `lazy()` заменяется
 * на `null` ещё до rollup'а → `import()` никогда не сгенерируется, и
 * весь этот модуль с транзитивными dev-страницами уйдёт tree-shake'ом.
 *
 * Внутри — вложенный `<Routes>`, т.к. в App.tsx для dev используется
 * единственный родительский маршрут `/dev/*` (React Router v7 требует,
 * чтобы все ветви маршрутов были статически видны внутри `<Routes>`,
 * и sub-router — штатный способ разделить поддерево).
 */
export default function DevRoutes() {
  return (
    <Routes>
      <Route path="position-step" element={<DevPositionStepPage />} />
      <Route path="video-step" element={<DevVideoStepPage />} />
      {/* KS-2434: /dev/game-review-step удалён — серверный анализ
          больше не существует (см. KS-2433). */}
      <Route path="reviews-ui" element={<DevReviewsUiPage />} />
      <Route path="endgame-drill" element={<DevEndgameDrillStepPage />} />
      <Route path="opening-drill" element={<DevOpeningDrillStepPage />} />
      <Route path="playoff-bracket" element={<DevPlayoffBracketPage />} />
      {/* KS-2269 / KS-2270: demo для NagPalette + NagPaletteSheet. */}
      <Route path="nag-palette" element={<DevNagPalettePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
