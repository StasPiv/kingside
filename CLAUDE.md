# Правила в этой секции обязательны к исполнению

1. Запрещается начинать сообщения, одобряя решения пользователя ("Ты прав", "Я ошибся", "Сейчас сделаю правильно" и так далее). Не создавать ложное ощущение у пользователя о том, что ты самокритичен
2. Запрещается писать длинные сообщения. Пользователь - человек, он не способен быстро прочитать три страницы текста. Обязательно делать лаконичные резюме из своих анализов
3. Запрещается по делу и без заканчивать свое сообщение вопросом или предложением ("Делать?", "Если хочешь" и так далее). Это растягивает дискуссию без надобности. Надо уметь ставить точку.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kingside — онлайн шахматная платформа (аналог chess.com), TypeScript монорепо на npm workspaces + Turbo.

```
apps/api        — NestJS backend (REST + WebSocket)
apps/web        — React 19 frontend (SPA)
packages/shared — Общие типы и константы
```

## Commands

### Root (turbo)
```bash
npm run dev     # запустить все воркспейсы в dev-режиме
npm run build   # собрать все воркспейсы
npm run lint    # линтинг всех воркспейсов
npm run test    # тесты всех воркспейсов
npm run start   # docker compose + dev
```

### Backend (apps/api)
```bash
npm run dev                 # nest start --watch
npm run build               # nest build
npm run test                # jest
npm run prisma:generate     # prisma generate
npm run prisma:migrate      # prisma migrate dev
npm run prisma:studio       # Prisma Studio UI
```

### Frontend (apps/web)
```bash
npm run dev        # vite (localhost:5173)
npm run build      # vite build
npm run test       # vitest run
npm run test:watch # vitest watch
npm run lint       # eslint src/
```

## Architecture

### Backend (NestJS + Prisma)
Модульная архитектура: каждый домен — отдельный модуль (controller + service + DTOs, gateway если нужен WebSocket).

Ключевые модули:
- `auth` — JWT (access + refresh tokens), passport-jwt
- `game` — игровая логика, WebSocket gateway, chess clock
- `matchmaking` — очередь подбора соперников
- `puzzle` — база задач (lichess data), попытки, рейтинг
- `puzzle-rush` — режим с таймером, лидерборды
- `user` — профили, рейтинги (bullet/blitz/rapid/classical/puzzle), настройки

WebSocket namespace: `/game`. Аутентификация через handshake JWT.

База данных: PostgreSQL 16 (Docker, порт 5432), Prisma ORM. UUID для всех PK, snake_case в БД.

### Frontend (React 19 + Vite)
SPA с React Router v7. Защищённые маршруты через `<ProtectedRoute>`.

Глобальное состояние: Context API (`AuthContext`, `BoardSettingsContext`).

Ключевые библиотеки для шахмат:
- `react-chessboard v5` — рендеринг доски
- `chess.js v1.4` — валидация ходов (UCI формат: "e2e4")
- `Stockfish 18 WASM` — локальный анализ
- `i18next` — переводы (en, ru)

### Shared Types
`packages/shared/types/api-contracts.ts` — единый источник истины для REST и WebSocket типов. Всегда использовать типы из этого пакета, не дублировать.

## Key Conventions

**Перед реализацией**: найди существующий аналогичный компонент/страницу в проекте и используй его как образец. Не начинай с нуля если есть похожий код.

**Frontend**: хуки в `apps/web/src/hooks/`, компоненты в `apps/web/src/components/`, страницы в `apps/web/src/pages/`.

**Backend**: DTOs с class-validator, guards для WebSocket auth (`ws-jwt.guard.ts`), зависимости через конструктор.

**Тесты**: spec-файлы рядом с исходниками (`*.spec.ts/tsx`).

**Ходы**: UCI формат для хранения и передачи (e2e4), PGN/FEN для воспроизведения партий.

## Infrastructure

Docker Compose запускает PostgreSQL, Redis, опционально Grafana+Loki.
Stockfish установлен системно (путь `/usr/games/stockfish`).
Переменные окружения из `.env` (пример в `.env.example`).

Порты:
- Frontend (Vite): `5173` (dev)
- API (NestJS): `3001`
- PostgreSQL: `5432`
- Playwright: `/project/node_modules/.bin/playwright screenshot <url> <file.png>` (НЕ используй `npx playwright` — он ставит другую версию)

## Agent Roles & Ownership

| Агент | Зона ответственности | Может менять |
|-------|---------------------|-------------|
| coordinator | Управление задачами, ревью | Ничего (ro) |
| backend | Backend-код, БД, миграции | apps/api, apps/game-service, apps/broadcast-worker, packages/shared |
| frontend | UI, страницы, хуки | apps/web (packages/shared — read-only) |
| layout | Только CSS/стили | apps/web/src (только стили) |
| devops | Деплой, инфраструктура | scripts/ |
| architect | Архитектура, ADR | docs/ (только документация, НЕ код) |
| qa | Проверка задач | Ничего (ro) |
| marketing | SEO, аналитика, лендинги | apps/web (SEO/аналитика) |

**Правила ownership:**
- Миграции Prisma, изменения схемы БД — ТОЛЬКО backend
- packages/shared — backend или frontend (по контексту задачи)
- Архитектор НЕ меняет код, НЕ делает миграции — только анализ и документация в docs/

**Git workflow:**
- Работаем ВСЕГДА в main. НЕТ feature-веток, НЕТ merge'ей
- Все коммиты идут напрямую в main через MCP-тул `commit({message, files})`
- ЗАПРЕЩЕНО создавать ветки, ЗАПРЕЩЕНО делать merge
- Деплой — отдельно, через MCP-тул `deploy({scope})` у devops. Автодеплоя в post-commit нет

**Метки задач (labels):**
Компоненты: `game`, `puzzle`, `tournament`, `analysis`, `broadcast`, `stockfish`, `chat`, `profile`, `friends`, `feedback`, `auth`, `prisma`, `redis`, `infra`, `matchmaking`, `lobby`, `mobile`, `seo`, `i18n`, `onboarding`, `telegram`, `performance`, `security`, `tests`

При создании задачи в трекере передавай поле `labels: ["game", "mobile"]` (1-3 метки).

**🔴 Запрещено агентам:**
- Редактировать `webhook-server.py`, `Dockerfile.agent`, `.claude/agents/*.md`, `CLAUDE.md` — это инфраструктура управления агентами, её меняет ТОЛЬКО пользователь
- Ссылаться на эти файлы в задачах. Если нужны изменения в инфре агентов — отправь сообщение пользователю через MCP-тул `telegram_send`, НЕ создавай тикет агенту

**Общение между агентами:**
- MCP-тул `agent_message` кладёт сообщение в FIFO-очередь target-агента. Target обработает его последовательно, когда освободится
- Входящее `[from X · нужен ответ]` → ответ ТОЛЬКО через `agent_message({to: X, message: ..., reply_required: false})`. Входящее `[from X · ACK]` → НЕ отвечать через `agent_message` (иначе пинг-понг). Входящее `[Telegram @user]` → ТОЛЬКО через `telegram_send`. Текст в stdout/assistant отправителю НЕ передаётся — он видит только явный tool-call
- Tool-call `agent_message`/`telegram_send` делается ДО завершения хода (до сообщения `result`). Завершил ход без вызова на сообщение «нужен ответ» — webhook автоматически пришлёт `[SYSTEM]` напоминание
- Поле `reply_required` в `agent_message` — ОБЯЗАТЕЛЬНОЕ. `true` только когда реально нужен ответ (вопрос/задача/уточнение). Ответ, ACK, отчёт о готовности, уведомление — `reply_required: false`. Отсутствие поля — ошибка 400
- **Память между сессиями не гарантирована.** При рестарте контейнера агент возобновляется через `claude --resume`, но часть контекста может быть сжата (auto-compact) или утеряна (краш). Если агент опирается на «как делал ранее» / «помню коммит» / «договорились в прошлый раз» — сверка с источником ДО действия: `git log`/`git blame`, комментарии в трекере (`issue_comments`), лог другого агента (`agent_logs`), файлы в проекте. На текстовый ответ память — ок; на действие (commit, deploy, миграция, правка кода, закрытие задачи) — без сверки не делать
- **При коммуникации через scope: ТОЛЬКО симптом, никаких гипотез.** Описывая баг в чужой зоне — давай только наблюдаемое из своей: логи, http-ответы, assertion'ы, числа, временной таймлайн. Гипотезу о причине в чужом коде НЕ передавай ВООБЩЕ — ни жирным, ни с пометкой «гипотеза», ни «подозреваю». Тем более не указывай конкретный файл/функцию/строку для патча и не пиши «добавь X в Y». Помеченная гипотеза всё равно становится директивой для получателя — он защитно реализует именно её, и если ошибочна — цикл диагностики уходит в ложном направлении. Симметрично: пришла чужая гипотеза — игнорируй её как hint, формируй свою от наблюдений. Если очень нужно спросить — формулируй вопросом без указания зоны: «есть ли код-путь, который обнуляет X без логов?» без «в файле Z это в функции Y»
- **Перед «Жду X» — проверь что X реально запущено.** Interrupt тихо отменяет твой текущий `tool_use` без негативного tool_result — в текстовой памяти осталось «я вызвал X», по факту вызов убит. Если ждёшь СВОЙ результат — посмотри последний tool_result в этом turn'е, нет успешного — перезапусти. Если ждёшь чужое действие — убедись через `agent_logs({agent:X})` что у него реально есть active работа по теме. Иначе все стоят в «жду» друг друга и не двигаются часами

**Язык общения с пользователем и между агентами:**
- Минимум IT-сленга ("фикс", "запушить", "апрувнуть", "замерджить", "задеплоить", "зафейлилось", "прокинуть" и т. п.). Допустим только там, где нет однозначного русского эквивалента (например, `merge conflict`, `pull request` как имя сущности)
- ЗАПРЕЩЕНО прикрывать сленгом непонимание задачи или застревание в решении. Сленговые фразы вводят пользователя в заблуждение и создают иллюзию прогресса. Если не знаешь как решить — прямо сказать "не знаю, нужно уточнение" / "решение не получается, причина такая-то"
- Писать просто, по делу, без маркетинговых и бодрых оборотов

## Agent Tools (MCP)

Все операции через MCP-сервер `agent` (тулы доступны автоматически). При создании задачи метки обязательны (1-3).
