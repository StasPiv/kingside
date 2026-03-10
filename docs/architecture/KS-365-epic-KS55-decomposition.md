# Декомпозиция эпика KS-55: Звуки, анимации и визуальная полировка

## Анализ текущего состояния

### Что уже реализовано
- `useResponsiveBoardSize.ts` — адаптивный размер доски
- `MemoChessboard.tsx` — поддерживает `squareStyles`, `showNotation`, `animationDurationInMs`
- `animationDurationInMs: 200` включена в PuzzlePage, GameReviewPage, DailyPuzzlePage
- `animationDurationInMs: 0` в GamePage (явно отключена)
- `useFastDrag.ts` — кастомный drag & drop

### Что отсутствует
- Звуки ходов — нет ни одной реализации
- Premove — не реализован
- Подсветка последнего хода и возможных ходов — squareStyles не используется в GamePage
- Темы доски и наборы фигур — нет настроек
- Координаты на доске — showNotation не передаётся в GamePage
- Мобильная адаптация — useResponsiveBoardSize есть, но layout требует проверки

## Декомпозиция на задачи

Все задачи — **frontend** (React/TypeScript). Backend не требуется: настройки хранятся в localStorage.

| Задача | Ключ | Приоритет | Исполнитель |
|--------|------|-----------|-------------|
| Звуки ходов (move, capture, check, castle, game-end) | KS-374 | Medium | frontend |
| Анимация фигур при перемещении в GamePage | KS-376 | Medium | frontend |
| Premove — предварительный ход | KS-377 | Medium | frontend |
| Подсветка последнего хода и возможных ходов | KS-379 | Medium | frontend |
| Темы доски и наборы фигур | KS-381 | Medium | frontend |
| Координаты на доске (showNotation) | KS-382 | Low | frontend |
| Мобильная адаптация игрового интерфейса | KS-384 | Medium | frontend |

## Зависимости между задачами

```
KS-382 (координаты)    ─┐
KS-381 (темы)          ─┼─→ можно выполнять параллельно
KS-376 (анимация)      ─┘

KS-374 (звуки)         → независима

KS-379 (подсветка)     → должна быть до KS-377 (premove использует squareStyles)
KS-377 (premove)       → зависит от KS-379 (общий squareStyles механизм)

KS-384 (мобайл)        → независима, можно в конце
```

## Рекомендации по реализации

### Общий хук настроек
Задачи KS-381, KS-382, KS-376, KS-374 разделяют настройки из localStorage.
Рекомендуется создать `useBoardSettings.ts`:

```typescript
interface BoardSettings {
  animationDuration: 0 | 100 | 200;
  showNotation: boolean;
  soundEnabled: boolean;
  boardTheme: 'classic' | 'green' | 'blue' | 'dark';
}
```

### Порядок выполнения (рекомендуемый)
1. KS-382 + KS-376 (простые, быстрые)
2. KS-374 (звуки — независима)
3. KS-379 (подсветка — нужна для premove)
4. KS-377 (premove — после подсветки)
5. KS-381 (темы — требует расширения MemoChessboard)
6. KS-384 (мобайл — в конце, отдельная задача по CSS)
