# @kingside/pdf-to-lesson-yaml

CLI и API для конвертации PDF-учебников в черновые YAML-файлы
lesson-формата (KS-2015). **KS-2045 Этап 1.**

## Назначение

Архитектор тратит несколько часов на ручную сборку каждой главы
учебника (PDF → структура шагов → дословный текст + FEN всех диаграмм).
Конвертер делает черновик автоматически, дальше — ручная правка.

ADR — `docs/architecture/KS-2044-pdf-to-yaml-converter.md`. Подход
**Semi-auto** (вариант B), 5 этапов. Этот пакет реализует **Этап 1**:
text-шаги с inline-диаграммами Chess-Merida.

Не реализовано на Этапе 1 (откладывается):

- PGN-партии → game_review (Этап 2). Последовательности ходов
  остаются в `bodyMarkdown` как обычная проза.
- Long-algebraic → SAN (Этап 2).
- Puzzle/quiz (Этап 3).
- Растровые PDF / Майзелис / другие chess-шрифты (Этап 4).

## Установка

Workspace-пакет внутри монорепы. Зависимости:

- **Python 3** + **PyMuPDF** (`fitz`) — для парсинга PDF;
- `@kingside/board-image-to-fen` (PDF-путь, KS-2030) — для распознавания
  диаграмм Chess-Merida.

```sh
npx --prefix /project tsc --build packages/pdf-to-lesson-yaml
```

## Использование (CLI)

```sh
# Полный пайплайн: PDF + конфиг → набор YAML.
pdf-to-lesson-yaml <input.pdf> \
  --config converter.yml \
  --output /tmp/courses/<slug>/

# Перезаписать существующие файлы.
pdf-to-lesson-yaml <input.pdf> --config converter.yml \
  --output /tmp/courses/<slug>/ --overwrite

# Ad-hoc: одна глава по диапазону страниц (без конфига).
pdf-to-lesson-yaml <input.pdf> \
  --page-range 14-22 \
  --slug ch1-game-pieces-moves-goal \
  --course-slug capablanca-primer \
  --output /tmp/courses/capablanca-primer/

# Эмит промежуточного AST (для отладки).
pdf-to-lesson-yaml <input.pdf> --page-range 14-22 \
  --slug ch1 --course-slug cap --output /tmp/draft/ \
  --emit-ast /tmp/ast.json
```

CLI пишет в stdout пути созданных файлов с метриками (число шагов,
число диаграмм). В stderr — отчёт AJV-валидации по `lesson.schema.json`.

## Конфиг (`converter.yml`)

```yaml
course:
  slug: capablanca-primer
  level: beginner
  difficulty: 1
  estimatedMinutes: 240
  titleKey: lessons.capablanca-primer.title
  descriptionKey: lessons.capablanca-primer.description
  title: Учебник Капабланки
  isPublished: false
  tags: [fundamentals, rules, capablanca]
  blockOrder:
    - rules
    - basic-mates
    - basic-endgames
    - pawn-endgames
    - piece-values

source:
  language: ru

chapters:
  - title: 'Глава 1. Игра, фигуры, их ходы, цель игры'
    slug: ch1-game-pieces-moves-goal
    pageRange: [14, 22]
    blockKey: rules
    kind: theory
    order: 0
    estMinutes: 40
    titleKey: lessons.capablanca-primer.ch1.l1.title
    summaryKey: lessons.capablanca-primer.ch1.l1.summary
    isPublished: false
  - title: '§1. Простые маты'
    slug: chapter-2-p1-simple-mates
    pageRange: [24, 29]
    blockKey: basic-mates
    kind: endgame_set
    order: 1
    estMinutes: 25
    titleKey: lessons.capablanca-primer.ch2.p1.title
    summaryKey: lessons.capablanca-primer.ch2.p1.summary
```

## Алгоритм (Этап 1)

1. Python-extractor (`src/python/extract_pdf.py`):
   - PyMuPDF читает страницу как `dict` с блоками и spans.
   - Reading-order: сортировка по (column, y) — Калиниченко 2016 имеет
     2-колоночную вёрстку. Колонка определяется по центру bbox по X.
   - Heading detection — по эвристике (bold-шрифт `Demi`/`Bold`, размер
     1+pt больше медианы prose, паттерны `Глава N` / `§N` / `N.`).
   - Распознавание Chess-Merida-диаграмм — через `pdf_recognizer.find_boards_on_page`
     из `@kingside/board-image-to-fen` (KS-2030).
   - Inline-Chess-Merida в тексте (long-algebraic с глифами фигур) —
     блоки с pure-Chess-Merida-spans отбрасываются на этом этапе.
2. JSON AST — список блоков `heading|prose|diagram` в reading-order.
3. TS-transformer (`src/transformer.ts`):
   - heading level=1 → пропускается (это `lesson.title`).
   - heading level≥2 → закрывает текущий шаг, открывает новый.
   - prose → добавляется в `bodyMarkdown` текущего шага (с нормализацией
     переносов).
   - diagram → добавляется в `step.diagrams[]` + маркер `{{diagram:N}}`
     в bodyMarkdown.
4. AJV-валидация через `@kingside/lesson-import.parseLessonYaml` —
   общая schema для импорта.

## Известные ограничения (Этап 1)

- **Подразделы режутся слишком агрессивно.** Каждый bold-подзаголовок
  («Ладья», «Слон» и т. д.) → отдельный шаг. В ручной разметке
  архитектор группирует их под общий шаг «### 2. Ходы». Этап 2 —
  улучшить heuristic «не открывать новый шаг для h3, если только что
  был h2».
- **Заголовки в ALL CAPS.** Калиниченко набирает «1. ИГРА» прописными;
  reference YAML использует Title Case «1. Игра». Этап 2 — нормализация
  регистра.
- **Часть-заголовок попадает как шаг.** «Часть Первая» эвристика
  пропускает как level=2, должно быть level=1 (фильтруется).
- **Inline-нотация не разбирается.** Long-algebraic ходы внутри prose
  с глифами Chess-Merida не конвертируются в SAN — это Этап 2.
- **PGN-партии не выделяются в game_review.** Любая последовательность
  ходов остаётся в bodyMarkdown.

## Тесты

```sh
npm --prefix /project/packages/pdf-to-lesson-yaml run test
```

Smoke-тест на Главе 1 Калиниченко 2016 (стр. 14–22): 14 text-шагов,
19 диаграмм с корректным FEN. Сравнивается с уже залитым
`01-ch1-game-pieces-moves-goal.lesson.yml` — расхождения зафиксированы
в комментарии к KS-2045 как план Этапа 2.

## Roadmap

См. ADR KS-2044 §7.

- **Этап 2:** PGN → game_review, long-algebraic → SAN, грамотный split
  по headings.
- **Этап 3:** упражнения → puzzle/quiz.
- **Этап 4:** растровые PDF (Майзелис), другие chess-шрифты.
- **Этап 5:** интеграция с `POST /lessons/admin/import-pdf`.
