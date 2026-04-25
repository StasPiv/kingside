# ADR-028: Стратегия хранилища архива партий — фазовая архитектура

**Дата:** 2026-04-25
**Статус:** Предложено (требуется решение пользователя по сценарию)
**Задача:** KS-1901
**Связанные:**
- [ADR-013 Game archive and tree](./013-game-archive-and-tree.md) — фазы A/B/C/D, ClickHouse-secondary, переключаемый репозиторий
- [ADR-014 Archive games by position](./014-archive-games-by-position.md) — `archive_game_positions`, immutable-семантика
- [ADR-018 Archive service extraction](./018-archive-service-extraction.md) — выделение HTTP-сервиса
- [ADR-027 Archive RDS sizing](./027-archive-rds-sizing.md) — sizing PG (Phase 1), может быть пересмотрен
- KS-1893 — производственный инцидент, мотивация пересмотра
- KS-1900 — секционирование `archive_game_positions` (зависит от выбора в этом ADR)

> **Обновление 2026-04-25.** ADR существенно переработан после диалога с
> пользователем. Из первой редакции убраны операционные оценки (недели
> разработки, стоимость разработчика, bus factor): архитектор не оценивает
> сроки и не выбирает между сценариями за пользователя при равных
> архитектурных аргументах. Решение представлено как **фазовая модель** с
> архитектурными триггерами. Стратегия S7c (custom storage) переосмыслена
> как валидная Phase 2 архитектурная опция, а не «писать БД с нуля».

---

## 1. Контекст

### 1.1 Что произошло (KS-1893)

ADR-013 §10.A закладывал переход на Phase B (партиционирование, COPY-pipeline)
при объёме > 30M строк `position_stats` и переход на ClickHouse (Phase C) при
> 100M строк или подключении Lichess. Триггер «10M партий» был задуман как
архитектурный.

В KS-1893 эта картина **сломалась эмпирически**: на 4.14M строк
`archive_game_positions` (1.4 GB с индексами) импорт TWIC замедлился в **30×**,
запросы `/tree` стали падать на ping timeout. PK-индекс размером 303 MB
оказался в **3.3× больше** `shared_buffers = 91 MB` на db.t3.micro.

ADR-027 (KS-1899) дал ответ «scale-up до t3.large» — это разблокирует
инцидент. Но координатор поставил архитектурный вопрос: **раз порог
«10M партий → Phase C» не соответствует реальности на 4M, может,
архитектура хранилища требует пересмотра, а не только сайзинга?**

### 1.2 Что мы знаем о профиле данных

Источники: `packages/archive-db/prisma/schema.prisma`, ADR-013 §8, ADR-014 §1.

#### Таблицы и их роль

| Таблица | Роль | Mutability | Размер сейчас |
|---|---|---|---|
| `archive_sources`, `archive_imports` | Каталог источников и журнал импортов | Mutable, низкий объём | < 1 MB |
| `archive_games` | Метаданные партий + PGN. Дедуп через `contentHash UNIQUE` | Insert + soft-delete; **транзакционная семантика дедупа критична** | ~400 MB на ~150k партий |
| `position_stats` | Агрегат `(positionKey, nextMoveUci, bucket)` → `{whiteWins, draws, blackWins, total, avgElo}` | Mutable in-place; **derivative**: уже сейчас пересчитывается из `archive_game_positions` в `rebuild-position-stats.ts` | ~600 MB / 3.56M строк |
| `archive_game_positions` | Денормализованный индекс «позиция → game_id» с фильтрами | **Immutable после импорта** (per ADR-014 §1.2 «без foreign key, не удаляем партии в рантайме») | 1.4 GB / 4.14M строк |

#### Профиль запросов

1. **`GET /api/archive/tree`** — `WHERE position_key=? AND bucket=? ORDER BY total DESC LIMIT 12`. Hot path, кэшируется в Redis. На 100% запросов это **point lookup + index range scan top-12** по `position_stats`.
2. **`GET /api/archive/games?fen=…`** — keyset-pagination по `archive_game_positions` с двумя сортировками (recent / topElo). На 100% — **prefix scan + ранний LIMIT**.
3. **`GET /api/archive/games/:id`** — простой PK lookup в `archive_games`.
4. **Импорт TWIC** — для каждой партии: 40 INSERT в `archive_game_positions` (insert-only) + 40 UPSERT в `position_stats`.

#### Ключевые архитектурные свойства данных

- **`archive_game_positions` — append-only after import.** Записи не обновляются, не удаляются. Это **сильное свойство**, упрощающее storage-выбор.
- **`position_stats` — derivative.** Может быть полностью восстановлен сканом `archive_game_positions`. Pipeline `rebuild-position-stats.ts` уже это делает.
- **`archive_games` — единственная транзакционная таблица архива.** Дедуп через `contentHash UNIQUE` нельзя свести к eventual consistency без потери гарантии.
- **Read-heavy** после импорта. TWIC выходит раз в неделю; между выпусками 99.9% времени — чтение.
- **Концентрация чтения** на горячих позициях (стартовая, типовые миттельшпили). Long tail — позиции глубоко в дереве с total < 5.

### 1.3 Что осталось от ADR-013 после KS-1893

| Положение ADR-013 | Подтверждено | Опровергнуто |
|---|---|---|
| Phase A до ~5M партий на PG при `shared_buffers ≥ 4 GB` | ✓ — на адекватном RAM работает | требование `shared_buffers ≥ 4 GB` **никогда не было выполнено** в проде |
| Триггеры Phase B (30M) и Phase C (100M или Lichess) | не достигнуты | проверить нельзя — PG не получил ресурсов |
| `ArchiveStatsRepository` спроектирован переключаемым (§10.C.4) | ✓ | — |
| ClickHouse оправдан как **secondary** с Phase C | ✓ | — |
| ClickHouse как **primary** не подходит из-за дедупа | ✓ | — |
| DuckDB не подходит как primary (single-writer) | ✓ | — |

**Главный вывод:** инцидент KS-1893 — **операционный** (сайзинг против ADR-013
требований), а не архитектурный. Но он создал **повод** пересмотреть, не
изменилось ли архитектурное решение в свете того, что мы теперь знаем о
профиле данных и реальных ограничениях проекта.

### 1.4 Ограничения проекта, влияющие на архитектурный выбор

- **Бюджет на инфраструктуру ограничен.** Это входной параметр, а не операционная оценка — он влияет на выбор между «больше железа» и «специализированное хранилище».
- **Готовность принять архитектурную сложность.** Команда подтвердила готовность к сложным реализациям при наличии архитектурного выигрыша. Это означает, что custom-storage и specialized-engine не отсекаются операционным критерием «сложно поддерживать».
- **Только TWIC сейчас.** Подключение Lichess/ChessCom — гипотетическое, без срока. Сайзить под этот сценарий сегодня — premature.

---

## 2. Фазовая архитектурная модель

### Фаза 0 — текущее состояние

PG-monolithic, сайзинг ниже требований ADR-013 §10.A. Триггер выхода —
KS-1893 (операционный сбой).

### Фаза 1 — восстановление сайзинга

PG-monolithic, тот же архитектурный shape, **корректный сайзинг**
согласно ADR-027. Это **не выбор стратегии**, а исправление недокомплекта.
Архитектурно ничего нового.

Все четыре таблицы остаются в PG, дедуп через `contentHash UNIQUE`,
индексы и партиционирование — нативные PG-инструменты.

### Фаза 2 — переход на специализированное хранилище под immutable-профиль

**Storage decomposition по mutability-классам:**

| Таблица | Хранилище | Обоснование |
|---|---|---|
| `archive_sources`, `archive_imports`, `archive_games` | **PG (остаётся source-of-truth)** | Транзакционный дедуп `contentHash UNIQUE`, ad-hoc запросы метаданных, soft-delete источника |
| `archive_game_positions` | **Append-only sealed segments на диск (SST-format)** | Match с immutable-природой данных |
| `position_stats` | **Sealed segments**, derivative от `archive_game_positions` | Уже сейчас derivative в `rebuild-position-stats.ts` |
| Secondary sort orders (`played_at DESC`, `avg_elo DESC`) | **Отдельные sealed segments** с переупорядоченными ключами | Match с paradigm «sorted on-disk» |

**Архитектурные компоненты Phase 2:**

| Компонент | Роль |
|---|---|
| **Manifest** | Атомарный список активных segment-файлов. Single point of consistency между импортами. Atomic rename pattern. |
| **Segment writer** | Sort buffer → bloom-filter + sparse-index + zstd-блоки. Запись завершается записью footer'а с magic — segment без footer'а считается corrupt. |
| **Segment reader** | Mmap + bloom-check + bsearch по sparse-index + range-scan по prefix. |
| **Compactor** | Periodic k-way merge активных segments в один. Triggered по числу сегментов или общему размеру. Compaction не удаляет старые segments inline — manifest помечает для GC. |
| **Recovery** | На старте: проверка manifest checksums + bloom verify + sample reads. Partial-written segment → discard через manifest. |
| **`SstArchiveStatsRepository`** | Реализация интерфейса `ArchiveStatsRepository` (ADR-013 §10.C.4). API не меняется. |

### Фаза 3 — distributed / multi-region

Триггер: 100M+ позиций ИЛИ multi-region requirement ИЛИ нужны параллельные
writers (TWIC + Lichess + ChessCom одновременно).

Кандидаты:
- **ClickHouse-secondary** (как в ADR-013 §10.C, аргументы остаются в силе).
- **Sharded segments** — горизонтальный шардинг segment-файлов по `hash(position_key) mod N`.
- **CockroachDB / YugabyteDB** — distributed PG-compatible (см. §3 для оценки).

Решение откладывается до триггера. Архитектура `ArchiveStatsRepository`
позволяет добавить четвёртую реализацию рядом со SST/PG/ClickHouse.

### Триггеры между фазами (архитектурные, не временные)

| Переход | Триггер |
|---|---|
| 0 → 1 | KS-1893 (операционный сбой сайзинга) |
| 1 → 2 | Достижение 30M строк `position_stats` ИЛИ принятый приоритет cost-минимизации над zero-disruption |
| 2 → 3 | 100M+ строк ИЛИ multi-region ИЛИ параллельные writers ИЛИ scan-heavy аналитика становится продуктовым требованием |

---

## 3. Архитектурные оси сравнения хранилищ

Анализ оставшихся вариантов — **не для рекомендации сроков**, а для
обоснования, почему именно SST-сегменты выбраны для Phase 2 и почему
другие — для других фаз или нет.

### Ось A. Match с природой данных

| Вариант | Mutability storage | Match с immutable archive_game_positions |
|---|---|---|
| **PG (Фаза 1)** | Mutable (UPDATE/DELETE поддерживаются) | OK — overhead на неиспользуемой mutability (MVCC, vacuum, fillfactor) |
| **LMDB embedded** | Mutable B+tree | OK — тот же overhead |
| **ClickHouse** | `ReplacingMergeTree` — eventual mutability | OK на агрегатах, **сомнительно** на дедупе `archive_games` |
| **SST sealed segments (Фаза 2)** | Immutable after seal | **Native fit** — sealed = запись закрыта, не обновляется. Совпадает с природой данных 1:1. |
| **CockroachDB** | Mutable distributed KV | Тот же overhead + distributed consensus, который мы не используем |
| **TimescaleDB** | Mutable + time-partitioning | Не наш partition key (мы партиционируем по hash(position_key), не по времени) |
| **Aurora** | Тот же PG | OK — те же характеристики что Фаза 1 |

### Ось B. Транзакционный дедуп (нужен для `archive_games`)

| Вариант | Гарантия `contentHash UNIQUE` |
|---|---|
| PG, Aurora, CockroachDB, YugabyteDB | Полноценная (B-tree unique constraint) |
| LMDB embedded | Полноценная (через `dupsort=false`) |
| ClickHouse | **Нет** — `ReplacingMergeTree` асинхронен, окно дублей |
| SST sealed segments | **Нет** — append-only без unique check на write |

**Вывод:** для `archive_games` транзакционный дедуп критичен. Любая Phase 2/3
архитектура **обязана сохранить PG (или эквивалент с unique constraint) для
этой таблицы**. SST/CH — только для derivative и immutable.

### Ось C. Concurrency для импорта

| Вариант | Concurrent writers |
|---|---|
| PG, Aurora | Multi-writer (через MVCC); один импорт TWIC = один воркер, ОК |
| LMDB | **Single-writer** на всю БД. При параллельных Lichess + ChessCom + TWIC потребуется очередь-сериализатор |
| ClickHouse | Multi-writer на одной таблице через batch INSERT |
| SST sealed segments | **Естественная параллелизация** — каждый импортер пишет свой segment-файл, конфликта нет |
| CockroachDB | Multi-writer через distributed consensus (overhead на нашем масштабе) |

**Вывод:** SST-сегменты архитектурно **более подходящи** для будущих
параллельных импортеров, чем LMDB.

### Ось D. Storage layout control

| Вариант | Контроль формата |
|---|---|
| PG, Aurora, CockroachDB | Opaque (page format, TOAST, индексы) |
| LMDB | Opaque B+tree |
| ClickHouse | Полу-прозрачный (MergeTree parts, кодеки выбираются) |
| SST sealed segments | **Полный** — формат, layout, ordering, compression выбираем мы |
| TimescaleDB | Opaque + columnar compression на старых chunks |

Контроль формата важен для:
- Schema evolution — мы знаем точно, что меняется при изменении версии.
- Размер на диске — выбор compression (zstd на блоках) под наш профиль.
- Reproducibility — дамп = байт-в-байт бинарь, нет surprise-зависимостей от версии engine.

### Ось E. Recovery после crash importer'а

| Вариант | Recovery контракт |
|---|---|
| PG, Aurora | Native crash-safe (WAL replay, MVCC) |
| LMDB | Native crash-safe (MVCC + write-ahead log) |
| ClickHouse | Eventual recovery через replication |
| SST sealed segments | **Atomic manifest swap**. Partial segment → не активирован в manifest → discard. Failure-mode проще, чем у любого mutable engine. |
| CockroachDB | Native через Raft replication |

### Ось F. Reversibility (откат на предыдущую фазу)

| Переход | Reversibility |
|---|---|
| Фаза 1 ↔ Фаза 0 | Тривиальный (modify-instance) |
| Фаза 1 → Фаза 2 | Bidirectional. Backfill SST из PG `archive_game_positions` через scan; обратно — bulk insert из SST scan |
| Фаза 2 → Фаза 3 | Backfill любого target-storage через scan SST |

Архитектура `ArchiveStatsRepository` (ADR-013 §10.C.4) **по построению**
обеспечивает reversibility между фазами на уровне API: фронт не знает,
какая реализация активна.

---

## 4. Соответствие профилю данных Phase 2 (SST-сегменты)

| Свойство данных | Свойство SST-storage |
|---|---|
| `archive_game_positions` immutable после импорта | Sealed segments — записал и не трогаешь |
| Lookup по 16-байт ключу `position_key` | Bloom filter + sparse index = 2 page-fetch worst case |
| Range scan по prefix `(position_key, bucket)` с LIMIT | Sorted on-disk = continuous read, ранний break по LIMIT |
| Read-heavy между импортами | Mmap в OS page cache, shared между процессами reader'ов |
| `position_stats` — derivative | Пересчёт = sequential scan + group-by + write fresh segment |
| Импорт раз в неделю окнами по 30–60 мин | Append-only segment per import, никакой UPDATE-pressure |
| Концентрация чтения на горячих позициях | Bloom filter отсекает миссы; sparse index указывает точно на нужный page |

Архитектурно **профиль данных и SST-формат совпадают** — это сильнейший
аргумент за Phase 2 при принятии решения о переходе.

---

## 5. Архитектурные риски Phase 2 и митигация

| Риск | Митигация |
|---|---|
| Manifest corruption | Versioned manifest + atomic `rename(2)` + checksum. Restore из предыдущей версии manifest. |
| Partial segment write при kill -9 | Footer пишется последним с magic; reader без footer = segment невалиден, manifest его не активирует. |
| Schema drift между импортами | Version в segment-header. Reader поддерживает N последних версий до compaction. Compaction нормализует все active segments к текущей версии. |
| Bloom false-positive | Параметр target FP rate 0.1% → ~12 бит/key. Деградация — 1 лишний page read, не отказ. |
| Bug в reader даёт молчаливо неверные результаты | CRC на каждом блоке. Differential testing против PG-реализации на этапе перехода (сравнение результатов запросов). |
| Backup non-atomic во время compaction | Backup snapshot = manifest + все segments на момент `t`. Compaction не удаляет старые segments inline, только маркирует в manifest для GC после snapshot'а. |
| Загрузка bloom + sparse index в RAM на крупных segments | Lazy-load: bloom + index первой страницы — на startup; остальное — by demand через mmap. |

---

## 6. Reversibility между фазами

### Фаза 0 → Фаза 1

Modify-instance RDS. 5–10 минут даунтайма. Откат тем же действием.

### Фаза 1 → Фаза 2 (миграция)

1. Backfill: scan PG `archive_game_positions` → write SST segment.
2. Differential check: case-by-case сравнение запросов через два репозитория за период проверки.
3. Cutover: env-флаг `ARCHIVE_STATS_BACKEND=sst`. Фронт не замечает.
4. PG `archive_game_positions` остаётся как cold storage до confidence period.

### Фаза 2 → Фаза 1 (откат)

1. Bulk insert из SST scan в PG `archive_game_positions` (если cold storage не сохранили).
2. Env-флаг `ARCHIVE_STATS_BACKEND=postgres`.
3. SST-каталог архивируется на S3.

### Фаза 2 → Фаза 3 (escalation)

1. Add `ClickHouseArchiveStatsRepository` или `ShardedSstArchiveStatsRepository`.
2. Backfill из SST (sequential scan быстрее, чем PG-export).
3. Cutover env-флагом.

Reversibility во все стороны обеспечена тем, что **`archive_games`
остаётся в PG как source-of-truth** на любой фазе. Любой derivative
storage может быть восстановлен из `archive_games.pgn` через тот же
import pipeline.

---

## 7. Соответствие переключаемому контракту ADR-013 §10.C.4

ADR-013 заложил интерфейс:

```ts
interface ArchiveStatsRepository {
  getTopMoves(positionKey, bucket, limit): Promise<...>;
  getGamesByPosition(positionKey, bucket, cursor, sort): Promise<...>;
  upsertPositionStats(rows): Promise<...>;
  // ...
}
```

Сейчас существует одна реализация — `PostgresArchiveStatsRepository`
(Фаза 1). Phase 2 добавляет `SstArchiveStatsRepository` рядом, выбор
через env-флаг. Phase 3 добавляет третью.

**Архитектурный страховой полис**: выбор «где хранить позиции» отделён от
«как пользоваться позициями». Любая будущая миграция — замена реализации,
не переписывание сервиса. Это архитектурное решение принято в ADR-013 и в
ADR-028 не пересматривается.

---

## 8. Что НЕ меняется в любой фазе

- **`archive_games` остаётся в PG** на всех фазах до Phase D из ADR-013
  (50M+ партий с продуктовым требованием на distributed). Транзакционный
  дедуп через `contentHash UNIQUE` — гарантия, которую мы не разменяем.
- **Контракт `ArchiveStatsRepository`** — без изменений.
- **API для фронта** — без изменений.
- **`archive_kingside` физически отдельна** от основной БД — без изменений.

---

## 9. Решение

Архитектор предлагает фазовую модель с двумя сценариями для пользователя.
Выбор сценария — продуктово-стратегическое решение, не архитектурное;
архитектурно оба сценария валидны.

### Сценарий A — приоритет zero-disruption

**Phase 0 → Phase 1.** Сохранить PG-monolithic, исправить сайзинг по
ADR-027.

Сильные стороны:
- Архитектура не меняется — все существующие инструменты, runbook'и,
  бэкапы продолжают работать.
- Reversibility тривиальна (modify-instance).
- Phase 2 не отменяется как опция в будущем при срабатывании триггера
  «30M строк» или «приоритет cost-минимизации станет приоритетным».

Когда оправдан: пока бюджет на инфраструктуру не является ограничивающим
фактором, и нет продуктового триггера для Phase 2.

### Сценарий B — приоритет cost + архитектурная чистота

**Phase 0 → Phase 1 → Phase 2.** Сначала разблокировать KS-1893
(Phase 1), затем — переход на SST-сегменты для immutable-таблиц
(Phase 2).

Сильные стороны:
- Match storage с природой данных (sealed = immutable, derivative =
  rebuild from scan).
- Полный контроль над форматом.
- Естественная параллелизация для будущих параллельных импортеров.
- Снимает зависимость от RDS-сайзинга для archive_game_positions /
  position_stats — масштабируется через storage, не через RAM.

Когда оправдан: бюджет — ограничивающий фактор; команда готова к
архитектурной сложности; есть продуктовый triggеr для Phase 2 в обозримом
горизонте.

### Что не предлагается как Phase 2

- **LMDB embedded** — match с профилем хуже, чем у SST (LMDB mutable, наши
  данные immutable; LMDB single-writer, SST естественно multi-writer).
  Может быть рассмотрен как **альтернативная Phase 2**, если
  кардинально упрощённая модель «один движок без manifest» важнее
  match'а с профилем.
- **ClickHouse** — оправдан как **Phase 3 secondary** (ADR-013 §10.C),
  не как Phase 2. Аргументы: column-store оверкил для point-lookup
  профиля, ClickHouse сам по себе — кластер. Имеет смысл при scan-heavy
  аналитике или 100M+ объёме.
- **CockroachDB / YugabyteDB / Aurora / TimescaleDB** — не дают
  архитектурного выигрыша на нашем профиле; рассматриваются только
  при triggers Phase 3 (multi-region, scan-heavy и т.п.).
- **Custom mmap-format с perfect hash** — отдельная архитектура от SST.
  SST даёт те же свойства (compressed, mmap, fast lookup) при стандартной
  индустриальной модели (LSM + manifest), без full-custom инжиниринга
  hash table eviction strategy. Перепрыгивание через SST на полностью
  custom format архитектурно не оправдано.

---

## 10. Триггеры пересмотра ADR-028

ADR пересматривается при:

1. **Принято решение Сценарий B** — обновить статус ADR на
   «Принято: Сценарий B», запустить отдельную задачу на Phase 2
   реализацию.
2. **30M строк `position_stats` при Сценарии A** — реализовать
   партиционирование (KS-1900) ИЛИ перейти на Сценарий B. Триггер
   решения, не автоматический переход.
3. **100M строк ИЛИ Lichess подключен** — обязательная Phase 3
   (отдельный ADR с детальным выбором между ClickHouse / sharded SST /
   distributed SQL).
4. **Продуктовое требование на scan-heavy аналитику** — Phase 3
   (ClickHouse) даже без 100M строк.
5. **Multi-region requirement** — Phase 3 (distributed SQL).
6. **Параллельные импортеры** (Lichess + ChessCom + TWIC одновременно) —
   при Сценарии A триггер на Phase 2 (SST естественно multi-writer);
   при Сценарии B уже решено.

---

## 11. Влияние на смежные ADR/задачи

| Документ | Статус | Действие |
|---|---|---|
| ADR-013 (план Phase A/B/C/D) | актуален | без изменений; пороги в силе |
| ADR-014 (`archive_game_positions`) | актуален | immutable-семантика, на которую опирается Phase 2, явно зафиксирована |
| ADR-018 (вынос архив-сервиса) | актуален | без изменений |
| ADR-027 (RDS sizing для Phase 1) | актуален | требуется в любом сценарии — это Phase 1 step |
| KS-1900 (партиционирование PG) | условно актуален | реализуется при Сценарии A на триггере 30M строк; неактуален при Сценарии B (в SST партиционирование встроено как multi-segment) |

---

## Приложение A. Декомпозиция компонентов Phase 2

Не для оценки сроков — для понимания **что входит в Phase 2 архитектурно**.

```
apps/archive-service/src/sst/
  manifest/
    Manifest          — атомарный список active segments
    ManifestStore     — read/write/swap с atomic rename
  writer/
    SegmentWriter     — sort buffer, bloom, sparse index, zstd, footer
    SecondaryWriter   — secondary indices (recent, top_elo)
  reader/
    SegmentReader     — mmap, bloom check, bsearch, range scan
    MultiSegmentReader — k-way merge для query поверх N segments
  compactor/
    Compactor         — periodic merge, manifest update
  recovery/
    RecoveryService   — startup integrity check
  repo/
    SstArchiveStatsRepository — impl ArchiveStatsRepository
```

Все компоненты — за интерфейсом `ArchiveStatsRepository`; основной API
архива не меняется.

---

## Приложение B. Что отвергнуто и почему (ссылки на ADR-013)

| Альтернатива | Аргументы остаются в силе из ADR-013 |
|---|---|
| ClickHouse-as-primary | §«Альтернативы»: дедуп `contentHash` через ReplacingMergeTree асинхронен, окно дублей при backfill |
| DuckDB-as-primary | §«Альтернативы»: single-writer, не конкурентный с импортером и читателем |
| Lichess Polyglot `.bin` как формат | §«Альтернативы»: weight без win/draw/loss, нет avgElo/lastSeenAt/фильтров |

Эти варианты в ADR-028 повторно не разбираются — выводы ADR-013
действительны.
