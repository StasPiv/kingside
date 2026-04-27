# @kingside/lesson-import

CLI для импорта/экспорта/валидации YAML-файлов уроков (формат KS-2015,
ADR `docs/architecture/KS-2015-lesson-file-format.md`, B-1).

Парсит YAML, валидирует через `@kingside/lesson-schema` (AJV draft-07,
все 8 типов шагов), сравнивает с текущим состоянием в БД и записывает
урок одной транзакцией через admin-эндпоинт `POST /lessons/admin/import`
(реализуется в B-3, KS-2018).

## Быстрый старт

```bash
# из корня монорепо
npm install
npm run build --workspace=@kingside/lesson-import

# вариант 1 — через ссылку, созданную npm
npx lesson-import --help

# вариант 2 — напрямую
node packages/lesson-import/dist/cli.js --help
```

## Команды

### `lesson-import validate <path>`

Парсит YAML и валидирует против JSON Schema. Без сетевых вызовов.
Возвращает exit `0` на успехе и `1` при ошибке валидации.

```bash
lesson-import validate content/courses/capablanca-primer/01-chapter-1.lesson.yml
# ✓ valid: course (none), 1 lesson(s)

lesson-import validate path/to/broken.lesson.yml
# ✗ /…/broken.lesson.yml: steps[0] (text).diagrams[0].fen — must match pattern "..." (pattern)
# 1 error(s); validation failed.
```

`<path>` может быть:

- Файлом `*.lesson.yml` / `*.lesson.yaml` — один урок.
- Директорией с `course.yml` + N `*.lesson.yml` — курс целиком.

### `lesson-import dry-run <path> --base-url <api>`

Валидация + GET текущего состояния курса/уроков из admin API + diff.
Без записи. Полезно для CI и для предпросмотра перед `import`.

```bash
lesson-import dry-run content/courses/capablanca-primer \
  --base-url http://localhost:3001 --token $ADMIN_TOKEN
```

Пример вывода:

```
Course «capablanca-primer»: unchanged
Lesson «chapter-2-p1-simple-mates»: updated (fields: title, summary)
Steps (13):
  # 1 text            unchanged
  # 2 game_review     unchanged
  # 3 game_review     updated  (payload changed)
  …
  #12 text            updated  (payload changed)
  #13 game_review     unchanged

Summary: 0 created, 2 updated, 11 unchanged, 0 deleted.
```

### `lesson-import import <path> --base-url <api> [--token <admin>] [--yes]`

То же, что `dry-run`, плюс POST на `/lessons/admin/import`. Без `--yes`
работает как dry-run и не пишет в БД (страховка от случайных «применить»).

Текущее поведение (B-1, до выпуска B-3): команда печатает diff и
показывает `! 404 admin import endpoint is not deployed yet (B-3 / KS-2018)`
с exit code `2`.

### `lesson-import export --course <slug> --base-url <api> --out <dir>`

Обратная операция: GET курса по slug, генерация `course.yml` +
`<NN>-<slug>.lesson.yml` в out-директорию. Используется в B-4 (KS-2019)
для миграции существующих курсов в `content/courses/`.

```bash
lesson-import export \
  --course capablanca-primer \
  --base-url http://localhost:3001 \
  --token $ADMIN_TOKEN \
  --out content/courses/capablanca-primer
```

С флагом `--dry-run` файлы не пишутся, только показывается, что было бы.

## Архитектура

```
src/
  cli.ts           — точка входа, commander, 4 команды
  parser.ts        — YAML → объект, AJV-валидация (lesson-schema, ajv-formats)
  errors.ts        — форматирование AJV-ошибок (фильтр шума от oneOf-дискриминатора)
  diff.ts          — сравнение бандла с состоянием БД
  diff-print.ts    — печать diff в формате §5.5 ADR
  api-client.ts    — тонкий fetch-клиент к admin API
  upserter.ts      — POST /lessons/admin/import (B-3 endpoint)
  exporter.ts      — обратное направление: БД → YAML-файлы
```

Бизнес-валидация (FEN/PGN/UCI-легальность, видео-хост whitelist,
custom puzzle решение) выполняется на admin-эндпоинте B-3 — здесь
только структурный AJV-слой (см. ADR §5.3).

## Тесты

```bash
npm test --workspace=@kingside/lesson-import
```

24 теста (vitest):

- `parser.spec.ts` — парсинг + валидация (валидный мини-пример из §4.14
  ADR, отсутствие slug, плохой FEN, синтаксис YAML).
- `diff.spec.ts` — диффовка (create / unchanged / update / delete steps).
- `cli.spec.ts` — CLI-сценарии (validate exit code, dry-run mock fetch,
  import без `--yes`, export пишет файлы).

## Зависимости

- `ajv ^8`, `ajv-formats ^3` — JSON Schema валидация.
- `js-yaml ^4` — YAML-парсер.
- `commander ^12` — CLI-флаги.
- `picocolors ^1` — цвет (опционально, отключается `--no-color`).
- `@kingside/lesson-schema` — JSON Schemas (B-2, KS-2016).

## Что дальше

- **B-3 (KS-2018):** admin endpoint `POST /lessons/admin/import` —
  собственно запись в БД одной `prisma.$transaction`.
- **B-4 (KS-2019):** миграция существующих курсов в
  `content/courses/` через `lesson-import export` + удаление ad-hoc
  скриптов в `/tmp/courses/`.
