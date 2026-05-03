# QA — Drills MVP (Drills E3)

KS-2239 (ADR-035 §11). Документ описывает acceptance-сценарии для Drill mode MVP, реализованного в задачах KS-2231..KS-2238. E2E-проверки автоматизированы в `apps/web/tests/e2e/drills-mvp.spec.ts`; этот файл — карта тест-кейсов с шагами и ожиданиями для ручного прогона/разбора отчётов.

## 1. Контекст

- **8 drill-типов** (methodology §2.1): `count-attackers`, `find-loose-piece`, `find-hanging-piece`, `find-all-checks`, `find-pin`, `find-fork`, `find-mate-in-one-square`, `find-undefended-attack`.
- **4 answer-shape** (KS-2224, ADR §5.3): `square` / `squares` / `number` / `move`.
- **Feature-flag**: `drillsEnabled` (KS-2231). Default `false` — фича в разработке. Включается админом через `PATCH /admin/feature-flags/drillsEnabled`.

## 2. Окружение прогона

- Frontend: `npm run dev` в `apps/web` (vite на `:5173`).
- Backend: `npm run dev` в `apps/api` (NestJS на `:3001`).
- E2E: `/project/node_modules/.bin/playwright test` в `apps/web/`.
- На проде `drillsEnabled=false` и admin-API закрыт (`Admin access disabled` 403). Spec мокает `/config` и `/tactic-drill/*` через `page.route` — UI-flow проверяется без зависимости от данных в БД. После раскатки реального индекса admin может оставить только мок `/config` (или включить флаг через прямой UPDATE в `feature_flags`), и spec прогонит на настоящих drill'ах — assertion'ы не привязаны к конкретным позициям.

## 3. Тест-кейсы

### TC-1. Feature-flag off → /drills редирект

- **Pre**: `drillsEnabled=false`.
- **Steps**: открыть `/drills`.
- **Expected**: редирект на `/lobby`. Sidebar не показывает иконку 🎯.

### TC-2. Feature-flag on → лобби открывается

- **Pre**: `drillsEnabled=true`, JWT валидный.
- **Steps**: открыть `/drills`.
- **Expected**:
  - Заголовок «Выберите упражнение» (i18n `drills.lobbyHeading`).
  - 3 секции layer (`overview`, `pattern`, `calculation`) — каждая с `data-testid="drills-lobby-layer-<layer>"`.
  - 8 карточек `data-testid="drill-type-card"` распределены по слоям: 3 / 3 / 2 (count + loose + hanging / all-checks + pin + fork / mate-in-one + undefended-attack).
  - Заблокированные типы (`unlocked=false`) — `disabled` + бейдж «Закрыт».

### TC-3..TC-10. Happy-path для каждого drill-типа

Для каждого `<type>` из 8:

- **Pre**: `drillsEnabled=true`, фикстурный drill отдан `/tactic-drill/next?type=<type>`.
- **Steps**: открыть `/drills/<type>`; ввести правильный ответ согласно `answerShape`:

| Type | Shape | Действие |
|---|---|---|
| `count-attackers` | `number` | Tap по кнопке 1..4 |
| `find-loose-piece` | `square` | Click по клетке |
| `find-hanging-piece` | `square` | Click по клетке |
| `find-all-checks` | `squares` | Click N клеток + кнопка «Ответить» |
| `find-pin` | `square` | Click по клетке |
| `find-fork` | `square` | Click по клетке |
| `find-mate-in-one-square` | `square` | Click по клетке |
| `find-undefended-attack` | `move` | Click from → click to |

- **Expected**: `data-state="feedback"`, `DrillFeedbackOverlay` с `data-result="correct"`, кнопка «Следующее» (`drill-page-next`) видна, прогресс инкрементировался (`solved=1/attempted=1`).

### TC-11. Feedback overlay correct (зелёная)

- **Pre**: `drillsEnabled=true`, drill `count-attackers`, `correctAnswer.value=2`.
- **Steps**: ответить 2.
- **Expected**: `[data-testid="drill-feedback"][data-result="correct"]`. Visual: зелёный overlay поверх доски (CSS-задача KS-DRILL-CSS).

### TC-12. Feedback overlay incorrect (красная)

- **Pre**: тот же drill, что TC-11.
- **Steps**: ответить 4 (неверно).
- **Expected**: `[data-result="incorrect"]`. Visual: красный overlay, инструкция меняет тон на `error`.

### TC-13. Mobile portrait — touch happy-path

- **Pre**: viewport 390×844, `hasTouch=true`, `isMobile=true`. `drillsEnabled=true`.
- **Steps**: открыть `/drills/count-attackers`, tap по кнопке 2.
- **Expected**: feedback `correct`. Drag-and-drop на доске НЕ требуется (drill'ы кликовые).

### TC-14. Mobile portrait — Next-кнопка переходит к следующему drill

- **Steps**: после TC-13 нажать `drill-page-next`.
- **Expected**: вернулся в `data-state="idle"`, новый запрос `/tactic-drill/next?type=count-attackers` отправлен, прогресс не сбросился.

### TC-15. DrillStatsPanel в профиле обновляется после прохождения

- **Pre**: `drillsEnabled=true`, начальные stats: 0 attempts / 0 unlocked.
- **Steps**:
  1. Открыть `/drills/count-attackers`, ответить правильно.
  2. Перейти на `/player/DEV` (свой профиль).
- **Expected**: на странице профиля видна секция `drill-stats-panel`, `state="loaded"`. Total: `attempts=1`, `solved=1`, `accuracy=100%`. Бейдж типа `count-attackers` — «Открыт». Остальные типы — «Закрыт» с нулями в ячейках.

### TC-16. DrillStatsPanel НЕ показывается на чужом профиле

- **Pre**: `drillsEnabled=true`, текущий юзер DEV.
- **Steps**: открыть `/player/SomeOtherUser` (или любой профиль ≠ свой).
- **Expected**: секция `drill-stats-panel` отсутствует. Endpoint `/stats/me` НЕ вызывается.

### TC-17. DrillStatsPanel НЕ показывается при drillsEnabled=false

- **Pre**: `drillsEnabled=false`.
- **Steps**: открыть свой профиль.
- **Expected**: секции `drill-stats-panel` нет. Sidebar/MobileBar также не показывают пункт «Тренажёры».

### TC-18. Невалидный type в URL → редирект на лобби

- **Pre**: `drillsEnabled=true`.
- **Steps**: открыть `/drills/totally-not-a-type`.
- **Expected**: редирект на `/drills`. Запрос `/tactic-drill/next?type=...` НЕ отправляется.

### TC-19. Сетевая ошибка `/tactic-drill/next` → error-state с retry

- **Pre**: бэк отдаёт 500 на `/next`.
- **Steps**: открыть `/drills/find-pin`.
- **Expected**: `data-state="error"`, кнопка `drill-page-retry`. Click по retry → новый запрос `/next`.

### TC-20. Hotkey 1..4 для shape='number' — работает с клавиатуры

- **Pre**: `drillsEnabled=true`, drill `count-attackers`.
- **Steps**: с клавиатуры нажать `2`.
- **Expected**: submit `{shape:'number', value:2}` без клика мышью. Hotkey игнорируется в input/textarea.

## 4. Покрытие e2e-spec'ом

Файл `apps/web/tests/e2e/drills-mvp.spec.ts` автоматизирует TC-1, TC-2, TC-3..TC-10 (по одному `test()` на каждый из 8 типов через `for…of`), TC-11, TC-12, TC-13, TC-14, TC-15. Остальные TC (16, 17, 18, 19, 20) частично перекрыты unit-тестами:
- TC-16 / TC-17 — `PlayerProfilePage.test.tsx` (если есть) и условие `drillsEnabled && currentUser.id === profile.id` в коде.
- TC-18 / TC-19 / TC-20 — `DrillPage.test.tsx`, `DrillCountAttackersButtons.test.tsx`.

Если в дальнейшем понадобится поднять до полного e2e — добавлять кейсы в тот же файл `drills-mvp.spec.ts`.

## 5. Известные ограничения

1. **Заглушка `/config`**: на проде `drillsEnabled=false` + admin закрыт. До разблокировки admin-API e2e гарантированно проходит ТОЛЬКО с моком. На stage/dev окружении после ручного `UPDATE feature_flags SET value='true' WHERE key='drillsEnabled'` мок можно убрать, и spec прогонит без подмены `/config`.
2. **Заглушка `/tactic-drill/*`**: пока `KS-DRILL-INDEX` не выполнен на этом окружении (БД пуста, `/next` отдаёт 404 «no drills available»). После наполнения БД мок `/next` и `/attempt` можно убрать — assertion'ы не привязаны к конкретным позициям.
3. **`clickSquare()`**: ищет клетку через `[data-square=…]` или `[aria-label=…]` — селектор зависит от версии `react-chessboard`. Если library в будущем поменяет DOM-структуру — обновить helper.
4. **Visual-регрессии CSS** (overlay-цвета, layout) не покрыты — требуется отдельный visual-screenshot pipeline (KS-DRILL-CSS у layout-агента).

## 6. Связанные задачи

- KS-2231 — feature-flag (backend/shared).
- KS-2232 — DrillsLobbyPage.
- KS-2233 — DrillPage с 4 answer-shape.
- KS-2234 — переиспользуемые компоненты (DrillBoard / DrillInstructions / DrillFeedbackOverlay / DrillCountAttackersButtons / DrillTypeCard).
- KS-2235 — Sidebar/MobileBar пункт.
- KS-2236 — DrillStatsPanel в профиле.
- KS-2238 — i18n RU/EN.
- KS-DRILL-CSS — layout-стили (отдельная задача layout-агента).
- KS-DRILL-INDEX — генерация позиций в БД (backend).
