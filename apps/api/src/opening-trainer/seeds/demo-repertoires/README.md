# Демо-репертуары Opening Trainer (KS-4162 + KS-4674 / ADR-128 §10 + ADR-146)

Источник контента для публичных GET-эндпоинтов:

- `GET /opening-trainer/demo`
- `GET /opening-trainer/demo/:id`

После KS-4674 источник истины — таблица `opening_repertoires` (`is_demo=true`).
CRUD на проде — через админский API `POST/PUT/PATCH/DELETE /admin/opening-trainer/repertoires`
(см. `apps/api/src/opening-trainer/admin/opening-trainer-admin.controller.ts`).

PGN-файлы в этой директории используются bootstrap-скриптом
`apps/api/src/scripts/seed-demo-repertoires.ts` — однократный перенос
исторического набора в БД на проде и заливка демо-данных на чистый
снапшот локальной разработки. Идемпотентен (upsert по `(is_demo=true, slug)`).

## Формат

Один репертуар = один файл PGN. Имя файла без расширения — это `slug`,
он же `id` в URL `/opening-trainer/demo/<slug>`.

```
seeds/demo-repertoires/
  najdorf.pgn
  najdorf.meta.json        # опционально
  caro-kann.pgn
  ...
```

Допустимые символы slug'а: `a-z`, `0-9`, `-`. Любой файл с `slug`,
не соответствующим этому шаблону, пропускается с предупреждением в логах.

## PGN

Стандартный PGN (с вариантами в круглых скобках, комментариями `{...}`
и NAG'ами). Парсер — общий с личными репертуарами
(`RepertoireBuilderService.buildTree`), поддерживаются:

- вложенные варианты,
- транспозиции (схлопываются по FEN),
- лимиты ADR-077 §3.2 (PGN ≤ 500 KB, узлы ≤ 2000, рёбра ≤ 5000),
- ChessBase null-move (`Z0` / `--`) — ветка пропускается с предупреждением,
  PGN целиком не падает.

Битый PGN не валит сервис: файл пропускается, запись попадает в лог.

## Опциональный `<slug>.meta.json`

```json
{
  "side": "white",
  "description": "Открытый испанский за белых",
  "languages": ["ru", "en"]
}
```

Все поля опциональны:

- `side`: `"white" | "black"`. Если нет — `"white"`.
- `description`: строка. Если нет — берётся PGN-тег `Annotator`, иначе
  пустая строка.
- `languages`: массив строк (BCP-47 кодов). Если нет — пустой массив.

## Заголовки PGN

- `[Event "..."]` — используется как `title`. Fallback — slug файла,
  преобразованный в Title Case.
- `[Annotator "..."]` — fallback для `description`, если нет `meta.json`.

## Эксплуатация

Сервис читает директорию один раз на `onModuleInit`. Чтобы перечитать
без рестарта в dev — `npm run dev` (NestJS DI cycle перезапустит модуль).
В prod достаточно рестарта сервиса `api` после обновления seed-файлов
(деплой `api` уже это делает).
