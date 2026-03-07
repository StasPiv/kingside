# Kingside

Шахматная онлайн-платформа.

## Структура

```
apps/api      — NestJS бэкенд (порт 3001)
apps/web      — React фронтенд (порт 3000)
packages/shared — общие типы и константы
```

## Требования

- Node.js >= 18
- npm >= 8
- Docker и Docker Compose

## Запуск

### 1. Клонирование и установка зависимостей

```bash
git clone <repository-url>
cd kingside
npm install
```

### 2. Настройка окружения

```bash
cp .env.example .env
```

Переменные окружения (значения по умолчанию в `.env.example`):

| Переменная | Описание | По умолчанию |
|---|---|---|
| `POSTGRES_USER` | Пользователь PostgreSQL | `kingside` |
| `POSTGRES_PASSWORD` | Пароль PostgreSQL | `kingside` |
| `POSTGRES_DB` | Имя базы данных | `kingside` |
| `POSTGRES_PORT` | Порт PostgreSQL на хосте | `5432` |
| `REDIS_PORT` | Порт Redis на хосте | `6380` |
| `DATABASE_URL` | Строка подключения к БД | `postgresql://kingside:kingside@localhost:5432/kingside` |
| `JWT_SECRET` | Секрет для JWT-токенов | `change-me-in-production` |
| `JWT_EXPIRES_IN` | Время жизни access-токена | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Время жизни refresh-токена | `7d` |

### 3. Запуск Docker-контейнеров

PostgreSQL (порт 5432) и Redis (порт 6380):

```bash
docker compose up -d
```

### 4. Миграции базы данных

```bash
cd apps/api
npx prisma migrate dev
cd ../..
```

### 5. Запуск в режиме разработки

```bash
npm run dev
```

Backend запустится на `http://localhost:3001`, frontend — на `http://localhost:3000`.

## Полезные команды

```bash
npm run build          # Сборка всех пакетов
npm run lint           # Линтинг
npm run test           # Тесты

# Prisma
cd apps/api
npx prisma studio     # Веб-интерфейс для БД
npx prisma generate   # Генерация клиента
```
