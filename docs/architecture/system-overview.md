# Архитектура Kingside: обзор системы

## Диаграмма компонентов

```mermaid
graph TB
    subgraph Client["Браузер"]
        React["React App"]
        ChessBoard["react-chessboard"]
        ChessJS_C["chess.js (валидация)"]
        SocketIO_C["Socket.IO Client"]
    end

    subgraph Server["Сервер"]
        subgraph NestJS["NestJS"]
            REST["REST Controllers"]
            WSGateway["WebSocket Gateway"]
            AuthModule["Auth Module"]
            GameModule["Game Module"]
            MatchModule["Matchmaking Module"]
            ChatModule["Chat Module"]
            UserModule["User Module"]
        end
        ChessJS_S["chess.js (валидация)"]
        Prisma["Prisma ORM"]
    end

    subgraph Data["Хранение"]
        PostgreSQL["PostgreSQL"]
        Redis["Redis"]
    end

    React --> REST
    React --> SocketIO_C
    SocketIO_C --> WSGateway
    REST --> AuthModule
    REST --> UserModule
    REST --> GameModule
    WSGateway --> GameModule
    WSGateway --> MatchModule
    WSGateway --> ChatModule
    GameModule --> ChessJS_S
    GameModule --> Redis
    GameModule --> Prisma
    MatchModule --> Redis
    UserModule --> Prisma
    ChatModule --> Prisma
    Prisma --> PostgreSQL
```

## Поток игровой партии

```mermaid
sequenceDiagram
    participant C1 as Игрок 1
    participant S as Сервер
    participant R as Redis
    participant DB as PostgreSQL
    participant C2 as Игрок 2

    C1->>S: matchmaking:join (blitz 5+3)
    C2->>S: matchmaking:join (blitz 5+3)
    S->>R: Поиск соперника в очереди
    R-->>S: Match found
    S->>R: Создать game state
    S->>DB: Создать запись GAME
    S-->>C1: matchmaking:found (white)
    S-->>C2: matchmaking:found (black)

    loop Игровой цикл
        C1->>S: game:move (e2e4)
        S->>S: Валидация хода (chess.js)
        S->>R: Обновить state + clocks
        S-->>C1: game:move (подтверждение)
        S-->>C2: game:move (ход соперника)
    end

    S->>S: Обнаружен мат
    S->>R: Удалить game state
    S->>DB: Сохранить партию, ходы, обновить рейтинги
    S-->>C1: game:end (result: black, checkmate)
    S-->>C2: game:end (result: black, checkmate)
```

## Модули NestJS

| Модуль | Ответственность |
|--------|----------------|
| **AuthModule** | Регистрация, логин, JWT, guards |
| **UserModule** | Профили, рейтинги |
| **GameModule** | Логика партии, валидация ходов, таймеры, персистенция |
| **MatchmakingModule** | Очередь поиска, подбор по рейтингу |
| **ChatModule** | Сообщения внутри партии |

## Ограничения и компромиссы

1. **Один сервер** — горизонтальное масштабирование WebSocket потребует sticky sessions или Redis adapter для Socket.IO. Пока не требуется.
2. **Нет микросервисов** — модульный монолит внутри NestJS. Разбиение на микросервисы оправдано только при росте нагрузки.
3. **Нет очередей сообщений** — при текущем масштабе прямое взаимодействие через Redis достаточно.
