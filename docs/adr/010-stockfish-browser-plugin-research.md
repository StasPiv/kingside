# ADR-010: Stockfish через браузерный плагин — архитектурное исследование

**Статус:** Исследование
**Дата:** 2026-03-13
**Задача:** KS-459

---

## Контекст

В Kingside используется Stockfish двумя способами:

1. **Backend (NestJS)** — `StockfishService` запускает Stockfish как дочерний процесс на сервере.
   Используется для ходов бота (`getBestMove`) и одиночного анализа (`analyze`).
   Возвращает один лучший ход без стриминга.

2. **Frontend (React)** — `useStockfish` хук загружает Stockfish 18 WASM (single-threaded)
   в Web Worker напрямую в браузере. Используется для анализа партий на `GameReviewPage`.
   Работает в реальном времени, стримит линии по мере роста глубины.

**Проблема:** Однопоточный WASM Stockfish значительно слабее нативного. На мобильных
устройствах возникают проблемы с инициализацией и стабильностью (исправлялось в KS-456–458).

---

## Исследование существующего решения: chessgpt

Проект `~/work/chessgpt` реализует подход с локальным WebSocket-сервером:

### Архитектура chessgpt

```
[Локальная машина пользователя]
  Java-приложение (GUI)
    ├── ChessEngineWebSocketServer (оркестратор)
    ├── ChessEngine → запускает polyglot/stockfish как subprocess
    ├── ChessWebSocketServer → WebSocket сервер на порту 8080
    └── NgrokManager → туннель для удалённого доступа

[Браузер]
  frontend/src/websocket.js
    ├── Подключается к ws://localhost:8080 (или ngrok URL)
    ├── Отправляет: {type: 'analyze', fen: '...'}
    ├── Отправляет: {type: 'stop'}
    └── Получает: {fen: '...', lines: [...]} / {type: 'stopped'}
```

**URL разрешения:** приоритет — GET-параметр `?ws=...` → localStorage → env → дефолт localhost:8080.

**Особенности:**
- Stockfish запускается нативно, полная мощность (multi-threaded)
- Стриминг линий анализа в реальном времени
- Пользователь должен установить Java-приложение и запускать его вручную
- Для удалённого доступа нужен ngrok (с его ограничениями бесплатного тарифа)

---

## Варианты запуска Stockfish через браузерный плагин

### Вариант 1: Браузерное расширение (Extension) с Native Messaging

**Как работает:**
```
[Браузер]
  Веб-страница Kingside
    ↕ window.postMessage / chrome.runtime.sendMessage
  Browser Extension (Content Script + Background Service Worker)
    ↕ chrome.runtime.connectNative()
  Native Messaging Host
    ↕ stdin/stdout (JSON по размеру)
  Stockfish (нативный бинарник)
```

**Технические детали:**
- Chrome/Firefox Extension API: `chrome.runtime.connectNative()`
- Native Messaging Host — небольшая программа (Python/Go/C++) которая читает
  JSON из stdin и пишет JSON в stdout, проксируя команды к Stockfish
- Манифест Native Messaging Host регистрируется в системе (Windows реестр,
  Linux ~/.config/google-chrome/NativeMessagingHosts/)
- Расширение обнаруживается страницей через `chrome.runtime.sendMessage(extensionId, ...)`

**Pros:**
- Полная мощность нативного Stockfish
- Multi-threaded (не ограничен WASM)
- Упакован как расширение — проще установить, чем Java-приложение

**Cons:**
- Требует установки **двух компонентов**: расширения + Native Messaging Host
- Native Messaging Host должен быть зарегистрирован в системе (требует прав)
- Только Chrome и Firefox (разные API)
- Safari не поддерживает Native Messaging
- Страница должна знать `extensionId` — хрупкая связь
- Обновления расширения и хоста нужно синхронизировать
- Обнаружение расширения: `window.postMessage` + content script,
  либо `externally_connectable` в манифесте

---

### Вариант 2: Локальный WebSocket-сервер (chessgpt-подход)

**Как работает:**
```
[Локальная машина пользователя]
  Companion-приложение (запущено пользователем)
    Stockfish нативный subprocess
    WebSocket сервер ws://localhost:PORT

[Браузер]
  Kingside frontend
    WebSocket клиент → ws://localhost:PORT
```

**Варианты реализации companion-приложения:**
- Java (как в chessgpt) — тяжело, требует JRE
- Go бинарник — лёгкий (~5MB), одним файлом, нет зависимостей
- Python script — не нужна компиляция, но требует Python + pip

**Интеграция в Kingside frontend:**
```typescript
// Попробовать подключиться к локальному серверу
// Если недоступен — использовать WASM fallback
```

**Pros:**
- Уже проверено в chessgpt
- Companion-приложение можно сделать лёгким (Go)
- Graceful fallback на WASM

**Cons:**
- Пользователь должен скачать и запустить companion-приложение
- HTTP/WASM по умолчанию — без запуска companion ничего не изменится
- Localhost WebSocket с HTTPS-страницы: браузер блокирует mixed content
  (`wss://` требует сертификат для localhost, `ws://` не работает с HTTPS)
  → **критическая проблема**

---

### Вариант 3: Stockfish WASM Multi-threaded (SharedArrayBuffer)

**Как работает:**
Стандартный Stockfish WASM с поддержкой многопоточности через `SharedArrayBuffer`.
Lichess использует именно этот подход.

**Требования:**
- HTTP-заголовки `Cross-Origin-Opener-Policy: same-origin`
  и `Cross-Origin-Embedder-Policy: require-corp`
- Эти заголовки включают `crossOriginIsolated` в браузере
- Ломают iframes третьих сторон, Google Analytics, некоторые платёжные виджеты

**Pros:**
- Нет установки для пользователя
- Значительно быстрее single-thread WASM (4–8 потоков)
- Хорошо поддерживается (lichess, chess.com)

**Cons:**
- Требует изменений HTTP-заголовков на сервере
- Может сломать сторонние интеграции (OAuth iframes и т.д.) — нужна проверка
- Не решает проблему мобильных устройств (мало потоков)

---

### Вариант 4: Серверный анализ через backend (уже есть)

**Как работает:**
Расширить существующий `StockfishService` в NestJS для потокового анализа
(streaming `info` lines через WebSocket вместо единственного `bestmove`).

**Pros:**
- Нативный Stockfish уже запущен на сервере
- Пользователю ничего устанавливать не нужно
- Работает на мобильных

**Cons:**
- Нагрузка на сервер (один разработчик, ограниченные ресурсы)
- Задержка сети (latency) влияет на интерактивность анализа
- При многих одновременных пользователях — bottleneck

---

## Сравнение вариантов

| Критерий | WASM single | Browser Extension | Local WS | WASM multi | Server-side |
|---|---|---|---|---|---|
| Установка для пользователя | нет | да (2 компонента) | да (companion) | нет | нет |
| Мощность движка | низкая | полная | полная | средняя | полная |
| Работает на mobile | частично | нет | нет | частично | да |
| Требует изменений backend | нет | нет | нет | нет | да |
| Требует изменений frontend | нет | да | да | нет | да |
| Сложность реализации | — | высокая | средняя | низкая | средняя |
| HTTPS совместимость | да | да | нет* | да | да |

> *Mixed content: `ws://localhost` не работает с HTTPS-страницей без специальных настроек браузера

---

## Проблема mixed content для локального WebSocket

Это **критическое ограничение** для варианта 2 и chessgpt-подхода в production:

- Kingside будет работать по HTTPS
- `ws://localhost:8080` с HTTPS-страницы блокируется как mixed content
- Обходы: ngrok (как в chessgpt), Chrome flag `--disable-web-security` (только dev),
  или самоподписанный сертификат для `wss://localhost` (сложно для пользователей)

---

## Рекомендация

**Для текущего этапа (один разработчик, ограниченные ресурсы):**

**Приоритет 1 — WASM multi-threaded** (Вариант 3)
Наименьшее количество изменений, нет зависимостей от пользователя. Нужно:
1. Добавить COOP/COEP заголовки в nginx/backend
2. Заменить `stockfish-18-single.js` на multi-threaded версию
3. Проверить, не ломаются ли сторонние интеграции (OAuth и т.д.)

**Приоритет 2 — Серверный анализ** (Вариант 4)
Реализуемо на существующей инфраструктуре. Добавить streaming analysis
через WebSocket (`/game` namespace). Даст мощный анализ без установок.
Риск: нагрузка на сервер.

**Браузерный плагин (Extension или Local WS) — не рекомендуется** для MVP:
- Высокий барьер установки для пользователей
- Mixed content проблема для Local WS
- Сложность поддержки двух компонентов для Extension

---

## Решение

Архитектура chessgpt (Local WebSocket) технически работает, но **не подходит для production**
Kingside без дополнительного решения для mixed content (ngrok-подобный туннель = внешняя зависимость).

Браузерное расширение с Native Messaging — технически возможно, но чрезмерно сложно
для текущего этапа: требует 2 установки, поддержки нескольких браузеров, отдельного binary.

**Рекомендуемый путь:** WASM multi-threaded → при необходимости серверный стриминг.
