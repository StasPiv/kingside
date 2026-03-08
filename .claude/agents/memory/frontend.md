# Frontend Agent Memory

## Выполненные задачи

### KS-123: Фигура увеличивается при перетаскивании на доске
- Причина: react-chessboard v5.10.0 по умолчанию применяет `transform: scale(1.2)` к перетаскиваемой фигуре (defaultDraggingPieceStyle)
- Исправление: добавлен проп `draggingPieceStyle: { transform: 'scale(1)' }` в `GamePage.tsx`
- Ветка: `feature/KS-123`, коммит: `5c4252f`
- Примечание: аналогичный проп не добавлен в `AnalysisPage.tsx`, т.к. там доска только для просмотра (нет drag-and-drop)

### KS-128: Расширенный выбор и создание произвольных временных контролей
- Расширенный список пресетов (13 шт) с группировкой по категориям через табы (Bullet/Blitz/Rapid/Classical)
- Вкладка "Свои": форма создания пользовательского контроля, сохранение/удаление через API
- i18n: установлены i18next + react-i18next, созданы файлы переводов en/ru
- Добавлен метод `delete` в `api.ts`
- Ветка: `feature/KS-128`, коммит: `aa02622`, PR: #3
- Зависимость: API эндпоинты /time-controls/custom зависят от KS-127 (пока могут быть недоступны)
- Проблема при разработке: другие агенты переключают ветки в том же worktree, что приводит к потере незакоммиченных изменений

## Заметки по архитектуре
- Проект: monorepo (apps/web, apps/api, packages/shared)
- Шахматная доска: react-chessboard v5.10.0 с props через `options`
- Стили: единый файл `apps/web/src/styles.css`
- Страницы с доской: `GamePage.tsx` (игра), `AnalysisPage.tsx` (анализ)
- i18n: i18next + react-i18next + i18next-browser-languagedetector, fallback: ru
- Ветки создаются от `main` (по CONTRIBUTING.md)
