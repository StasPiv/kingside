# ADR-008: Персистентность вариантов анализа партии

**Дата:** 2026-03-10
**Статус:** Принято
**Задача:** KS-402

---

## Контекст

В режиме анализа партии пользователь может вводить собственные варианты ходов через `useReviewState`. Эти варианты хранятся только в памяти браузера и теряются при закрытии страницы. Нужно персистировать дерево вариантов на сервере.

Текущее состояние:
- `Game.pgn` — оригинальная PGN партии (без вариантов)
- `GET /api/games/:id/moves` — массив ходов основной линии
- `useReviewState` — в-памяти linked-list дерево с вариантами (`variations: ChessMove[][]`)
- Нет никакого API для сохранения/загрузки вариантов анализа

---

## Решение

### 1. Новая таблица `game_analyses`

Создать отдельную таблицу для хранения анализа каждого пользователя по каждой партии.

**Почему не поле в `games`:**
Поле `games.pgn` хранит оригинальную партию. Пользователей может быть несколько — каждый делает свой анализ. Общее поле перезаписывало бы чужую работу.

**Почему не JSON:**
Требование говорит "PGN с вариантами". PGN — стандартный формат, переносимый, читаемый. Хранится как `TEXT`.

```prisma
model GameAnalysis {
  id          String   @id @default(uuid()) @db.Uuid
  gameId      String   @map("game_id") @db.Uuid
  userId      String   @map("user_id") @db.Uuid
  analysisPgn String   @map("analysis_pgn") @db.Text
  updatedAt   DateTime @updatedAt @map("updated_at")
  createdAt   DateTime @default(now()) @map("created_at")

  game Game @relation(fields: [gameId], references: [id])
  user User @relation(fields: [userId], references: [id])

  @@unique([gameId, userId])
  @@index([gameId])
  @@index([userId])
  @@map("game_analyses")
}
```

### 2. REST API (добавить в `GameController`)

```
GET  /api/games/:id/analysis   — загрузить анализ (JWT required)
PUT  /api/games/:id/analysis   — сохранить/обновить анализ (JWT required)
```

`GET` возвращает `{ analysisPgn: string | null }` — `null` если анализ ещё не сохранялся.
`PUT` принимает `{ analysisPgn: string }`, делает upsert по `(gameId, userId)`.

Авторизация: пользователь видит и сохраняет только свой анализ.

### 3. Сериализация: PGN с вариантами

Текущая структура `ChessMove[]` с полем `variations: ChessMove[][]` нужно привести к PGN-нотации со скобками `(...)`.

Пример: `1. e4 e5 2. Nf3 (2. d4 d5) 2... Nc6`

**Сериализация (frontend):**
Написать `serializeToAnnotatedPgn(history: ChessMove[]): string` — обход дерева в глубину, рекурсивная вставка вариаций в скобках.

**Десериализация (frontend):**
Написать `parseAnnotatedPgn(pgn: string): ApiMove[]` с вариантами, который восстанавливает `ChessMove[]` с `variations`. Возможно использование внешней библиотеки (`pgn-parser`) или chess.js PGN-парсинг.

> **Риск:** chess.js (v1.x) `Chess.history()` не возвращает дерево с вариантами. Потребуется кастомный парсер или библиотека `@chess-tools/pgn`. Фронтенд-разработчик должен оценить этот риск до реализации.

### 4. Автосохранение на фронтенде

Новый хук `useAnalysisPersistence(gameId, history)`:
- При изменении `history` (любая мутация: добавление, удаление вариации, promote, truncate) — дебаунс 2 секунды
- Сохраняет `PUT /api/games/:id/analysis` с сериализованным PGN
- Не блокирует UI — fire-and-forget с тихой обработкой ошибок

При загрузке `GameReviewPage`:
1. Fetch `GET /api/games/:id` + `GET /api/games/:id/moves` (как сейчас)
2. Fetch `GET /api/games/:id/analysis` (если пользователь авторизован)
3. Если `analysisPgn !== null` — загрузить дерево с вариантами через `parseAnnotatedPgn`
4. Иначе — загрузить только `apiMoves` (поведение как сейчас)

---

## Альтернативы, которые были отклонены

| Вариант | Причина отклонения |
|---|---|
| Поле `analysis_pgn` в таблице `games` | Один анализ на всех — перезапись чужих вариантов |
| Хранение как JSON-дерево | Нестандартный формат, PGN требуется по задаче |
| WebSocket-синхронизация | Избыточно для одного разработчика, нет нужды в реальном времени |
| localStorage | Не переносится между устройствами/браузерами |

---

## Последствия

**Положительные:**
- Варианты сохраняются при закрытии окна
- Каждый пользователь имеет независимый анализ
- Стандартный формат PGN — потенциально экспортируем

**Отрицательные / риски:**
- Требуется реализовать кастомный PGN-сериализатор/десериализатор на фронтенде
- Автосохранение создаёт нагрузку на БД (2s debounce снижает, но не исключает)
- Размер `TEXT` неограничен — нужно ограничить максимальный размер на уровне API (например, 500KB)

---

## Связанные документы

- [ADR-003: Database Schema](003-database-schema.md)
- [ADR-004: API and WebSocket](004-api-and-websocket.md)
- [KS-402 Architecture Plan](../architecture/KS-402-game-analysis-persistence.md)
