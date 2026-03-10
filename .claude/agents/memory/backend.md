# Backend Agent Memory

## Завершённые задачи

### KS-124: Настраиваемые временные контроли
- Ветка: feature/KS-124
- Расширены пресеты TIME_CONTROLS (14 вариантов с инкрементами)
- Добавлены MAX_INITIAL_TIME_SEC, MAX_INCREMENT_SEC
- classifyTimeControl вычисляет категорию серверно (формула: initialSec + 40 * incrementSec)
- DTO больше не требует enum — принимает произвольные timeInitial/increment
- Prisma enum TimeControlType оставлен для категоризации

## Известные проблемы
- Другие агенты параллельно работают и переключают ветки — нужно коммитить быстро
- Pre-existing TS ошибки: bot-game.service.spec.ts, puzzle.service.ts, engine/stockfish.service
- packages/shared/dist в .gitignore — не коммитится, нужна пересборка после checkout
