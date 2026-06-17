# Конвейер видеообзоров (pipeline v3) — посегментная запись + точечная пересъёмка

**Статус:** Принят к реализации, devops-задача будет заведена координатором.
**Дата:** 2026-06-17
**Связанные задачи:** KS-4327 (этот проект), KS-4316 (D1 «Лекции» — заморожена до внедрения v3), KS-4079..4081 (история v2).
**Заменяет:** [ADR-123](../adr/123-video-overview-pipeline-v2.md) (pipeline v2 — single-take recording).

Документ канонический. Контент-агент опирается на этот файл при подготовке сценариев и запуске записи.

---

## 1. Зачем v3

### 1.1. Что было больно в v2

v2 (ADR-123) записывал всю Playwright-сессию одним прогоном: `make video KEY=KS-NNNN` открывал четыре контекста (A1/B1/A2/B2), последовательно проигрывал все сцены и сохранял каждый контекст как один длинный `.webm`. `build-track.py` потом вырезал сцены по `startMs/holdMs` из `placements.json`.

Это плохо масштабируется, как только сценарий длинный:

- Правка одной строки сегмента (`segment-007.txt`) или одного `selector` в `scene-actions.json` запускала полный прогон от 1-й до N-й сцены. На D1 (17 сцен, ~3 мин) это десятки минут на изменение, которое касается одной сцены.
- Прогон стабильных сцен 1–6 при правке сцены 12 — пустая работа: токены, процессорное время, риск регрессий от ассистов «починю заодно».
- Кеш отсутствует. Идемпотентность не достигается даже при нулевых изменениях — каждый прогон записывает всё.
- QC-проверки рассинхрона/обрезанной фразы (планируются отдельно) не могут вернуть «сцена X плохая, переснимай её» — у v2 нет понятия пересъёмки одной сцены.

### 1.2. Что меняется в v3

1. **Сцена — атомарная единица хранения.** Каждая сцена держится на диске как `/tmp/KS-NNNN/scenes/<sceneId>/capture.webm` + `meta.json`.
2. **Кеш по содержимому.** Перед записью каждой сцены считается `sha256` от инвариантного входа (текст сегмента, mp3-озвучка, декларация действий, версия `record.mjs`, hash предыдущих сцен в цепочке). Совпал с `meta.json` — сцена не пересматривается.
3. **Точечная пересъёмка.** `make rescene KEY=KS-NNNN SCENE=<sceneId>` переписывает одну сцену (точнее, её цепочку — см. §3) без участия остальных.
4. **Идемпотентность.** Повторный `make video KEY=KS-NNNN` без изменений → 0 пересъёмок, только финальная склейка.
5. **QC-готовность.** Автоматизированный контроль качества триггерит пересъёмку конкретной сцены, не всего обзора.

v3 НЕ меняет:
- Инварианты v2: «аудио первично», «сегмент атомарен», «действия привязаны к словам-якорям». ElevenLabs `/with-timestamps`, `synth-eleven.py`, `measure-segments.py` остаются без изменений.
- Контракт ID-карты сцен: каждая сцена → один сегмент `segment-NNN.txt` → один mp3.
- ASSERT-режим (`assert: { selector, mustExist }` + 3 попытки) — остаётся обязательным.

---

## 2. Архитектура: chain → scene → segment

### 2.1. Сцена и цепочка (chain)

Минимальная единица **хранения** в v3 — сцена. Но единица **записи** — цепочка сцен (chain). Чаще всего chain = 1 сцена. Цепочка из нескольких сцен нужна там, где UI-состояние сцены N+1 нельзя дёшево восстановить из нуля — нужна непрерывная сессия от сцены N.

Где это критично:
- **D1 «Лекции»** — сцены 9–12 (`live-go`, `live-record-and-move`, `live-chat`, `coach-end`): одна live-broadcast WebSocket-сессия, тренер в pa1 уже сделал `attachExistingSession`, ходы тренера публикуются в namespace; pb2 подключён к `/live/${slug}` как зритель. Сессия не атомарно восстанавливается — это одна цепочка.
- **A2 «Партии»** — сцены 5–10 (одна live-игра между A и B): chess-clock, WebSocket-партия, история ходов. Это одна цепочка.

Где chain не нужен:
- Большинство `single-coach`, `single-viewer`, `single` сцен (`intro`, `coach-open-lectures`, `outro`, …) — открыли страницу, навели курсор, закрыли. Каждая такая сцена → отдельный chain длиной 1.

Внутри цепочки сцены **последовательны** и зависят друг от друга по UI-состоянию. Между цепочками зависимостей по состоянию **нет**, только опционально через `stateRefs` (см. §6) — обычно это id seed-сущностей.

### 2.2. Состояние между цепочками: stateOut / stateRefs

Если цепочка `coach-create` создала лекцию и зафиксировала её id, то цепочка `viewer-catalog-scheduled` (одна сцена) хочет открыть `/lectures/<id>`. Решения:

- **Предпочтительный путь — seed-данные с фиксированными id.** Скрипт `tools/video-overview/seed-<scenario>.mjs` создаёт сущности заранее, под известными UUID; сцены подставляют их как литералы. Hash сцены устойчив. Forward propagation не нужен. Так уже сделано в KS-4316 (`7e6289b6-2ce8-4cb2-b27b-e7d998a5b108` как фиксированный analysisId).
- **Запасной путь — динамическое состояние.** Цепочка `coach-create` объявляет `stateOut.lectureId`; цепочка `viewer-catalog-scheduled` объявляет `stateRefs: ["coach-create.lectureId"]`. Тогда `record.mjs` дописывает `state.lectureId` в `/tmp/KS-NNNN/state/coach-create.out.json` после её прогона, а зависимая цепочка читает и подставляет через `${state.coach-create.lectureId}` в URL/тексте. Hash зависимой цепочки включает значения её `stateRefs` — если они изменились, цепочка переснимается (forward propagation).

Рекомендация: seed-данные везде, где это возможно. Динамика — только когда сценарий показывает «вот сейчас тренер создаёт новое».

---

## 3. Контракт `scene-actions.json` v3

### 3.1. Корневой формат

```json
{
  "$schema": "scene-actions.v3",
  "ticket": "KS-NNNN",
  "scenarioVersion": "v1",
  "recordVersion": "3.0.0",
  "initialAuth": "user",
  "wideViewportB": true,
  "sceneDrivenNarrowSwitch": true,
  "grantMicrophone": ["A"],
  "fakeAudioFile": "/tmp/KS-NNNN/fake-mic.wav",
  "defaults": { "leadMs": -200, "occurrence": 1, "side": "A" },
  "chains": [
    {
      "chainId": "intro",
      "preconditions": { "contexts": ["A1"], "navigate": { "A": "${WEB}/lectures" } },
      "stableState": true,
      "scenes": [
        { "sceneId": "intro", "segment": 1, "layout": "single-coach", "metaActions": [...], "actions": [...] }
      ]
    },
    {
      "chainId": "live-session",
      "preconditions": {
        "contexts": ["A1", "B2"],
        "stateRefs": ["coach-bind-and-start.lectureSlug"]
      },
      "scenes": [
        { "sceneId": "live-go",              "segment": 9,  "layout": "split",  ... },
        { "sceneId": "live-record-and-move", "segment": 10, "layout": "split",  ... },
        { "sceneId": "live-chat",            "segment": 11, "layout": "split",  ... },
        { "sceneId": "coach-end",            "segment": 12, "layout": "split",  ... }
      ]
    }
  ]
}
```

### 3.2. Новое в v3 (относительно v2)

| Поле | Уровень | Назначение |
|---|---|---|
| `$schema: "scene-actions.v3"` | корень | дискриминатор формата; `record.mjs` отказывается работать с другим значением |
| `recordVersion` | корень | строка вида semver; meняется при изменениях `record.mjs`/`build-track.py`, влияющих на кадр. Любое изменение → полная пересъёмка серии. См. §5.2 |
| `chains[]` | корень | заменяет плоский `scenes[]` v2 |
| `chainId` | chain | уникален в пределах файла. Стабильный, человекочитаемый. Используется в путях кеша и `--chain` CLI |
| `preconditions` | chain | декларация: какие контексты поднимать, куда первоначально навигировать, какие `stateRefs` читать |
| `stableState: true` | chain | подтверждение: `stateOut` устойчив между запусками (например, seed-данные с фиксированным UUID). Без этого `record.mjs` форсит пересъёмку всех downstream-цепочек. Default — `false` |
| `stateOut` | chain | карта `{ key: source }`, где source — API-вызов или DOM-капча; пишется в `state/<chainId>.out.json` после прогона |
| `stateRefs` | chain | список ссылок `<chainId>.<key>` для подстановки `${state.<chainId>.<key>}` в URL/тексте сцен |
| `sceneId` | scene | заменяет `tag` v2. Уникален в пределах файла. Стабильный, человекочитаемый, используется в путях кеша и `--scene` CLI. Совпадение с `tag` v2 допустимо при миграции, но `sceneId` теперь обязателен |

### 3.3. Что не изменилось

- `segment`, `layout`, `metaActions[]`, `actions[]`, `assert`, `splice`, `anchor`, `leadMs`, `occurrence`, `useLast`, `fallbackAtMs`, `delayFromPrevMs`, `side` — контракт v2 действует на уровне сцены внутри chain.
- Все `metaAction.type` (`goto`, `waitForSelector`, `pageClick`, `seedAnalyses`, `ensureLectureLive`, `captureLectureSlug`, …) остаются. Любое новое seed-meta-действие, появившееся для v3, описывается отдельно в комментариях к `record.mjs`.
- Двухконтекстная съёмка через `startContextB`/`contextBJoinQueue`/`waitForBothNavigate` — поддерживается; такие сцены обычно живут в одной цепочке.

### 3.4. Требования к sceneId / chainId

- `[a-z0-9-]+`, без пробелов и Unicode.
- Уникален в пределах `scene-actions.json`. Изменение sceneId == новой сцене (старый кеш не подхватывается).
- При миграции с v2 — берётся из `tag` v2 (там уже валидные имена).

---

## 4. Раскладка `/tmp/KS-NNNN/`

```
/tmp/KS-NNNN/
├── scene-actions.json              ← v3 формат (см. §3)
├── segments.json                   ← выход measure-segments.py (как в v2)
├── scenes/                         ← кеш по сценам (главное хранилище)
│   ├── intro/
│   │   ├── capture.webm            ← готовый кадр сцены: target_w × target_h, без аудио,
│   │   │                             с применённым layout (single/split-hstack), splice, pad/crop
│   │   └── meta.json
│   ├── coach-open-lectures/
│   │   ├── capture.webm
│   │   └── meta.json
│   └── ...
├── chains/                         ← cache промежуточных артефактов записи (master-видео)
│   ├── intro/
│   │   ├── master-A1.webm          ← raw запись контекста за прогон цепочки
│   │   └── placements.json         ← startMs/holdMs каждой сцены внутри master
│   ├── live-session/
│   │   ├── master-A1.webm
│   │   ├── master-B2.webm
│   │   └── placements.json
│   └── ...
├── state/                          ← stateOut по цепочкам
│   ├── coach-create.out.json
│   └── ...
├── voice.wav                       ← выход build-track.py (как в v2)
├── final.webm                      ← финальная склейка (как в v2, имя по --slug)
└── logs/                           ← stdout/stderr Playwright-сессий
```

```
/tmp/voiceover/KS-NNNN/
├── segment-001.txt   segment-001.mp3   segment-001.timings.json
├── segment-002.txt   segment-002.mp3   segment-002.timings.json
└── ...
```

`chains/` — это слой кеша. После успешной нарезки `scenes/<sceneId>/capture.webm` мастер-видео цепочки можно удалить (опционально), но по умолчанию хранится: при изменении только параметра `splice` или `splitSource` сцены кадр пересобирается из мастер-видео без перезаписи Playwright-сессии.

### 4.1. Формат `scenes/<sceneId>/meta.json`

```json
{
  "sceneId": "live-record-and-move",
  "chainId": "live-session",
  "sceneIdxInChain": 1,
  "segmentIdx": 10,
  "layout": "split",
  "splitSource": "A1+B2",
  "splice": null,
  "hash": "f9c1...e6a",
  "durMs": 18420,
  "holdMs": 18820,
  "recordVersion": "3.0.0",
  "captureWidth": 1920,
  "captureHeight": 1200,
  "recordedAt": "2026-06-17T18:42:17Z",
  "masterRefs": {
    "A1": "../../chains/live-session/master-A1.webm",
    "B2": "../../chains/live-session/master-B2.webm",
    "startMs": 19200,
    "offsetA1": 320,
    "offsetB2": 280
  }
}
```

`hash` — единственное поле, по которому `record.mjs` принимает решение «брать из кеша или переснимать». Остальные поля — для отладки и инспекции.

### 4.2. Формат `chains/<chainId>/placements.json`

Совпадает с `placements.json` v2 (для конкретного контекста), плюс поле `chainId` и `sceneIdxInChain`. Не публичный — внутренний артефакт.

---

## 5. Hash-инвариант сцены

### 5.1. Что включается

```
hash(sceneId) = sha256(canonical_json({
  recordVersion:        "3.0.0",
  chainId:              "live-session",
  sceneId:              "live-record-and-move",
  sceneIdxInChain:      1,
  segmentIdx:           10,
  segmentText:          <SHA256 файла /tmp/voiceover/KS-NNNN/segment-010.txt>,
  segmentMp3:           <SHA256 файла /tmp/voiceover/KS-NNNN/segment-010.mp3>,
  segmentTimings:       <SHA256 файла /tmp/voiceover/KS-NNNN/segment-010.timings.json>,
  sceneDeclaration:     <canonical JSON всей сцены, как в scene-actions.json>,
  chainDeclaration:     {
    preconditions:      {...},
    stableState:        true|false,
    resolvedStateRefs:  { "coach-bind-and-start.lectureSlug": "kar-kann-2026-06-17" }
  },
  prevScenesInChain:    [ <hash sceneId(0)>, <hash sceneId(1)>, ... ],
  globalDefaults:       { leadMs: -200, occurrence: 1, side: "A" }
}))
```

`canonical_json` — стабильная сериализация: ключи отсортированы лексикографически, числа без trailing zeros, без пробелов.

`prevScenesInChain` обязателен: если сцена 0 в цепочке поменялась, её holdMs сдвинулся, и сцена 1 в той же цепочке стартует в другой точке мастер-видео — кадры будут другие.

`resolvedStateRefs` — значения, прочитанные из `state/<refChainId>.out.json` НА МОМЕНТ записи. Это даёт forward propagation: если upstream-цепочка переписана и её `stateOut` изменился, downstream-цепочки получают другой `resolvedStateRefs.<key>` → их `hash` не совпадёт → они тоже переснимаются.

### 5.2. Что не включается (намеренно)

- Содержимое `segments.json` целиком — длительности других сегментов не влияют на сцену.
- Длительности соседних цепочек.
- `chains/*/master-*.webm` mtime — кеш мастер-видео живёт отдельно (см. §4).
- Метки времени (`recordedAt`, `runId`).

### 5.3. Когда меняется `recordVersion`

- Изменения в `record.mjs`, влияющие на кадр или планирование (новый тип action, изменение алгоритма якоря, новый HUD, изменение viewport, изменение buffer).
- Изменения в `build-track.py`, влияющие на финализацию сцены (нарезка, hstack, pad/crop, splice).
- Чисто внутренние правки логирования / форматирования — `recordVersion` НЕ меняется.

Изменение `recordVersion` → полная пересъёмка серии. Это сознательная плата за инвариант «совпавший hash гарантирует визуально идентичный кадр».

---

## 6. Команды

### 6.1. `make video KEY=KS-NNNN`

Полный конвейер. Самодостаточен.

```
1. synth         (ElevenLabs, как в v2; идемпотентен, повторно дёшев)
2. measure       (ffprobe, как в v2)
3. plan-rebuild  (новое в v3):
    a. Загрузить scene-actions.json, валидировать $schema.
    b. Для каждой цепочки в порядке появления:
        - Прочитать предыдущие stateOut.json (если есть).
        - Для каждой сцены посчитать expectedHash (см. §5).
        - Если scenes/<sceneId>/meta.json.hash == expectedHash → SKIP scene.
        - Иначе → пометить chain как DIRTY.
    c. Forward propagation: если DIRTY chain X пишет stateOut с stableState=false,
       все downstream chains (по stateRefs) тоже DIRTY.
4. record        (новое в v3):
    Для каждой DIRTY chain (последовательно):
      - Открыть только preconditions.contexts.
      - Выполнить preconditions.navigate с подстановкой stateRefs.
      - Прогнать все сцены цепочки в ASSERT-режиме (3 попытки на сцену, как в v2).
      - После завершения chain — нарезать master-видео на scenes/<sceneId>/capture.webm
        (применив layout, splice, hstack, pad/crop, target_w × target_h).
      - Записать meta.json для каждой сцены.
      - Сохранить master-видео в chains/<chainId>/.
      - Если объявлен stateOut — захватить значения и записать state/<chainId>.out.json.
5. build-track   (как в v2, но проще): concat scenes/<sceneId>/capture.webm в порядке
                 декларации (через все цепочки) + voice.wav → final.webm.
```

При нулевых изменениях шаг 4 не выполняет ни одной Playwright-сессии — только `plan-rebuild` (доли секунды) + `build-track` (опционально пропускается, если final.webm существует и newer чем все capture.webm).

### 6.2. `make rescene KEY=KS-NNNN SCENE=<sceneId>`

Точечная пересъёмка одной сцены.

```
1. Найти chain, содержащий sceneId.
2. Удалить scenes/<всех сцен этого chain>/meta.json
   (НЕ удаляем capture.webm — он остаётся как резерв до успешной перезаписи).
3. make video KEY=KS-NNNN  — конвейер автоматически признает chain DIRTY и переснимет.
4. После успешной записи: stale capture.webm перезаписаны.
```

Эффект: одна Playwright-сессия по этой цепочке. Остальные цепочки не трогаются. Если у переписанной цепочки изменился `stateOut` (а `stableState=false`) — downstream цепочки также переснимаются.

### 6.3. `make scene KEY=KS-NNNN SCENE=<sceneId>`

Алиас `rescene` (для симметрии: одно слово на запись/пересъёмку одной сцены).

### 6.4. `make voice KEY=KS-NNNN [SEGMENT=N]`

Без изменений из v2 (тонкий wrapper над `synth-eleven.py` + `measure-segments.py`).

### 6.5. `make scenes-clean KEY=KS-NNNN`

Сносит `scenes/`, `chains/`, `state/`. Следующий `make video` перепишет всё с нуля. Не трогает озвучку.

### 6.6. `make video` с явным `CHAINS=` / `SCENES=`

Опционально для отладки: `CHAINS=live-session,viewer-replay` — переснять только перечисленные цепочки и пересобрать финал. Или `SCENES=intro,outro` — то же, через sceneId.

---

## 7. Точечные изменения в коде

Архитектор не пишет код. Ниже — контракт правок для devops/backend.

### 7.1. `tools/video-overview/record.mjs`

| Функция | Что меняется |
|---|---|
| `parseArgs` | Добавить флаги `--chain=<chainId>`, `--scene=<sceneId>`, `--force`, `--plan-only` (вывести DIRTY/SKIP и завершиться) |
| `loadInputs` | Валидировать `$schema: "scene-actions.v3"`. Прочитать `chains[]` вместо `scenes[]`. Подгрузить `state/*.out.json`. Поддержать `${state.<chainId>.<key>}` в URL и `text` |
| `computeSceneHash(scene, chain, ...)` | Новая. По алгоритму §5.1. Каноническая JSON-сериализация — отдельный helper |
| `planRebuild()` | Новая. Для каждой цепочки решает SKIP/DIRTY, учитывая forward propagation |
| `runChain(chain)` | Новая, оборачивает существующий поток: открыть только `preconditions.contexts`, прогнать сцены этой цепочки, по концу — нарезать на сцены и записать `meta.json` |
| `cutCaptureForScene(scene, masterFiles, startMs, holdMs)` | Новая. Берёт нужный мастер (или два мастера для split), применяет layout/splice/pad/crop/hstack, кладёт в `scenes/<sceneId>/capture.webm`. Реиспользует ffmpeg-логику из `build-track.py` (вынести в общий `ffmpeg-cuts.py`/`.mjs` модуль) |
| `mainLoop` | Перестроить: вместо одного прогона всех сцен — итерация по DIRTY chain'ам |
| ASSERT-режим, retry, scene_attempt_* журнал | НЕ менять. Работает на уровне сцены внутри цепочки |

Объём правок: переписывание основного цикла + новые helpers. Поведение dispatchAction / runMetaActions / runAssert не меняется.

### 7.2. `tools/video-overview/build-track.py`

| Функция | Что меняется |
|---|---|
| `cut_scene_video`, `hstack_split_scene`, `cut_scene_spliced` | Вынести в shared-модуль; вызывать из `record.mjs` при нарезке цепочки. Опционально остаются как entrypoint для `make build-track` (когда capture.webm уже готовы) |
| `build_voice_track` | НЕ меняется по входу: читает `segments.json` + список сцен в порядке. Вход «список сцен» теперь приходит из `scene-actions.json` (плоский обход chains[].scenes[]), а не из `placements.json` |
| `concat_scenes` | Берёт `scenes/<sceneId>/capture.webm` для каждой сцены в порядке декларации, concat → mp4 без аудио |
| `mux_final` | Без изменений |

### 7.3. `tools/video-overview/Makefile`

Новые цели: `rescene`, `scene` (алиас `rescene`), `scenes-clean`, `plan-only`.

Изменённые: `record` теперь принимает `SCENE=`, `CHAIN=`, `FORCE=`.
`video` остаётся точкой входа полного конвейера — внутренняя реализация другая, контракт совместим.

Все цели проверяют `$schema` входного `scene-actions.json` (через быстрый `jq` или `python3 -c`); при `v2` — fail loudly с указанием на этот документ и подсказкой про миграцию.

### 7.4. Новый файл `tools/video-overview/scene-hash.py` (или `.mjs`)

Утилита расчёта hash по §5.1. Используется и `record.mjs`, и (опционально) внешним QC-агентом для предъявления expectedHash.

Должна быть однозначно референсной — алгоритм canonical_json + список включаемых полей задокументирован прямо в её docstring.

---

## 8. Двухконтекстная съёмка и split-сцены

Не меняется по сути, меняется группировка:

- **Split-сцены внутри одной WebSocket-партии / live-лекции** → одна цепочка с `preconditions.contexts: ["A1", "B2"]` (или `["A2", "B2"]` для шахматной партии).
- **Изолированная split-сцена** (редкий случай) → цепочка длиной 1, контексты поднимаются и закрываются вокруг одной сцены. Стоимость записи выше, чем у single, потому что два контекста — ОК для одной сцены.
- **`splitSource: "A1+B2"` vs `"A2+B2"`** — параметр сцены, влияет на `cutCaptureForScene` и попадает в `hash` (через `sceneDeclaration`).

`switchToNarrowContexts` (текущий v2 helper) уходит — больше не нужен, потому что цепочка с самого начала открывает только нужные контексты.

---

## 9. Миграция

### 9.1. Готовые тикеты (KS-4055..4066, KS-4077..4090, …)

**Остаются в v2 как есть.** Не перегенерируем. Финальные видео сданы, исходники в `/tmp/` сохранены для аудита. ADR-123 продолжает покрывать их формально.

### 9.2. Активные тикеты в работе на момент внедрения v3

KS-4316 (D1 «Лекции») — на момент написания заморожена. После внедрения v3:

- `/tmp/KS-4316/scene-actions.json` переписывается в формат v3 — это разовая ручная работа архитектора/контент-агента: завернуть существующие сцены в цепочки.
- Предполагаемая разбивка на цепочки (предложение, согласуется при возобновлении KS-4316):
  - `intro` (1 сцена)
  - `coach-create` (3 сцены: `coach-open-lectures`, `coach-create-modal`, `coach-create-submit`)
  - `viewer-catalog-scheduled` (1 сцена)
  - `coach-bind` (2 сцены: `coach-open-analysis`, `coach-bind-and-start`)
  - `live-session` (4 сцены: `live-go`, `live-record-and-move`, `live-chat`, `coach-end`)
  - `viewer-replay` (2 сцены: `viewer-back-to-landing`, `viewer-open-replay`)
  - `replay-seek` (1 сцена)
  - `catalog-recorded` (1 сцена)
  - `coach-profile` (1 сцена)
  - `outro` (1 сцена)
- Итого 10 цепочек на 17 сцен. Из них «дорогая» только `live-session` (4 split-сцены). Правка сегмента `intro` → пересъёмка 1 сцены вместо всех 17.

### 9.3. Новые тикеты после внедрения v3

Сразу в v3. Шаблоны (примеры цепочек) — в `tools/video-overview/templates/` (заводится devops).

---

## 10. Риски и открытые вопросы

### 10.1. Стыки между capture.webm

Между сценами `concat` через ffmpeg демультиплексор может дать jitter, если keyframes у соседних `capture.webm` не совпадают. Это была одна из причин отказа от посегментного рендера в v2 (см. ADR-123 §3.1).

**Решение:** `cutCaptureForScene` всегда транскодирует через `libx264 -preset ultrafast -g <gop>` с фиксированным GOP (например, 12 кадров при 30fps) и `-keyint_min`. Это даёт совпадающие GOP на стыках; перекодирование уже происходит в `build-track.py` (см. `cut_scene_video`). В практике v2 (`build-track.py` `cut_scene_video` → `concat_scenes`) после этой перекодировки стыки чистые — v3 переиспользует ту же цепочку.

### 10.2. Состояние UI между сценами одной цепочки

Внутри цепочки сцены идут последовательно в одной Playwright-сессии — состояние carry-over бесплатное (как сейчас в v2).

### 10.3. WebSocket-сессии и таймеры

Live-broadcast WebSocket и chess-clock работают только в пределах цепочки. Разорвать такие сцены на отдельные цепочки нельзя — нужно держать одну сессию. Это и есть причина существования chain как сущности.

### 10.4. Forward propagation при `stableState=false`

Если `coach-create` каждый раз создаёт новую лекцию с новым UUID, любая правка `coach-create` инвалидирует `viewer-catalog-scheduled`, `viewer-replay`, `replay-seek` (все они подставляют `${state.coach-create.lectureId}`).

**Митigation:** массово переводить такие цепочки на `stableState=true` через seed-скрипт. Это разовая работа на сценарий.

### 10.5. Время первой записи

Пустой кеш (`scenes/` отсутствует) → первый прогон по времени эквивалентен v2 (никакого выигрыша). Выигрыш — на каждой последующей правке.

Этот документ не обещает выигрыш на первой записи, только на пересъёмках. Пользователю это сообщить отдельно — иначе будет ощущение «v3 не быстрее».

### 10.6. Сцены, у которых meta-actions требуют ввод-через-API (`seedAnalyses`, `seedPuzzleAttempts`)

Если цепочка X имеет `seedAnalyses` в metaActions сцены 1, а цепочка Y (отдельная) пытается потом показать эти сущности — sceneDeclaration X включает seedAnalyses, но цепочка Y об этом не знает. Если Y читает из API «последние созданные», hash Y нестабилен.

**Решение:** seed-данные с фиксированными id — централизованный seed-скрипт `seed-<scenario>.mjs`, который запускается **один раз** перед `make video` и создаёт всё нужное по детерминированным UUID. Сценарий ссылается на UUID литералами. Цепочки тогда полностью независимы.

Это рекомендованный путь для всех новых сценариев в v3. seed-скрипт коммитим, UUID коммитим, hash стабилен.

### 10.7. Размер `chains/` кеша

`master-*.webm` крупные. Опция: после успешной нарезки удалять master, оставлять только `placements.json`. Минус: при изменении только `splice`/`splitSource`/`captureWidth` придётся переснимать целиком.

Дефолт v3: хранить master до следующей `make scenes-clean`. Параметризовать через `--keep-masters=false` для CI / batch-режимов.

### 10.8. Поведение QC-агента (на будущее)

QC получает `final.webm` + `scenes/*/meta.json` + журнал `events.jsonl`. Если QC находит проблему на сцене X (рассинхрон, обрезанная фраза, неверный кадр) — он удаляет `scenes/X/meta.json` (или вызывает `make rescene SCENE=X`). Дальше — обычный конвейер.

Это совместимо с §10.6: QC не лезет в seed-данные, только в кадр и тайминги.

---

## 11. Глоссарий

- **Сцена (scene)** — атомарная единица показа: один сегмент озвучки + один кадр UI с действиями, привязанными к якорям. Хранится как `scenes/<sceneId>/capture.webm`.
- **Цепочка (chain)** — атомарная единица записи: одна или несколько последовательных сцен, делящих Playwright-сессию. Большинство цепочек длиной 1.
- **Master-видео** — raw `.webm`, который Playwright записывает за прогон цепочки. Хранится в `chains/<chainId>/master-<context>.webm` как кеш.
- **stateOut / stateRefs** — механизм передачи динамического состояния между цепочками без нарушения изоляции.
- **stableState** — флаг гарантии устойчивости `stateOut` цепочки между запусками. `true` для seed-driven сценариев.
- **Hash сцены** — sha256 от инвариантного входа, единственный критерий «брать из кеша или переснимать».

---

## 12. Чек-лист готовности cценария v3 (для контент-агента)

1. Тексты сегментов `segment-NNN.txt` в `/tmp/voiceover/KS-NNNN/`.
2. `scene-actions.json` с `$schema: "scene-actions.v3"` и валидной `chains[]` структурой.
3. Для каждой сцены — `sceneId` (стабильный), `segment`, `layout`, `actions[]` с якорями.
4. Для каждой цепочки — `chainId`, `preconditions.contexts`, `preconditions.navigate`, опционально `stateRefs`/`stateOut`/`stableState`.
5. seed-скрипт `tools/video-overview/seed-<slug>.mjs` (если сценарий использует stateRefs со `stableState=true`).
6. Каждая сцена проходит ASSERT-режим — `assert: { selector, mustExist }` или явное `assert: 'decorative'` на каждом продуктивном metaAction/action.
7. `make video KEY=KS-NNNN` без параметров проходит до конца на первом прогоне.
8. Повторный `make video KEY=KS-NNNN` без изменений: 0 пересъёмок (по логам plan-rebuild).
9. Точечная правка одной сцены и `make rescene SCENE=<sceneId>` пересматривает только её цепочку.
