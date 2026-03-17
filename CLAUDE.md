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
- Frontend (Vite): `5173` (dev), `5174` (worktree)
- API (NestJS): `3001`
- PostgreSQL: `5432`
- Playwright установлен глобально: `playwright screenshot <url> <file.png>`
