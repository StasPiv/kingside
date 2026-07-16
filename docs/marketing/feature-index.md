# Kingside — индекс фич (для ответов в соцсетях)

Компактный источник истины: что есть на сайте, URL, где детали (ADR).
Держи в памяти. Совпал вопрос человека с фичей — при необходимости дочитай
её ADR. Нет в списке — фичи нет (ответ «планируем»). Статус проверяй, если
сомневаешься; помечай `?` где не уверен — не выдавай за готовое.

Формат: **фича** — что делает — `URL` — ADR.

## Игра
- **Play vs bot / online** — партии с ботом (Stockfish 18 WASM, локально) и онлайн — `/play`, `/lobby` — ADR-005,134
- **Турниры (arena)** — `/tournaments`, `/arena` — —
- **Трансляции** — live-турниры с доски lichess/chess-results — `/broadcasts` — ADR-021,110,159

## Анализ
- **Analysis board** — разбор партий, Stockfish + Maia, NAG-аннотации — `/analysis` — ADR-008,100,164
- **Analyze PGN online** — вставить PGN, получить анализ — `/analyze-pgn-online` — —
- **Archive** — база мастерских партий, поиск по позиции, дерево дебютов — `/archive` — ADR-013,014,033
- **Positional metrics** — динамика позиционных факторов по ходам — (в /analysis) — ADR-107,122
- **AI-комментарии ходов** — ЧАСТИЧНО, не рекламировать как готовое — (в `/analysis`, отдельного URL нет) — ADR-102,103,108

## Тренировка
- **Puzzles** — тактика — `/puzzles`, `/daily`, `/puzzle-rush` — —
- **Puzzles from your games** — пазлы из своих зевков (PGN → задачи) — `/puzzles-from-your-games` — ADR-041,044,050
- **Precision training** — держать перевес против движка, 5-звёзд оценка — `/precision` — ADR-048,065,079
- **Opening Trainer** — тренировка дебютов из своего/системного PGN — `/opening-trainer` — ADR-077,078,084
- **Tactical drills** — микро-упражнения на паттерны, sprint+лидерборд — `/drills` — ADR-035,043
- **Guess the Move** — угадать ход мастера, сравнение точности — `/guess` — ADR-086,089
- **Blind-board** — визуализация: найти фигуру по ходу движка — `/blind-board` — ADR-088
- **Workshop** — работа с PGN-файлами — `/workshop` — ADR-011

## Обучение
- **User courses** — свои курсы: редактор, шаги, пазлы, прогресс — `/lessons/my`, каталог `/lessons/discover` — ADR-026,029,049; docs/features/user-courses.md
- **Lessons (system)** — системные уроки, SM-2 повторение — `/lessons` — ADR-024,025; docs/user/drills.md
- **Mistakes diary** — тренировка своих ошибок — `/puzzles/mistakes` — ADR-032
- **Coach page + lectures** — тренер: курсы, лекции live/запись, голос — `/coach/:username` — ADR-113,115,118,120

## Прочее
- **Players / профили / рейтинги** (bullet/blitz/rapid/classical/puzzle) — `/players` — —
- **Contextual hints** — подсказки по действиям пользователя — — ADR-147,148
- **Feedback** — `/feedback` — —

Позиционирование (из docs/marketing/youtube-intro): free, no ads, движок в
браузере, соло-разработка в открытую. Конкурентов не ругаем.
