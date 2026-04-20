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
| backend | Backend-код, БД, миграции | apps/api, apps/game-service, apps/broadcast-worker, apps/matchmaker, packages/shared |
| frontend | UI, страницы, хуки | apps/web (packages/shared — read-only) |
| layout | Только CSS/стили | apps/web/src (только стили) |
| devops | Деплой, инфраструктура | scripts/ |
| architect | Архитектура, ADR | docs/ (только документация, НЕ код) |
| qa | Проверка задач | Ничего (ro) |
| chess-expert | Шахматные консультации | Ничего |
| marketing | SEO, аналитика, лендинги | apps/web (SEO/аналитика) |

**Правила ownership:**
- Миграции Prisma, изменения схемы БД — ТОЛЬКО backend
- packages/shared — backend или frontend (по контексту задачи)
- Архитектор НЕ меняет код, НЕ делает миграции — только анализ и документация в docs/

**Git workflow:**
- Работаем ВСЕГДА в main. НЕТ feature-веток, НЕТ merge'ей
- Все коммиты идут напрямую в main через `/commit` endpoint
- ЗАПРЕЩЕНО создавать ветки, ЗАПРЕЩЕНО делать merge

**Метки задач (labels):**
Компоненты: `game`, `puzzle`, `tournament`, `analysis`, `broadcast`, `stockfish`, `chat`, `profile`, `friends`, `feedback`, `auth`, `prisma`, `redis`, `infra`, `matchmaking`, `lobby`, `mobile`, `seo`, `i18n`, `onboarding`, `telegram`, `performance`, `security`, `tests`

При создании задачи в трекере передавай поле `labels: ["game", "mobile"]` (1-3 метки).

**🔴 Запрещено агентам:**
- Редактировать `webhook-server.py`, `Dockerfile.agent`, `.claude/agents/*.md`, `CLAUDE.md` — это инфраструктура управления агентами, её меняет ТОЛЬКО пользователь
- Ссылаться на эти файлы в задачах. Если нужны изменения в инфре агентов — задача пользователю через `/telegram/send`, НЕ создавай тикет агенту

**Правила общения между агентами (locks):**
- Перед `/agent/message` проверь `/tmp/locks/<target>.lock` — если есть, агент занят
- Если lock есть — НЕ отправляй сообщение, подожди или отложи
- Webhook вернёт HTTP 409 если агент занят
- Только координатор может форсировать (`force=true`), но сначала должен вызвать `/agent/kill` целевого агента

## Agent Tools (MCP)

Агенты имеют MCP-сервер `agent` с тулами для трекера и webhook. **Используй эти тулы вместо curl** — они короче и с валидацией:

**Трекер:** `issue_get`, `issue_search`, `issue_create`, `issue_update`, `issue_transition`, `issue_comments`, `comment_add`

**Webhook:** `commit`, `agent_message`, `agent_kill`, `telegram_send`, `deploy`, `npm_install`, `api_start`

Curl к endpoint'ам ниже оставлен как fallback.

## Agent Endpoints (webhook-server, localhost:9876)

Агенты работают в изолированных Docker-контейнерах без доступа к git. Все операции с репозиторием — через HTTP endpoints:

```bash
# Коммит
curl -s -X POST http://localhost:9876/commit \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_AUTH_TOKEN" \
  -d '{"message":"KS-XX: описание", "files":["apps/web/src/file.ts"]}'

# Деплой
curl -s -X POST http://localhost:9876/deploy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_AUTH_TOKEN" \
  -d '{"scope":"frontend"}'

# npm install на хосте (после создания нового пакета)
curl -s -X POST http://localhost:9876/npm-install \
  -H "Authorization: Bearer $WEBHOOK_AUTH_TOKEN"

# Запуск API на хосте
curl -s -X POST http://localhost:9876/api-start \
  -H "Authorization: Bearer $WEBHOOK_AUTH_TOKEN"

# Полный запуск проекта (just up — infra + deps + migrate + dev)
curl -s -X POST http://localhost:9876/up \
  -H "Authorization: Bearer $WEBHOOK_AUTH_TOKEN"
```
