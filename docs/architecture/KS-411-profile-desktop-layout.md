# KS-411: UX профиля — desktop layout и список партий

## Проблема

Контейнер профиля ограничен `max-width: 640px`. На широких экранах (~1440px)
используется менее половины ширины viewport. Список партий использует
`flex-wrap: wrap`, из-за чего колонки «перетекают» на следующую строку при нехватке
места — вместо упорядоченной таблицы пользователь видит хаотичные метки.

## Текущее состояние

### CSS (styles.css)

```css
.profile-page {
  max-width: 640px;   /* слишком узко для десктопа */
  margin: 0 auto;
  padding-top: 24px;
}

.game-record {
  display: flex;
  flex-wrap: wrap;    /* вызывает хаотичный перенос */
  gap: 10px;
  ...
}
```

### Данные, уже доступные в `GameRecord` (но не все отображены)

| Поле | Текущее отображение |
|------|---------------------|
| playerColor | ✅ цветной кружок |
| opponent.username + ratingBefore | ✅ |
| ecoCode + openingName | ✅ (усечено до 140px) |
| timeControlType / timeControl | ✅ |
| totalMoves | ✅ |
| result | ✅ (строка, без цвета) |
| termination | ✅ (мелко) |
| ratingDiff (вычисляется) | ✅ |
| createdAt | ✅ (дата) |
| finishedAt | ❌ не используется |
| playerResult ('win'/'loss'/'draw') | ❌ не используется для визуализации |

Поле `playerResult` уже есть в типе — это чистый результат для игрока
('win' / 'loss' / 'draw'), пригодный для цветовой окраски бейджа.

Длительность партии вычисляется как `finishedAt - createdAt` (оба поля есть).

## Предлагаемое UX-решение

### 1. Desktop layout: 2-колоночный

```
┌──────────────────────────────────────────────────────────────────┐
│  Профиль (1100px max-width)                                      │
│ ┌────────────┐ ┌────────────────────────────────────────────┐   │
│ │  Sidebar   │ │  Список партий (растёт)                    │   │
│ │  ~280px    │ │                                            │   │
│ │            │ │  Фильтры                                   │   │
│ │  Имя       │ │  ┌──────────────────────────────────────┐ │   │
│ │  Дата рег. │ │  │ таблица партий                        │ │   │
│ │            │ │  └──────────────────────────────────────┘ │   │
│ │  Рейтинги  │ │                                            │   │
│ │            │ │                                            │   │
│ │  Puzzle    │ │                                            │   │
│ │  Rush      │ │                                            │   │
│ └────────────┘ └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

На мобильном (<768px) — одна колонка, sidebar сверху (текущее поведение).

### 2. Таблица партий: фиксированная grid-сетка

Вместо `flex-wrap: wrap` — `display: grid` с фиксированными колонками.

Колонки на десктопе:

| # | Колонка | Ширина | Данные |
|---|---------|--------|--------|
| 1 | Результат | 56px | цветной бейдж: Win / Loss / Draw (из `playerResult`) |
| 2 | Цвет | 20px | кружок белый/чёрный |
| 3 | Соперник | 1fr | username + (рейтинг) |
| 4 | Дебют | 1fr | ECO + название (без усечения) |
| 5 | Контроль | 64px | timeControlType |
| 6 | Ходы | 48px | totalMoves |
| 7 | Длит. | 56px | finishedAt - createdAt (мм:сс) |
| 8 | Рейтинг Δ | 56px | ±N |
| 9 | Дата | 80px | локализованная дата |

На мобильном (<768px) — убрать колонки «Дебют», «Длит.», «Рейтинг Δ»
или перейти обратно к flex-wrap (текущее поведение).

### 3. Цветовой бейдж результата

```
playerResult === 'win'  → зелёный фон, текст "Win"  / "Победа"
playerResult === 'loss' → красный фон, текст "Loss" / "Поражение"
playerResult === 'draw' → серый фон,  текст "Draw" / "Ничья"
```

Текст бейджа — через i18n ключи `profile.resultWin`, `profile.resultLoss`,
`profile.resultDraw`.

### 4. Длительность партии

```ts
const durationMs = finishedAt
  ? new Date(finishedAt).getTime() - new Date(createdAt).getTime()
  : null;
const minutes = Math.floor(durationMs / 60000);
const seconds = Math.floor((durationMs % 60000) / 1000);
const duration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
```

## CSS-изменения (ориентир для frontend)

```css
/* Новый max-width */
.profile-page {
  max-width: 1100px;
}

/* Desktop 2-колоночный layout */
@media (min-width: 900px) {
  .profile-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 32px;
    align-items: start;
  }
}

/* Grid-таблица партий */
@media (min-width: 768px) {
  .game-record {
    display: grid;
    grid-template-columns: 56px 20px 1fr 1fr 64px 48px 56px 56px 80px;
    flex-wrap: unset;
    align-items: center;
  }
}
```

## Структурное изменение JSX

Необходимо обернуть секции профиля в новый layout-контейнер:

```tsx
<div className="profile-page">
  <div className="profile-layout">
    <aside className="profile-sidebar">
      {/* header, ratings, puzzle rush */}
    </aside>
    <main className="profile-main">
      {/* games filters + list */}
    </main>
  </div>
</div>
```

## Задачи для frontend-разработчика

1. Изменить `max-width` контейнера с 640px → 1100px
2. Добавить `profile-layout` grid с sidebar/main на десктопе
3. Переработать `.game-record` с flex-wrap на CSS Grid (фиксированные колонки)
4. Добавить цветовой бейдж результата (использовать `playerResult`)
5. Добавить вычисление и отображение длительности партии (`finishedAt - createdAt`)
6. Добавить i18n ключи для бейджа результата
7. Протестировать адаптивность: 320px, 768px, 1100px+
