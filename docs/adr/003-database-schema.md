# ADR-003: Схема базы данных

**Статус:** Принято
**Дата:** 2026-03-07
**Контекст задачи:** KS-6

## Контекст

Необходимо спроектировать схему БД для хранения пользователей, партий, ходов, рейтингов и чата.

## Решение

### ER-диаграмма

```mermaid
erDiagram
    USER {
        uuid id PK
        string username UK
        string email UK
        string password_hash
        int rating_bullet
        int rating_blitz
        int rating_rapid
        int rating_classical
        timestamp created_at
        timestamp last_seen_at
    }

    GAME {
        uuid id PK
        uuid white_id FK
        uuid black_id FK
        enum status "waiting | active | finished | aborted"
        enum result "white | black | draw | null"
        enum termination "checkmate | resignation | timeout | draw_agreement | stalemate | insufficient | repetition | fifty_moves | abort"
        enum time_control_type "bullet | blitz | rapid | classical"
        int time_initial_sec
        int time_increment_sec
        string pgn
        string final_fen
        int white_rating_before
        int black_rating_before
        int white_rating_after
        int black_rating_after
        timestamp created_at
        timestamp started_at
        timestamp finished_at
    }

    MOVE {
        uuid id PK
        uuid game_id FK
        int move_number
        enum color "white | black"
        string uci "e2e4"
        string san "e4"
        string fen_after
        int time_left_ms
        timestamp created_at
    }

    CHAT_MESSAGE {
        uuid id PK
        uuid game_id FK
        uuid user_id FK
        string content
        timestamp created_at
    }

    USER ||--o{ GAME : "plays as white"
    USER ||--o{ GAME : "plays as black"
    GAME ||--o{ MOVE : "has"
    GAME ||--o{ CHAT_MESSAGE : "has"
    USER ||--o{ CHAT_MESSAGE : "sends"
```

### Индексы

- `GAME`: индексы на `white_id`, `black_id`, `status`, `created_at`
- `MOVE`: составной индекс на `(game_id, move_number)`
- `CHAT_MESSAGE`: индекс на `game_id`
- `USER`: уникальные индексы на `username`, `email`

### Redis (оперативные данные)

| Ключ | Тип | Назначение |
|------|-----|------------|
| `game:{id}:state` | Hash | Текущее состояние партии (FEN, ходы, таймеры) |
| `game:{id}:clocks` | Hash | white_ms, black_ms, last_tick |
| `matchmaking:{time_control}` | Sorted Set | Очередь матчмейкинга (score = rating) |
| `user:{id}:session` | String | ID сокета для reconnection |

## Решения по проектированию

1. **Ходы хранятся отдельно от партии** — позволяет запрашивать ходы по одному (для анализа, реплея), PGN в таблице `GAME` — кэш для быстрой выдачи
2. **Рейтинг в таблице USER, а не отдельно** — упрощение, достаточно для одного разработчика. При необходимости история рейтинга восстанавливается из `GAME.white_rating_before/after`
3. **Состояние активной партии в Redis** — PostgreSQL не подходит для обновлений на каждый ход (latency). После завершения партии данные персистятся в PostgreSQL

## Последствия

- Дуальное хранение (Redis + PostgreSQL) добавляет сложность синхронизации
- Нужен механизм персистенции из Redis в PostgreSQL при завершении партии и при рестарте сервера
- PGN дублирует данные из таблицы MOVE — компромисс между нормализацией и скоростью
