# ADR-113: Страница тренера — курсы, лекции (live/запись/расписание), задел под голос/видео

**Статус:** Предложено
**Дата:** 2026-06-06
**Задача:** KS-3782
**Связанные ADR:** [ADR-054](./054-user-courses-merge-into-system-models.md), [ADR-110](./110-live-analysis-broadcast.md), [ADR-111](./111-live-analysis-full-broadcast.md), [ADR-112](./112-live-analysis-per-analysis-binding.md)

## 1. Контекст

### Что уже есть

- **Авторские курсы** (`Course` с `ownerId IS NOT NULL`, `isPublic`). На странице игрока (`PlayerProfilePage` / `GET /players/:username/courses`) уже отдаётся список публичных курсов автора. Структура курса: `Course` → `Lesson` → `LessonStep`, есть `UserCourseProgress`.
- **Live-трансляция анализа** (ADR-110/111/112). Сейчас live эфемерна: при закрытии `status='closed'`, Redis TTL 24ч, аннотированный PGN и история ходов теряются. Записи нет. Расписания нет.
- `User` сейчас **не имеет** признака «тренер». Есть только `isBot`/`isSynthetic`/`isHidden` — служебные роли.

### Что нужно

1. Отдельная страница «тренер» с курсами + лекциями (live/запись/расписание).
2. Постоянная **запись live-лекций с темпом** — ученик может пересмотреть с теми же интервалами.
3. **Расписание** будущих лекций.
4. Задел под **голос/видео** — синхронный с событиями доски (только дизайн, реализация — отдельный эпик).

### Что НЕ в скоупе ADR-113

- Платный доступ / монетизация (вероятная следующая итерация; сейчас весь контент бесплатный).
- Чат во время лекции (text-chat зрителей с автором). Текущая модель LiveAnalysis зрителей read-only.
- Транскодинг видео, CDN раздача, DRM.
- Push-нотификации о начале запланированной лекции.
- Перевод системных курсов на «тренерскую модель» — системные курсы остаются за `Course.ownerId IS NULL`.

## 2. Решение

### 2.1 Идентификация тренера (§1 задачи)

**Решение: нет отдельной роли «тренер». Тренер = пользователь с хотя бы одним публичным `Course (ownerId=me, isPublic=true)` ИЛИ хотя бы одной активной/запланированной/записанной `Lecture`.**

Аргументы:
- Не плодим лишние сущности. Признак выводится за O(1) запроса `EXISTS (...)`.
- Не нужен механизм «подать заявку → одобрить» — пользователь сам решает, что хочет публиковаться, выложив курс или анонсировав лекцию.
- Анти-абуз: уже есть `isHidden` для админ-блокировки.

**Где живёт URL.** `/coach/:username` — отдельный маршрут, рендерит `CoachProfilePage`. Если у пользователя нет ни одного публичного курса/лекции — отдаём 404 (или редирект на `/player/:username`). Внутри `/player/:username` показываем бейдж «Тренер · смотреть курсы и лекции» с ссылкой на `/coach/:username` (бейдж только если есть контент).

Альтернатива «всё внутри `/player/:username` отдельной вкладкой» — отвергнута: страница игрока уже перегружена (рейтинги, последние партии, друзья), отдельный URL семантичнее для шаринга и SEO.

### 2.2 Зонтичная сущность Lecture (§6 задачи)

**Решение: вводим новую модель `Lecture` как зонтичную сущность над тремя состояниями.** Существующая `LiveAnalysis` остаётся как технический сеанс, к ней привязывается `Lecture` с FK.

```prisma
model Lecture {
  id              String         @id @default(uuid()) @db.Uuid
  ownerId         String         @map("owner_id") @db.Uuid
  owner           User           @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  title           String
  description     String?        @db.Text
  /// scheduled | live | recorded | cancelled
  status          LectureStatus  @default(scheduled)
  /// Когда лекция запланирована начаться (расписание). Для live без анонса
  /// = createdAt, для recorded — момент старта; см. §2.5.
  scheduledAt     DateTime?      @map("scheduled_at")
  /// Когда фактически стартовала (трансляция началась).
  startedAt       DateTime?      @map("started_at")
  /// Когда завершилась (трансляция закрылась).
  endedAt         DateTime?      @map("ended_at")
  /// Длительность записи в мс (для UI «1ч 23м», для seek-бара).
  durationMs      Int?           @map("duration_ms")
  /// Видимость: public — индексируется и показывается на /coach/:username;
  /// unlisted — доступна только по прямой ссылке.
  visibility      LectureVisibility @default(public)
  /// Привязка к live-сеансу. Live → live-аналитика жива; recorded → не нужна.
  liveAnalysisId  String?        @map("live_analysis_id") @db.Uuid
  liveAnalysis    LiveAnalysis?  @relation(fields: [liveAnalysisId], references: [id], onDelete: SetNull)
  /// Привязка к записи событий. NULL до конца лекции.
  recordingId     String?        @map("recording_id") @db.Uuid
  recording       LectureRecording? @relation(fields: [recordingId], references: [id], onDelete: SetNull)
  createdAt       DateTime       @default(now()) @map("created_at")
  updatedAt       DateTime       @updatedAt @map("updated_at")

  @@index([ownerId, status, scheduledAt])
  @@index([status, scheduledAt])           // календарь будущих лекций
  @@map("lectures")
}

enum LectureStatus {
  scheduled
  live
  recorded
  cancelled
  @@map("lecture_status")
}

enum LectureVisibility {
  public
  unlisted
  @@map("lecture_visibility")
}
```

**Жизненный цикл:**
- `scheduled` → автор анонсировал. Карточка в «Будущие». Может быть отменена (`cancelled`).
- При нажатии «Начать сейчас» (или авто-старт по `scheduledAt`?) — создаётся `LiveAnalysis` (ADR-110/112) → `Lecture.liveAnalysisId` заполняется, status=`live`, `startedAt=now`.
- При завершении трансляции — фоновый воркер фиксирует `endedAt=now`, конвертирует Redis-историю + ходы + state-patch'и в `LectureRecording` (см. §2.3), `Lecture.recordingId` заполняется, status=`recorded`.
- Авто-старт по scheduledAt — **нет на MVP**. Тренер жмёт «Начать» сам, scheduler-job только показывает «Скоро начало». Иначе автор может опоздать или передумать — нужна семантика «отложить/отменить», что усложняет MVP.

**Связь с `Course`.** Прямой связи нет — лекция не привязана к курсу. На странице тренера два отдельных раздела. В будущем можно ввести `lecture.courseId?` (опциональный), чтобы лекция была «к такому-то курсу» — но не сейчас.

### 2.3 Запись лекций с темпом (§2 задачи)

**Что значит «с темпом».** Не покадровый видеоряд, а воспроизведение **событий доски** с теми же интервалами:
- t=0: ход e4
- t=10000ms: комментарий «вот этот ход слабый» (т.е. `state-patch` с обновлённым PGN, в котором появился комментарий)
- t=70000ms: ход e5
- ...

#### 2.3.1 Что писать

Каждое событие на канале `/live-analysis` уже типизировано (ADR-111). Запись = упорядоченная JSON-лента событий с timestamp относительно `startedAt`:

```ts
type RecordedEvent =
  | { t: number; type: 'move'; uci: string; fen: string; ply: number }
  | { t: number; type: 'state-patch'; pgn: string; headers?: Record<string,string>; currentPly?: number; orientation?: 'white'|'black' }
  | { t: number; type: 'reset'; startingFen: string }
  | { t: number; type: 'closed'; reason: 'by_owner'|'inactivity' };
```

Не пишем: `subscribe`/`unsubscribe`/`viewers`/`error` — это серверные служебные, к воспроизведению неотносимы.

#### 2.3.2 Объём

- `move` ≈ 50 байт (UCI + FEN + ply).
- `state-patch` ≈ размер PGN. PGN растёт по мере лекции: новые ходы, варианты, комментарии. Средний PGN в середине часовой лекции ≈ 5–20 KB.

Грубая оценка 1ч лекции:
- ~30 ходов автора (один ход в две минуты в среднем для разбора) × 50 байт = 1.5 KB.
- ~120 state-patch'ей (комментарии, NAG, варианты — каждые 30 сек) × средний 10 KB = 1.2 MB.
- Полная лента — порядка **1–2 MB на час**.

После gzip (PGN жмётся ~5×) — **200–400 KB на час**. Терпимо для PostgreSQL JSONB / TEXT-колонки.

#### 2.3.3 Где хранить

**Решение: PostgreSQL колонка `events` (JSONB)** в отдельной таблице `LectureRecording`. Не S3, потому что:
- Объём в единицы MB на запись, на 1000 лекций — единицы GB. RDS справится.
- Атомарность с метаданными лекции, без отдельного транспорта/credentials.
- Бекап вместе с БД.
- При росте >100 MB на запись — выносим в S3, но это сценарий «лекция на 12 часов с подробным разбором», маловероятный.

```prisma
model LectureRecording {
  id           String   @id @default(uuid()) @db.Uuid
  ownerId      String   @map("owner_id") @db.Uuid
  owner        User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  /// 1-к-1 с Lecture (на стороне Lecture поле `recordingId`).
  /// Технически 1-к-N: можно перезаписать лекцию, но MVP — одна запись.
  lectureId    String?  @unique @map("lecture_id") @db.Uuid
  startingFen  String?  @map("starting_fen")
  orientation  String   @default("white")
  /// Длительность в мс — для seek-бара без полной загрузки событий.
  durationMs   Int      @map("duration_ms")
  /// JSONB-массив RecordedEvent[]. На больших лекциях gzip снизит объём,
  /// но JSONB и так компактен; включаем `toast` на колонке (PG-storage).
  events       Json     @db.JsonB
  createdAt    DateTime @default(now()) @map("created_at")

  @@index([ownerId, createdAt])
  @@map("lecture_recordings")
}
```

#### 2.3.4 Тайминг

**Запись в реальном времени.** Гейтвей при каждом валидированном эвенте автора (`move`, `state-patch`, `reset`) добавляет запись в Redis-список `lecture_recording:<liveAnalysisId>:events` с `t = Date.now() - startedAt`. На `closed`-эвенте фоновый воркер сохраняет JSONB в PG.

**Не нормализуем время.** «Темп тренера» — это часть UX: если он подумал 2 минуты, ученик видит ту же паузу. Сжимать паузы — отдельная фича (например, «играть со скоростью 2×»), реализуется на клиенте при воспроизведении.

#### 2.3.5 Persistence — когда писать в PG

**На каждый эвент пишем в Redis-список (быстро, atomic RPUSH).** В PostgreSQL — единожды при `closed`, отдельным воркером. Не на каждое событие — не нужны 120 INSERT в минуту на каждую лекцию.

**Резерв при крахе сервиса.** Если процесс упал между Redis и финальным сохранением в PG — есть Redis-снапшот, на старте воркер видит висящие записи и допишет (по slug-у трансляции). Этот механизм похож на cleanup-job из ADR-110 (закрытие активных по таймауту).

#### 2.3.6 Воспроизведение

**Отдельная страница `/lectures/:lectureId`** для recorded-лекций. Для live — `/live/:slug` (как сейчас).

`LectureReplayPage` — обёртка над `AnalysisPage` с новым режимом `liveBroadcast={replayId, mode:'replay'}`:
- На mount загружаем `GET /lectures/:id/recording` — получаем `events[]` (либо paginated через `?from=t&to=t` если оптимизировать; на MVP — весь массив сразу).
- Локальный плеер: play/pause/seek/speed (1×/1.5×/2×). На каждый tick применяет следующее событие — то же `applyLivePgn`/`applyMove`, что и в live-режиме (KS-3750/KS-3751).
- Seek: при перемотке к моменту `t` находим последний `state-patch` или `reset` до `t`, применяем его как baseline, затем накладываем `move`/`state-patch` между ним и `t`.

Локальные эксперименты зрителя — те же, что в live (свой fork, кнопка «вернуться»). Никаких различий поведения.

### 2.4 Расписание (§3 задачи)

**Модель** — поле `Lecture.scheduledAt` (см. §2.2). Отдельной таблицы `ScheduledLecture` не нужно — те же лекции, просто `status='scheduled'`.

**REST:**
- `POST /lectures` (JwtAuthGuard) — создать запись со `status='scheduled'`, `scheduledAt`, `title`, `description?`. Возвращает `Lecture`.
- `PATCH /lectures/:id` — редактировать (title, description, scheduledAt), `cancel`.
- `POST /lectures/:id/start` — старт live: создаёт `LiveAnalysis` (с `analysisId` если автор привязал), пишет `liveAnalysisId`, ставит status='live'. См. интеграцию с ADR-112: лекция привязывается либо к существующему `Analysis`, либо ad-hoc — кнопка на странице лекции «Начать»→ ведёт автора на `AnalysisPage` свежесозданного `Analysis`, дальше как обычно.
- `GET /coaches/:username/schedule?from=<iso>&to=<iso>` — публичный, без auth. Возвращает лекции автора с `status IN ('scheduled', 'live')` в диапазоне дат (по `scheduledAt`).
- `GET /coaches/:username/lectures?status=recorded&limit=20&offset=0` — паджинированный список записей.

**Авто-старт по `scheduledAt` — нет.** Только кнопкой автором. На странице ученика для `scheduled` лекции — кнопка «Подключиться» неактивна до тех пор, пока автор не нажал «Начать». На MVP без auto-link, без countdown timer-перехода. Это обходит риск «автор опоздал, автоматически создалась пустая трансляция».

**UI:** список карточек, не календарь. Календарь — over-engineering на MVP; «12 июня, четверг, 18:00» в виде секции в списке покрывает 90% UX. Календарь — отдельный follow-up если запросов будет много.

**Анонсы — публичные.** Privacy-настройка `visibility='unlisted'` спрятает запланированную лекцию из `/coaches/:username/schedule`, но прямой ссылке `/lectures/:id` ответит 200. Хорошо для приватных мини-уроков (для учеников по ссылке).

### 2.5 Страница тренера (§4 задачи)

**URL:** `/coach/:username`.

**Структура:**
```
─── метаданные ────
   аватар, имя, рейтинг, страна, "тренер" badge
─── о тренере ────
   bio (поле User добавим? — нет, на MVP берём существующее nothing; можно дописать description в lecture/course)
─── секция «Курсы» ────
   карточки публичных курсов автора (как сейчас на /player/:username/courses)
─── секция «Лекции» ────
   3 таба: «Расписание» (status=scheduled), «Сейчас в эфире» (status=live), «Записи» (status=recorded)
   - Расписание: future, отсортированы по scheduledAt asc
   - В эфире: отсортированы по startedAt desc (топ — самая свежая live)
   - Записи: пагинированный список, latest first
```

**Кто может смотреть.** Публично, без auth. Зрители-анонимы — могут видеть содержимое страницы; для подписки/уведомлений потребуется login (в будущем).

**Реюз `PlayerProfilePage`.** На `/player/:username` рендерим обычный профиль + бейдж «Тренер · открыть» если у пользователя есть публичные курсы/лекции. На `/coach/:username` — расширенный layout, фокус на контенте. Если на `/coach/:username` зашли к не-тренеру — 404.

### 2.6 Голос/видео — задел (§5 задачи)

**Это дизайн, не реализация.** Расписываю общую схему, оценку стоимости, ключевые развилки. Полный ADR — отдельным шагом, когда подойдёт срок.

#### 2.6.1 Что синхронизировать

Аудио (или видео) тренера + текущий timeline доски. Зритель должен слышать «вот этот ход слабый» в момент, когда на доске ходит фигура.

#### 2.6.2 Транспорт live

Три варианта по убыванию сложности:

| Вариант | Плюсы | Минусы | Стоимость инфры |
| --- | --- | --- | --- |
| SFU (mediasoup / livekit) | Низкая latency, один поток автора → N зрителей через сервер | Поддержка SFU сложна, нужен отдельный сервис, transcoding | $$ — отдельный ECS / EC2, выбор: self-hosted vs LiveKit Cloud |
| WHIP (WebRTC-HTTP Ingest) + HLS/DASH | Стандартизованно, можно через Cloudflare Stream / Mux | latency ~5-15с — критично для синхронности с доской | $ — pay-per-minute |
| Peer-to-peer WebRTC (без SFU) | Дёшево для 1-к-N до ~20 зрителей | Не масштабируется выше | 0 — нужен только signaling-server |

**Для MVP голос/видео — p2p WebRTC + сигналинг через существующий `/live-analysis` namespace.** Это покрывает «10–50 зрителей» из ADR-110 §2.7. При росте — переезд на SFU отдельным ADR.

#### 2.6.3 Запись для replay

Сервер пишет media-чанки (Opus для аудио, VP8/H.264 для видео) в S3, тегируя относительной временной меткой `t = chunkStartedAt - lectureStartedAt`. Сегментация — 5–10 секундными chunk'ами для удобства seek.

Альтернативно: записывать только у автора в браузере через `MediaRecorder`, по завершению — единый блоб в S3 + один `t_offset` относительно начала. Просто, но если автор уронил вкладку посередине — запись теряется. Серверная запись надёжнее, дороже.

**Решение для дизайна:** клиентская запись на MVP голос/видео-эпика, серверная — для следующей итерации, когда появятся реальные тренеры с критичной нагрузкой.

#### 2.6.4 Синхронизация

Общая временная шкала — `lecture.startedAt`. Все события доски пишутся с `t = now - startedAt`; media-chunks тоже. На воспроизведении — `<audio src=…>` или `<video>` элемент + наш replay-плеер шары один таймер. Браузер сам синхронизирует audio.currentTime с нашими тикерами.

#### 2.6.5 Что закладываем сейчас (чтобы будущий эпик не упёрся)

- Поле `Lecture.mediaUrl?` — S3 URL финальной записи. Заполняется в будущем эпике, на MVP всегда NULL.
- Поле `Lecture.mediaKind?` — `'audio' | 'video' | null`.
- Структура `RecordedEvent` (см. §2.3.1) уже включает `t`-поле — media-таймлайн подцепится без миграции.

#### 2.6.6 Стоимость и риски

- WebRTC требует STUN/TURN. У нас может не быть TURN, peer-to-peer не пройдёт за NAT'ом. Самый дешёвый TURN — Cloudflare TURN (бесплатно до лимита). Закладываем в будущий эпик.
- Запись аудио клиентом через `MediaRecorder` — стабильна в Chrome/Safari. Edge-cases на iOS (фоновая запись) — отдельный вопрос.
- Для видео — bandwidth у автора (upload 1 Mbps на низком HD). Не у всех есть. Сделать аудио основным режимом, видео — опциональное.

### 2.7 Связь с существующим (§6 задачи) — итог

- **LiveAnalysis** остаётся технической сущностью «активный сеанс трансляции». Не сливаем с Lecture (lifecycle разный: live — minutes-hours, recorded — permanent).
- **Course** — отдельная сущность, не пересекается с Lecture. Поле `lecture.courseId?` зарезервировано на будущее (объединение «лекция как часть курса»), но не вводится в MVP.
- **User** — без изменений (никакого `isCoach`).
- **Analysis** — лекция начинается с конкретного Analysis (как любая live-трансляция через ADR-112). Запись лекции хранит свой PGN (`recording.events` содержит все state-patch'и), но также можно делать ссылку `recording.sourceAnalysisId?` (опционально, для «открыть исходник в мастерской»).

### 2.8 Риски и подводные камни

1. **Объём `events` JSONB > 100 MB.** Срабатывает у тренеров-марафонщиков (8+ часов). Митигация: hard cap 50 MB на `events` (при превышении — записываем `truncated: true`, finalizer обрезает по последнему state-patch). Будущий перенос в S3 — отдельный ADR.

2. **Гонка «автор закрыл вкладку, не нажав Закончить».** Cleanup-job ADR-110 закроет live через 30 мин неактивности. Finalizer запустится автоматически. UX: автор увидит «лекция закрыта по таймауту» в списке. Приемлемо.

3. **Гонка «два POST /lectures/:id/start».** Партиал UNIQUE `(lectureId)` в `LiveAnalysis` (см. ADR-112 расширение) + idempotency: повторный start с активным `liveAnalysisId` возвращает existing.

4. **Запланированная лекция — переименование/перенос.** PATCH допускается до `status='live'`. После — поля title/description можно менять (для post-corrections), `scheduledAt` — заморожен.

5. **Запись зрителя при просмотре replay.** `viewers`-счётчик не нужен для recorded (это не live). Не светим — экономим CPU/Redis.

6. **Чужой URL `/lectures/:id` для `unlisted`-лекции.** Доступ работает (visibility — только про индексацию на `/coach/:username`), `GET /lectures/:id` возвращает 200. Это by design — позволяет тренеру шарить ссылку отдельным ученикам.

7. **Удаление автора → cascading lectures/recordings.** Cascade на User в обоих местах. История зрителей `/lectures/:id` обрывается. Альтернатива: «sealed» лекции остаются. Усложнение MVP — пропускаем, есть `isHidden` для админ-модерации.

8. **Replay одновременно у многих зрителей.** Каждый загружает `events` сам, локальный плеер. Никакой нагрузки на бэкенд кроме `GET /lectures/:id/recording` (отдаём JSONB). Можно кешировать через CloudFront для immutable записей.

9. **state-patch размер при записи.** Уже ограничено 256 KB (ADR-111). Если в середине лекции PGN раздулся до 250 KB и шёл 50 раз → 12.5 MB только этих патчей. Митигация: дельта-сжатие в воркере на финализации (между соседними state-patch'ами писать только diff). Откладываем — пока среднее не показывает проблему.

10. **Авторизация на старт лекции.** `POST /lectures/:id/start` — только владелец лекции. Привязка к `analysisId` — Analysis тоже должен быть владельцем (как в ADR-112).

11. **Lecture без recording (отменена/закрыта без действий).** `recordingId` NULL, в списке «Записи» не появляется. На странице лекции — «Запись недоступна».

## 3. Последствия

- **Backend.** Новые модели `Lecture`, `LectureRecording`, enum `LectureStatus`/`LectureVisibility`. Новый модуль `apps/api/src/lectures/`: controller + service + finalizer-job (scheduler @nestjs/schedule). Интеграция с `live-analysis`: gateway пишет события в Redis-список, при closed — воркер сохраняет в PG. Расширение `User`/`Course` связями (relations). Player-controller: новые `/coaches/:username/...` эндпоинты или объединить в `/players/...`.
- **Frontend.** Новая страница `CoachProfilePage` (`/coach/:username`). Бейдж «Тренер» на `PlayerProfilePage`. Новые страницы `LectureSchedulePage`/`LectureReplayPage` (replay = обёртка над `AnalysisPage` с режимом `liveBroadcast={lectureId, mode:'replay'}`). UI для «Создать запланированную лекцию» в профиле автора. Поверх `AnalysisPage` — кнопка «Начать лекцию» (выбор: новая запланированная либо привязка к существующей `scheduled`).
- **Shared types.** Новые типы `Lecture`/`LectureRecording`/`RecordedEvent`/`LectureStatus`/`LectureVisibility` + REST request/response.
- **DevOps.** Никаких новых сервисов. PostgreSQL диск растёт на ~единицы GB/1000 лекций. Нагрузка на Redis при записи — RPUSH события в список, минимальная.
- **QA.** Полные сценарии — конец §4.

## 4. Предлагаемая разбивка на эпики и задачи

### Эпик 1 — Страница тренера, MVP без записи и расписания

Цель: на `/coach/:username` видны курсы и активные live-трансляции; без планировщика, без replay. Покрывает базовый case «тренер ведёт сейчас».

- **KS-N01 [backend]** — Prisma миграция: модель `Lecture` (только enum status, минимальные поля: id, ownerId, title, scheduledAt?, startedAt?, endedAt?, durationMs?, status, visibility, liveAnalysisId?, recordingId?). FK на `LiveAnalysis` (SetNull) и `User` (Cascade). Индексы.
- **KS-N02 [backend]** — модуль `apps/api/src/lectures/`: `LecturesService`, `LecturesController`.
  - `POST /lectures/:id/start` (idempotent через unique constraint на liveAnalysisId WHERE status='live').
  - `POST /lectures` (создать scheduled).
  - `GET /coaches/:username/lectures?status=live`.
  - `GET /lectures/:id`.
- **KS-N03 [backend]** — расширить `LiveAnalysisService.closeBySlug` хуком: при закрытии находим Lecture с `liveAnalysisId=this` и `status='live'`, ставим `endedAt=now`. Без записи (Эпик 2).
- **KS-N04 [backend]** — расширить `player.controller`: `GET /players/:username` возвращает `isCoach: boolean` (производное от EXISTS lecture/course с публичной видимостью). Используется для бейджа.
- **KS-N05 [frontend]** — страница `CoachProfilePage` (`/coach/:username`): метаданные пользователя, секция курсов (реюз существующего `GET /players/:username/courses`), секция «В эфире» (через `GET /coaches/:username/lectures?status=live`).
- **KS-N06 [frontend]** — бейдж «Тренер» на `PlayerProfilePage`, ссылка на `/coach/:username`.
- **KS-N07 [frontend]** — кнопка «Начать лекцию» на `AnalysisPage` автора: модалка «Создать новую лекцию (с расписанием или сразу)» / «Связать с запланированной». На MVP только «Создать новую и сразу начать».
- **KS-N08 [qa]** — smoke: открыл анализ, начал лекцию, на странице тренера видна live-карточка; зритель открыл — попал в обычный live-flow ADR-110/111.

### Эпик 2 — Запись лекций с темпом

- **KS-N09 [backend]** — Prisma миграция: модель `LectureRecording` (поля §2.3.3). Расширение `Lecture.recordingId`.
- **KS-N10 [backend]** — recorder-сборщик в `LiveAnalysisGateway`: на каждый валидированный `move`/`state-patch`/`reset` от автора `RPUSH lecture_recording:<liveAnalysisId>:events {t, type, payload}` (Redis-список, TTL 26ч — на час больше state TTL, чтобы finalizer успел при последней секунде).
- **KS-N11 [backend]** — finalizer: при `LiveAnalysisService.closeBySlug` (любая причина) — для лекции с этим `liveAnalysisId` собираем events из Redis, парсим, валидируем размер (≤50 MB), пишем `LectureRecording`, выставляем `Lecture.recordingId`, `durationMs`, `status='recorded'`. На крахе процесса есть cron-фоллбек: cleanup-job ADR-110 закрывает зомби; finalizer вызывается там же.
- **KS-N12 [backend]** — REST `GET /lectures/:id/recording` (публично или auth для `unlisted` — см. §2.4). Pagination v1 не делаем — отдаём всё. Cache-Control: immutable для записи (id+content не меняется).
- **KS-N13 [frontend]** — `LectureReplayPage` (`/lectures/:id`): обёртка над `AnalysisPage` с пропом `liveBroadcast={lectureId, mode:'replay'}`. В `AnalysisPage` — новый режим `replay`: загрузка `events`, локальный плеер (play/pause/seek/×1/×1.5/×2), применение событий по timeline через тот же `applyLivePgn`. Кнопка «Открыть исходник в мастерской» если `sourceAnalysisId` есть.
- **KS-N14 [frontend]** — секция «Записи» на `/coach/:username` (паджинированный список карточек, клик → `/lectures/:id`).
- **KS-N15 [qa]** — сценарий: автор делает 10-минутную лекцию с ходами и комментариями → закрывает → запись появляется на странице → зритель открывает replay → видит ту же последовательность с теми же интервалами; seek к середине; ×2 speed.

### Эпик 3 — Расписание

- **KS-N16 [backend]** — расширить `LecturesController`: `PATCH /lectures/:id`, `POST /lectures/:id/cancel`. Валидация: `scheduledAt` нельзя менять после `status='live'`.
- **KS-N17 [backend]** — `GET /coaches/:username/schedule?from&to` — список scheduled+live в диапазоне.
- **KS-N18 [frontend]** — UI «Создать запланированную лекцию» на `/coach/:username/me` (или в профиле автора): форма с title, description, scheduledAt.
- **KS-N19 [frontend]** — секция «Расписание» на `/coach/:username`: карточки future-лекций, sortedAt asc. Карточка показывает «через 3 часа» / «10 июня, 18:00».
- **KS-N20 [frontend]** — на странице лекции (`/lectures/:id`, scheduled) — кнопка «Начать» для автора, бейдж «Начнётся через X» для зрителя; зрительская «Подключиться» неактивна до старта.
- **KS-N21 [qa]** — сценарий: автор создал scheduled, ученик увидел в расписании, автор нажал «Начать» → лекция стала live → ученик перешёл по ссылке → попал в трансляцию.

### Эпик 4 — Голос/видео (отложенный)

Задел в моделях, реальный код — позже.

- **KS-N22 [architect]** — отдельный ADR (когда подойдёт срок): окончательный выбор транспорта (p2p vs SFU), схема записи в S3, авторизация на media, оценка стоимости TURN/Cloudflare, прав на запись (consent overlay).
- **KS-N23 [backend]** — миграция: `Lecture.mediaUrl`, `Lecture.mediaKind` (NULL по умолчанию). Безболезненно сейчас, чтобы не миграция-сюрприз в будущем.
- **(дальше — отдельный план, вне scope ADR-113.)**

### QA / документация (сквозные)

- **KS-N24 [qa]** — финальный smoke: все 3 эпика + сценарии из §4 ADR.
- **KS-N25 [architect]** — пост-релиз: обновить `docs/architecture/system-overview.md` (добавить модуль `Lectures`, страницу `/coach/:username`, упомянуть запись лекций).

### Карта зависимостей

- Эпик 1 → Эпик 2 (нужна базовая Lecture-сущность).
- Эпик 2 ⟂ Эпик 3 (параллельны).
- Эпик 4 — после Эпиков 2-3.
- KS-N22 (ADR голос/видео) — стартует когда у пользователя появятся запросы.

## 5. Связь с соседними ADR

- **ADR-110/111/112** — техника live-трансляции анализа. Этот ADR строит поверх: добавляет надстройку `Lecture` с lifecycle, запись и расписание. Никакие решения по транспорту/Redis-state не меняются.
- **ADR-054** — модель пользовательских курсов. Используется как-есть для секции «Курсы» на `/coach/:username`. `Course.lectureId?` не вводим в MVP.
- **ADR-051** — `Analysis.isPublic`. Параллельно: лекция всегда public (или unlisted), Analysis под ней — может быть public или нет. Зритель замшаривает по `/lectures/:id`, не открывая Analysis напрямую.
