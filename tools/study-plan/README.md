# study-plan — данные для генератора занятий (KS-4885, ADR-160 §2.2)

Конфиг и тексты для генератора занятий (ADR-160, задача 6/6). Интеграцию в
генератор делает backend (задача 2), тексты диспетчера уведомлений — задача 3,
тексты страницы `/study` — задача 4.

## Файлы

| Файл | Что внутри | Потребитель |
|---|---|---|
| `rating-shelves.json` | Полки рейтинга → курс, доля теории/практики, приоритетные темы, ротация практики, focus-оверрайды | backend: генератор занятий |
| `texts.en.json` / `texts.ru.json` | Тексты уведомлений (`study.notification.*`) и страницы занятия (`study.page.*`) | backend: диспетчер; frontend: страница `/study` |

## rating-shelves.json

- **Полка** выбирается по `User.ratingPuzzle`: `minRating <= r < maxRating`
  (`maxRating: null` — без верхней границы). Диапазоны без дыр: 0…1200…1500…1800…2100…∞.
- **`uncalibrated`**: у нового пользователя Glicko-рейтинг 1500 при deviation 350 —
  число не показательно. Пока `ratingPuzzleDev > ratingDeviationThreshold` (150),
  генератор берёт полку `fallbackShelf` (`beginner`), а не полку по числу.
- **`courseSlug`** — системный курс полки для блока «Теория: следующий урок»
  (когда нет активного курса). Существующие системные курсы:
  `capablanca-primer` (beginner), `capablanca-fundamentals` (beginner),
  `dvoretsky-endgame-manual` (advanced). Если курс полки не найден или пройден —
  идти по `courseFallbackSlugs` по порядку.
- **`theoryShare` / `practiceShare`** — доли бюджета `sessionMinutes` между
  теорией (SM-2 + урок) и практикой (тактика + практический блок). Сумма = 1.
- **`priorityThemes`** — темы пазлов для блока «Тактика», когда у ученика нет
  статистики слабых тем (< 10 попыток в `stats/themes`). Ключи = темы lichess,
  как в `puzzleBrowser.themes.*` i18n фронтенда. Порядок = приоритет.
- **`puzzleRatingWindow`** — стартовое окно подборки пазлов относительно
  `ratingPuzzle` (`below`/`above` — насколько ниже/выше). Дальше окно двигает
  адаптация §2.3 ADR-160.
- **`practiceRotation`** — какие типы практики (значения `StudyTask.type`)
  допустимы на полке и в каком порядке ротировать. У новичков нет precision и
  разбора партий — сначала база; у сильных практика начинается с precision и
  рейтинговых партий с разбором.
- **`focusOverrides`** — коррекция полки полем `StudySchedule.focus`:
  `priorityThemesPrepend` — темы, вставляемые в начало списка;
  `theoryShareDelta` — сдвиг доли теории (клампить в [0.2, 0.7]);
  `courseSlug` — замена курса полки; `practiceRotationPrepend` — типы практики
  в начало ротации. `balanced` — без изменений.

## texts.*.json

Формат — вложенный JSON, плейсхолдеры в стиле i18next `{{var}}`. Ключи en и ru
зеркальны (одинаковое дерево).

- `study.notification.*` — шаблоны для диспетчера (Telegram + onsite):
  `title`, `intro` (`{{taskCount}}`, `{{minutes}}`), строки заданий
  `taskLine.<StudyTask.type>` (плейсхолдеры: `count`, `theme`, `lessonTitle`,
  `timeControl`, `target`, `provider`), `openSession` (`{{url}}`).
  `{{theme}}` — уже переведённое название темы из `puzzleBrowser.themes.<key>`.
- `study.page.*` — страница занятия `/study`: заголовки, статусы занятия и
  задач, названия блоков §2.2, короткие названия задач, блок «почему эти
  задания» (`profile_snapshot`), состояния completed/partiallyDone/expired,
  пустые состояния (нет расписания / нет занятия).

Deep-link'и заданий формирует backend (ADR-160 §4): `/puzzles?themes=...`,
`/lessons/:course/:lesson` и т. д. — в текстах их нет.
