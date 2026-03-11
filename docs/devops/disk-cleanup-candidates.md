# Анализ занятости диска — kamatera-chess

**Дата анализа:** 2026-03-11
**Сервер:** kamatera-chess (63.250.57.89)
**Диск:** 30G total, 24G used, 4.6G free (84%)

---

## Текущее состояние диска

| Путь | Размер | Последнее изменение |
|------|--------|---------------------|
| `/root/work/fantasy` | 2.5G | Март 2026 (активно) |
| `/home/chess-analytics-frontend` | 1.6G | Май 2024 |
| `/var/www/html` | 877M | — |
| `/root/kingside` | 510M | Март 2026 (активно) |
| `/root/Ronaldo*.mkv+.webm+.mp4` | 763M | Сентябрь 2025 |
| `/root/work/video-parser` | 65M | Сентябрь 2025 |
| `/var/www/ws` | 43M | Январь 2024 |

**Активные сервисы (Docker):** kingside-api-1, kingside-postgres-1, kingside-redis-1

---

## Кандидаты на удаление

| # | Путь | Размер | Последнее изменение | Причина |
|---|------|--------|---------------------|---------|
| 1 | `/home/chess-analytics-frontend` | ~1.6G | Май 2024 | GitHub Actions runner, неактивен 22+ месяца |
| 2 | `/var/www/html/travel-agency` | 529M | Июнь 2024 | Старый проект, неактивен 21+ месяц |
| 3 | `/root/Ronaldo*.mkv` | 360M | Сентябрь 2025 | Видеофайл в /root, не проект |
| 4 | `/root/Ronaldo*.webm` | 360M | Сентябрь 2025 | Видеофайл в /root, не проект |
| 5 | `/var/www/html/is-pgn-uploader` | 130M | Октябрь 2024 | Неактивен 16+ месяцев |
| 6 | `/var/www/html/is-reporting-service` | 54M | Октябрь 2024 | Неактивен 16+ месяцев |
| 7 | `/var/www/html/chessgpt` | 36M | Август 2025 | Проект chessgpt, неактивен 6+ месяцев |
| 8 | `/var/www/ws` | 43M | Январь 2024 | WebSocket сервер, неактивен 26+ месяцев |
| 9 | `/root/Ronaldo*.mp4` | 43M | Сентябрь 2025 | Видеофайл в /root, не проект |
| 10 | `/root/work/video-parser` | 65M | Сентябрь 2025 | Неактивен 6+ месяцев |
| 11 | `/root/2024-01-05.log` | 84K | Январь 2024 | Старый лог-файл |
| 12 | `/var/www/html/pgn` | 32K | — | Пустая директория |

**Итого потенциально освобождаемое место: ~3.2G**

---

## Не рекомендуется удалять

- `/root/kingside` — активный проект Kingside (Docker контейнеры запущены)
- `/root/work/fantasy` — активно изменялся в марте 2026
- `/root/data` — активные данные highlights (генерируются регулярно)
- `/var/www/html/chess-analytics-frontend` — текущий деплой фронтенда
- `/var/www/html/pgn-service` — возможно активен (требует проверки)
- `/var/www/html/video-parser-frontend` + `/var/www/html/video-parser-backend` — Sep 2025

---

## Следующий шаг

Список требует согласования с владельцем перед удалением.
