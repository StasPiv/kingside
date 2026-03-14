# KS-484: Research — источники broadcast крупных шахматных турниров

**Дата:** 2026-03-14
**Автор:** architect

---

## 1. Обзор источников

### 1.1 Lichess Broadcasts API ✅ (Рекомендован)

**Сайт:** https://lichess.org/broadcast
**API:** https://lichess.org/api#tag/Broadcasts

Lichess ведёт трансляции сотен крупных OTB-турниров в год (Candidates, World Championship,
Norway Chess, и т.д.). Все данные доступны через открытый публичный API.

**Ключевые эндпоинты:**

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/broadcast` | Список активных трансляций (пагинация) |
| GET | `/api/broadcast/{broadcastId}` | Детали конкретной трансляции |
| GET | `/api/broadcast/{broadcastId}/rounds` | Туры трансляции |
| GET | `/api/broadcast/round/{roundId}` | Информация о туре |
| GET | `/api/broadcast/round/{roundId}.pgn` | PGN всех партий тура (snapshot) |
| GET | `/api/stream/broadcast/round/{roundId}.pgn` | **Живой PGN-стрим (NDJSON)** |

**Формат данных:**
- Чтение публичных трансляций — **без аутентификации**
- Живой стрим — Server-Sent Events / chunked HTTP, формат NDJSON (один PGN per line)
- Обновления приходят по мере поступления ходов с электронных досок

**Лицензия:**
- API: AGPL-3.0 (спецификация OpenAPI)
- Данные партий: свободно доступны для использования
- Ограничения: стандартный rate limiting (не превышать разумной нагрузки)

**Покрытие турниров:**
- FIDE Candidates, World Chess Championship
- Norway Chess, Grand Chess Tour
- Tata Steel, Wijk aan Zee
- Bundesliga, и другие рейтинговые события

---

### 1.2 Chess.com Events ❌ (Недоступен для интеграции)

Chess.com не предоставляет публичный API для получения live-данных партий.

- **PubAPI** (https://api.chess.com/pub/) — только завершённые партии и исторические данные
- Живые партии закрыты из-за соображений анти-читинга
- Приватный API для производителей DGT-досок существует, но партнёрство не публично
- Скрапинг запрещён ToS

**Вывод:** Интеграция невозможна без прямого партнёрства с Chess.com.

---

### 1.3 FIDE ❌ (Нет API)

FIDE не предоставляет никакого официального API — ни для live-данных, ни для результатов.

- Рейтинговые данные доступны только через scraping (https://ratings.fide.com)
- Трансляции крупных событий под эгидой FIDE идут на Lichess или Chess.com
- Существуют сторонние scraper-библиотеки (fideparser, cassiofb-dev/fide-api)

**Вывод:** Прямая интеграция с FIDE невозможна.

---

### 1.4 DGT LiveChess / LiveChess Cloud ⚠️ (Инфраструктурный источник)

DGT — крупнейший производитель электронных шахматных досок.

**DGT LiveChess 2.x:**
- Локальное ПО на компьютере организатора
- WebSocket API на `localhost:1982` — даёт raw ходы с досок в реальном времени
- PGN-файлы записываются в папку и могут быть загружены через Lichess Broadcaster App

**LiveChess Cloud:**
- Облачный relay-сервис от DGT (бета, бесплатно)
- "One-click publish" из LiveChess на LiveChess Cloud
- API для получения данных публично не задокументирован
- Используется как промежуточный узел перед публикацией на Lichess

**Вывод:** Сам по себе не является источником данных для Kingside. Данные с DGT-досок в итоге
попадают на Lichess — там их и нужно потреблять.

---

### 1.5 ChessBase Live ❌ (Нет API)

- https://live.chessbase.com — live трансляции на сайте ChessBase
- Публичный API отсутствует
- Используется собственное закрытое ПО ChessBase
- Данные не экспортируются в реальном времени

---

## 2. Сравнительная таблица

| Источник | Live API | Формат | Лицензия | Стоимость | Рекомендация |
|----------|----------|--------|----------|-----------|--------------|
| Lichess Broadcasts | ✅ | NDJSON/PGN stream | Open, AGPL spec | Бесплатно | **Основной** |
| Chess.com | ❌ | — | Закрытый | Партнёрство | Недоступен |
| FIDE | ❌ | — | Нет API | — | Недоступен |
| DGT LiveChess | Локально | WebSocket/PGN | Проприетарный | Лицензия DGT | Не применимо |
| ChessBase Live | ❌ | — | Закрытый | — | Недоступен |

---

## 3. Архитектура интеграции (рекомендуемая)

### Принципиальная схема

```
[Электронные доски DGT]
        ↓ PGN файлы
[Lichess Broadcaster App]
        ↓ HTTP Push (Lichess API)
[Lichess Broadcasts]
        ↓ GET /api/stream/broadcast/round/{id}.pgn  (NDJSON stream)
[Kingside BroadcastService (NestJS)]
        ↓ WebSocket (/game namespace)
[Kingside Frontend]
```

### Компоненты Kingside

#### BroadcastModule (NestJS)

**BroadcastSyncService** — фоновый сервис:
- Периодически запрашивает `/api/broadcast` (раз в 5 мин) — список активных турниров
- При появлении нового тура открывает HTTP-стрим `/api/stream/broadcast/round/{id}.pgn`
- Парсит входящий NDJSON-PGN
- Сохраняет текущую позицию в Redis (TTL = длительность тура)
- Рассылает обновления подписанным WebSocket-клиентам

**BroadcastController** (REST):
- `GET /api/broadcasts` — список активных трансляций (из Redis/DB)
- `GET /api/broadcasts/:id/rounds` — туры
- `GET /api/broadcasts/round/:id/pgn` — PGN тура

**BroadcastGateway** (WebSocket, namespace `/broadcast`):
- Клиент подписывается: `subscribe { roundId }`
- Сервер рассылает: `move { roundId, gameIndex, move, fen }`

#### База данных (PostgreSQL)

```sql
-- Метаданные трансляций (кэш Lichess данных)
broadcasts (
  id UUID PRIMARY KEY,
  lichess_id VARCHAR UNIQUE,
  name VARCHAR,
  url VARCHAR,
  is_active BOOLEAN,
  created_at TIMESTAMP
)

broadcast_rounds (
  id UUID PRIMARY KEY,
  broadcast_id UUID REFERENCES broadcasts,
  lichess_round_id VARCHAR UNIQUE,
  name VARCHAR,
  started_at TIMESTAMP,
  finished_at TIMESTAMP
)

broadcast_games (
  id UUID PRIMARY KEY,
  round_id UUID REFERENCES broadcast_rounds,
  lichess_game_id VARCHAR,
  white_player VARCHAR,
  black_player VARCHAR,
  pgn TEXT,           -- полный PGN (обновляется)
  result VARCHAR,
  updated_at TIMESTAMP
)
```

---

## 4. Технические детали интеграции с Lichess

### Потребление стрима

```typescript
// Пример потребления NDJSON стрима
async function streamBroadcastRound(roundId: string) {
  const response = await fetch(
    `https://lichess.org/api/stream/broadcast/round/${roundId}.pgn`,
    { headers: { Accept: 'application/x-ndjson' } }
  );

  for await (const line of response.body) {
    const pgn = parseLine(line);
    // обновить состояние партии
  }
}
```

### Rate Limits Lichess

- Без аутентификации: ~20 req/s
- С OAuth токеном: ~60 req/s
- Стримы не имеют жёстких лимитов, но нельзя открывать >100 одновременных стримов

### Рекомендации по реализации

1. Не открывать стримы для всех исторических трансляций — только активные (is_active=true)
2. Хранить текущий FEN каждой партии в Redis — быстрая выдача новым подключившимся
3. Добавить webhook/SSE-эндпоинт на случай если Lichess захочет push-уведомления (будущее)
4. Graceful reconnect при обрыве стрима (exponential backoff)

---

## 5. Альтернативный сценарий: принимать PGN от организаторов

Если в будущем Kingside захочет стать источником трансляций (как Chess.com или Lichess):

- Реализовать эндпоинт `POST /api/broadcasts/push-pgn` — принимать PGN от организаторов
- Поддержать протокол Lichess Broadcaster App (совместимый API)
- Это потребует верификации организаторов и работы с DGT-досками напрямую

**Для текущего этапа (MVP)** этот сценарий не нужен — только потребление данных Lichess.

---

## 6. Итог и рекомендации

**Единственный практичный источник для интеграции в Kingside — Lichess Broadcasts API.**

Обоснование:
- Покрывает все крупные OTB-турниры (FIDE, Norway Chess, Candidates и т.д.)
- Полностью бесплатный публичный API
- Живой PGN-стрим через NDJSON
- Нет лицензионных ограничений для потребления данных
- Простая техническая интеграция (HTTP streaming)
- Единственная реальная альтернатива (Chess.com) закрыта для внешних разработчиков

**Следующие шаги:**
1. ADR: зафиксировать решение об использовании Lichess Broadcasts как источника
2. Backend задача: реализовать BroadcastModule (BroadcastSyncService + BroadcastGateway)
3. Frontend задача: страница трансляций с live обновлением доски
4. DevOps задача: настроить Redis для кэша позиций партий (уже в docker-compose?)
