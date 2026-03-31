# KS-1135: Отдельная страница игрового зала (Play)

## 1. Текущее состояние

### LobbyPage (`/lobby`)
Сейчас `/lobby` — это **главная страница-витрина** с 8 тизерами:
1. Human (онлайн) → модаль с выбором TC + рейтинг-фильтром
2. Bot → модаль с уровнем/цветом/TC
3. Puzzles → переход на `/puzzles`
4. Puzzle Rush → модаль со статистикой + ссылка
5. Workshop → модаль с PGN/недавними партиями
6. Broadcasts → переход на `/broadcasts`
7. Players → переход на `/players`
8. Live Games → переход на `/games/live`

Проблема: LobbyPage совмещает роль **главной страницы** (навигация по разделам) и **игрового зала** (matchmaking + бот). При клике на Play в сайдбаре пользователь ожидает попасть в игровой зал, а видит витрину всех разделов.

### Что уже реализовано
- Matchmaking: `useMatchmaking()` — WebSocket поиск, рейтинг-фильтры (relative/absolute)
- Time controls: `useTimeControl()` — пресеты (bullet/blitz/rapid/classical), custom, сохранённые
- Bot: `useBotGame()` — Stockfish L1-20, выбор цвета, выбор TC
- Challenge: `useChallenge()` — вызов друга, accept/decline через WebSocket, `ChallengeModal`

## 2. Архитектурное решение

### Разделение на две страницы

| Страница | URL | Назначение |
|----------|-----|-----------|
| **PlayPage** (новая) | `/play` | Игровой зал — всё для начала игры |
| **LobbyPage** (существующая) | `/lobby` | Главная — навигация по разделам |

### Sidebar
- Кнопка Play (♟) → `/play` (вместо `/lobby`)
- Добавить кнопку Home (🏠) → `/lobby` первой в списке

### Роутинг
```
/play       → PlayPage (ProtectedRoute)
/lobby      → LobbyPage (как есть, без тизеров Human и Bot)
```

## 3. Дизайн PlayPage

### Референсы
- **lichess.org**: центральная панель с пресетами TC (сетка кнопок), справа — список текущих партий/событий
- **chess.com**: крупная кнопка Play по центру, выбор TC ниже

### Layout (desktop)

```
┌────────────────────────────────────────────────┐
│                   PlayPage                      │
├─────────────────────┬──────────────────────────┤
│   QUICK PLAY        │   PLAY A FRIEND          │
│                     │                          │
│   ┌───┬───┬───┐     │   Список друзей онлайн   │
│   │1+0│2+1│3+0│     │   [username] [♟ Invite]  │
│   ├───┼───┼───┤     │   [username] [♟ Invite]  │
│   │3+2│5+0│5+3│     │   ...                    │
│   ├───┼───┼───┤     │                          │
│   │10 │15 │30 │     ├──────────────────────────┤
│   └───┴───┴───┘     │   PLAY VS BOT            │
│                     │                          │
│   [Custom ▼]        │   Level: ●───────── 10   │
│                     │   Color: ♔  ♚  ⚄         │
│   Rating filter ▼   │   [Play Bot]             │
│                     │                          │
│   [▶ PLAY]          │                          │
└─────────────────────┴──────────────────────────┘
```

### Левая колонка: Quick Play (matchmaking)

**Содержимое — то же, что сейчас в `onlineModalContent`, но без модали:**
- Табы категорий: Bullet | Blitz | Rapid | Classical | Custom
- Сетка пресетов TC (кнопки)
- Custom TC: сохранённые + форма создания
- Информация о выбранном TC
- Rating filter (toggle → relative/absolute)
- Кнопка PLAY (большая, центральная)
- Статус поиска (searching...)

Весь код уже есть в `LobbyPage.tsx` (строки 118-351) — нужно перенести.

### Правая колонка: дополнительные режимы

#### Секция "Play a Friend"
- Список друзей онлайн (из существующего friends API: `GET /api/friends/online`)
- Кнопка Invite рядом с каждым другом → открывает `ChallengeModal`
- Если друзей нет — текст "No friends online" + ссылка на `/friends`

#### Секция "Play vs Bot"
- Слайдер уровня (1-20)
- Выбор цвета (White / Black / Random)
- Кнопка Play Bot → выбор TC → запуск

Весь код бота уже есть в `LobbyPage.tsx` (строки 353-401).

### Мобильная версия
На мобиле — одна колонка:
1. Quick Play (пресеты + кнопка PLAY)
2. Play a Friend (свёрнуто по умолчанию)
3. Play vs Bot (свёрнуто по умолчанию)

## 4. Изменения в LobbyPage

Из текущего LobbyPage **убрать**:
- Тизер Human (переехал на PlayPage)
- Тизер Bot (переехал на PlayPage)
- Весь код `onlineModalContent`, `botModalContent`, `showBotTCModal`
- Хуки `useMatchmaking()`, `useBotGame()`, `useTimeControl()`

**Оставить** тизеры: Puzzles, Puzzle Rush, Workshop, Broadcasts, Players, Live Games.

LobbyPage становится чистой витриной разделов без игровой функциональности.

## 5. Данные и API

### Новые API — не нужны
Все данные для PlayPage уже доступны:
- Matchmaking → WebSocket `/matchmaking`
- Bot → `POST /api/games/bot`
- Friends online → `GET /api/friends/online` (уже существует)
- Challenge → WebSocket `/messages` (ChallengeEvents)

### Хуки — переиспользуем
- `useTimeControl()` — без изменений
- `useMatchmaking()` — без изменений
- `useBotGame()` — без изменений
- `useChallenge()` — без изменений

## 6. Разбивка на задачи

### Задача 1: Frontend — создать PlayPage
**Исполнитель**: frontend
**Объём**: средний

- Создать `apps/web/src/pages/PlayPage.tsx`
- Перенести из LobbyPage: `onlineModalContent` (как встроенную секцию, не модаль), `botModalContent`, `showBotTCModal`
- Добавить секцию "Play a Friend": список онлайн друзей + кнопка Invite
- Зарегистрировать маршрут `/play` в `App.tsx`
- Обновить Sidebar: Play (♟) → `/play`
- Добавить Home (🏠) → `/lobby` в Sidebar первым элементом
- Обновить MobileBottomBar аналогично

### Задача 2: Frontend — упростить LobbyPage
**Исполнитель**: frontend
**Объём**: малый

- Убрать тизеры Human и Bot из `teasers[]`
- Убрать `modalContentMap` для human и bot
- Убрать хуки `useMatchmaking`, `useBotGame`, `useTimeControl`
- Убрать весь код `onlineModalContent`, `botModalContent`, `showBotTCModal`

### Задача 3: Layout — стилизация PlayPage
**Исполнитель**: layout
**Объём**: средний

- Двухколоночный layout для desktop (≥1024px)
- Одна колонка для мобиле (< 1024px), секции Friend/Bot свёрнуты
- Стилизация сетки пресетов TC (крупнее чем в модали — это основная страница)
- Кнопка PLAY — крупная, акцентная
- Секции Friend/Bot — карточки с заголовками
- Адаптив и hover-эффекты

### Порядок
1. Задача 1 (PlayPage) — первая
2. Задача 2 (упрощение LobbyPage) — параллельно с задачей 1
3. Задача 3 (стилизация) — после задачи 1

## 7. Затронутые файлы

| Файл | Изменение |
|------|-----------|
| `apps/web/src/pages/PlayPage.tsx` | **Новый** — страница игрового зала |
| `apps/web/src/pages/LobbyPage.tsx` | Убрать Human/Bot тизеры и связанный код |
| `apps/web/src/App.tsx` | Добавить маршрут `/play` |
| `apps/web/src/components/Sidebar.tsx` | Play → `/play`, добавить Home → `/lobby` |
| `apps/web/src/components/MobileBottomBar.tsx` | Аналогичные изменения |
| `apps/web/src/styles/play.css` | **Новый** — стили PlayPage |
| `apps/web/src/styles/lobby.css` | Убрать неиспользуемые стили модалей |

## 8. Что НЕ входит в scope

- Перенос Puzzles/Workshop/Broadcasts тизеров — остаются на LobbyPage
- Изменения в backend — не нужны
- Новые WebSocket события — не нужны
- Рефакторинг хуков matchmaking/bot/challenge — переиспользуем как есть
