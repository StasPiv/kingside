# ADR-004: REST API и WebSocket-протокол

**Статус:** Принято
**Дата:** 2026-03-07
**Контекст задачи:** KS-6

## Контекст

Необходимо спроектировать API для взаимодействия клиента с сервером: REST для CRUD-операций, WebSocket для real-time.

## Решение

### REST API

```
POST   /api/auth/register        # Регистрация
POST   /api/auth/login            # Логин (JWT)
POST   /api/auth/refresh          # Обновление токена
GET    /api/auth/me               # Текущий пользователь

GET    /api/users/:id             # Профиль пользователя
GET    /api/users/:id/games       # История партий пользователя

GET    /api/games/:id             # Данные партии (PGN, результат)
GET    /api/games/:id/moves       # Список ходов партии
```

### Аутентификация

- **JWT** (access + refresh token)
- Access token — 15 минут, refresh — 7 дней
- WebSocket-аутентификация через токен в handshake query: `?token=<jwt>`

### WebSocket-протокол (Socket.IO)

Namespace: `/game`

#### Клиент -> Сервер

| Событие | Payload | Описание |
|---------|---------|----------|
| `matchmaking:join` | `{ timeControl: "blitz", timeInitial: 300, increment: 3 }` | Встать в очередь |
| `matchmaking:leave` | — | Покинуть очередь |
| `game:move` | `{ gameId, uci: "e2e4" }` | Сделать ход |
| `game:resign` | `{ gameId }` | Сдаться |
| `game:draw:offer` | `{ gameId }` | Предложить ничью |
| `game:draw:accept` | `{ gameId }` | Принять ничью |
| `game:draw:decline` | `{ gameId }` | Отклонить ничью |
| `chat:send` | `{ gameId, content }` | Сообщение в чат партии |

#### Сервер -> Клиент

| Событие | Payload | Описание |
|---------|---------|----------|
| `matchmaking:found` | `{ gameId, color, opponent, timeControl }` | Соперник найден |
| `game:state` | `{ fen, moves[], clocks, status }` | Полное состояние (при подключении/реконнекте) |
| `game:move` | `{ uci, san, fen, clocks }` | Ход соперника |
| `game:end` | `{ result, termination, ratingChange }` | Партия завершена |
| `game:draw:offered` | `{ gameId }` | Соперник предложил ничью |
| `chat:message` | `{ userId, username, content, timestamp }` | Сообщение в чате |
| `error` | `{ code, message }` | Ошибка |

#### Rooms

- `game:{gameId}` — комната партии (оба игрока + зрители)

### Валидация ходов

1. Клиент валидирует ход локально (chess.js) для мгновенного отклика
2. Сервер валидирует ход авторитетно (chess.js на бэкенде)
3. При расхождении сервер отправляет `game:state` с корректным состоянием

## Последствия

- JWT без серверного хранения — при компрометации токена нельзя его отозвать до истечения. При необходимости можно добавить blacklist в Redis
- Socket.IO добавляет overhead по сравнению с raw WebSocket, но даёт reconnection и rooms
- Валидация на двух сторонах дублирует логику, но необходима для UX и безопасности
