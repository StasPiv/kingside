# ADR-144: Фокус на малом времени в шахматных часах (low-time emphasis)

**Статус:** Черновик на ревью координатором
**Дата:** 2026-06-25
**Задача:** KS-4650
**Связанные ADR / задачи:** KS-4621 (вынос часов в sidebar), KS-4634/4635 (подсветка активной стороны), KS-2172 (синтез звуков WebAudio), KS-2700 (часы трансляций), KS-3000-серия (мобильный layout).

## 1. Контекст

### 1.1 Что есть сейчас

Часы в проекте живут в трёх независимых местах:

1. **Live-партии — `apps/web/src/pages/GamePage.tsx` + `apps/web/src/components/game/GameShell.tsx`.**
   - State хранится в **целых секундах**: `clocks: { white: number; black: number }`.
   - Серверные апдейты (WS-события `game:state`, `game:move`, `game:berserk`) приходят с `whiteMs/blackMs` (мс) и округляются вниз до секунды (`Math.floor(.../1000)`).
   - Локальный отсчёт между серверными апдейтами — `setInterval(1000)` в `GamePage`, декрементит активной стороне `1` секунду.
   - Формат — локальная функция `formatTime(seconds)` в `GameShell.tsx` (`mm:ss`), та же копия в `WatchGamePage.tsx`.
   - CSS — `.game-sidebar-clock` (desktop) / `.game-clock-bar` (mobile). Атрибут `data-active="true|false"` переключает фон между «нейтральная пилюля» и «зелёная активная».

2. **Local-bot — `apps/web/src/hooks/useLocalBotGame.ts`.** Та же модель: state в секундах, свой `setInterval(1000)`. Часы рендерит тот же `GameShell`.

3. **Broadcast — `apps/web/src/hooks/useBroadcastClock.ts` + `BroadcastLiveGamePage.tsx`.** Уже в миллисекундах. Хук считает `remainingMs` от `clockUpdatedAt`, тик `setInterval(1000)`. Есть отдельная утилита `formatBroadcastClock(remainingMs)` с поддержкой `H:MM:SS`.

Звук — `useSounds.ts` (KS-2172): четыре темы (`standard`, `wood`, `minimal`, `eightbit`), все синтезированы через WebAudio (никаких mp3/wav-ассетов в репо — см. KS-2172). Событие `clock-tick`/тиканья таймера сейчас **не существует**.

PuzzleRush (`PuzzleRushPage.tsx`) уже подкрашивает текст таймера красным при `timeLeft <= 10` (`.rush-time-low`) — но это таймер прохождения, не часы партии, и в скоуп данного ADR он **не входит**.

### 1.2 Чего хочет пользователь

При остатке малого времени на часах активной стороны:
1. **Визуальное выделение** — более интенсивная подсветка (как в lichess).
2. **Звуковое тиканье** — короткий клик каждую секунду (метроном).
3. **Десятые доли** на индикаторе времени когда «мало».
4. **Сотые доли** на «совсем мало» (последние секунды).

### 1.3 Что НЕ в скоупе

- Backend-изменения частоты тиков. См. §3.1.
- PuzzleRush (отдельный домен — таймер задачи, не партии).
- Анимация «дрожания» доски / haptic-вибрация — отдельные тикеты, если потребуются.
- Настройка пользователем порогов или тембра тика (можно добавить позже; по умолчанию — фиксированные значения).

## 2. Решение (кратко)

1. **Без backend-изменений.** Сервер уже шлёт `whiteMs/blackMs` в миллисекундах; точность долей секунды на клиенте достигается локальной экстраполяцией через `performance.now()` — как уже сделано в `useBroadcastClock`.
2. **Единая утилита форматирования** `apps/web/src/utils/formatGameClock.ts` с тремя режимами (`normal | tenths | hundredths`), плюс функция `computeClockUrgency(remainingMs, initialMs) → 'normal' | 'low' | 'critical'`. Используется и в live, и в local-bot, и в broadcast.
3. **Точный отсчёт** — хук `useGameClockDisplay` поверх state в мс. При `urgency='normal'` — `setInterval(1000)`; при `low|critical` — `requestAnimationFrame` для плавного бега десятых/сотых.
4. **Визуал** — CSS-атрибут `data-urgency="normal|low|critical"` на `.game-sidebar-clock` / `.game-clock-bar` поверх существующего `data-active`. `low` — янтарная пилюля, `critical` — красная с лёгкой пульсацией.
5. **Звук** — новое событие `clock-tick` в `useSounds.ts` для всех четырёх тем (синтез WebAudio, как остальные звуки — лицензионных файлов не добавляем). Тикает **только на своих часах** (lichess-семантика): при `urgency='low' && isSelfActive` — раз в секунду; при `critical` — раз в 0.5 с (более частый ритм для бомбы).
6. **Зоны:** Live (`GamePage` / `GameShell`) и local-bot — полный набор. Broadcast — десятые/сотые + подсветка, **тиканье выключено по умолчанию** (зритель смотрит несколько досок одновременно, метрономы перекроются).

## 3. Детали

### 3.1 Почему без backend

| Что нужно для фичи | Что уже шлёт backend |
|---|---|
| Текущий остаток времени с точностью ≥ 1 с | `whiteMs/blackMs` (мс) при `game:state`/`game:move`/`game:berserk` |
| Знание, кто на ходу | `fen` → `chess.turn()` (клиентская сторона) |
| Знание момента последнего серверного снимка | момент получения WS-сообщения (фиксируем `performance.now()` в момент приёма) |
| Falls-flag на нуле | существующий `game:claim-timeout` |

Дробные доли секунды считаются на клиенте экстраполяцией: при получении серверного `whiteMs` запоминаем `snapshotAt = performance.now()`; `displayMs = whiteMs - (performance.now() - snapshotAt)` для активной стороны. Это **тот же подход, что в KS-2700 `useBroadcastClock`** — переносим в live.

Поднимать частоту WS-тиков (например, 10 Гц) **запрещено**: лишний трафик, лишняя нагрузка на game-service, нарушит существующий контракт. Backend остаётся источником истины для серверных моментов (ход, инкремент, конец партии); клиент только сглаживает между ними.

Единственное место, где может потребоваться мини-добавка от backend — если выяснится, что `game:state` не содержит `initialMs` (`timeControl.initialSec`), нужного для расчёта порогов. Если такого поля нет — добавление одного number-поля в существующий пейлоад. Решается в момент реализации, не блокер.

### 3.2 Пороги переключения режимов

`computeClockUrgency(remainingMs, initialMs)`:

```
emergency1 = clamp(initialMs * 0.10, 8_000, 30_000)   // «low»
emergency2 = clamp(initialMs * 0.025, 2_000, 8_000)   // «critical»

if (remainingMs <= emergency2) → 'critical'
else if (remainingMs <= emergency1) → 'low'
else → 'normal'
```

Принцип взят у lichess (`lichess/ui/round/src/clock/clockView.ts` — `emerg`). Привязка к доле от `initialMs` нужна, чтобы пороги имели смысл и для bullet 1+0, и для classical 30+0:

| TC | `initialMs` | `emergency1` (low) | `emergency2` (critical) |
|---|---|---|---|
| 1+0 (bullet) | 60 000 | 8 000 (clamp min) | 2 000 (clamp min) |
| 3+0 (blitz) | 180 000 | 18 000 | 4 500 |
| 5+0 (blitz) | 300 000 | 30 000 (clamp max) | 7 500 |
| 15+10 (rapid) | 900 000 | 30 000 (clamp max) | 8 000 (clamp max) |
| 30+0 (classical) | 1 800 000 | 30 000 | 8 000 |

Если `initialMs` неизвестно (например, `WatchGamePage` без `timeControl` в state) — fallback `emergency1 = 30_000`, `emergency2 = 8_000`.

### 3.3 Форматирование

`formatGameClock(remainingMs, mode)`:

| `mode` | пример вывода |
|---|---|
| `normal` | `5:23`, `12:00`, `1:02:45` (≥1ч) |
| `tenths` | `0:09.4` |
| `hundredths` | `9.43`, `0:09.43` (в `mm:ss.tt` если ещё есть минуты — почти не встречается, но безопасно) |

Выбор `mode` — производная от `urgency` **каждой стороны независимо** (так реализовано в KS-4666):
- `urgency='normal'` → `mode='normal'` (`mm:ss`)
- `urgency='low'` → `mode='tenths'` (`m:ss.t`)
- `urgency='critical'` → `mode='hundredths'` (`s.tt` / `m:ss.tt`)

Правило применяется одинаково к активной и неактивной стороне: если у обоих часов оставшееся время попало в порог `low`/`critical` — обе стороны отображают доли. Звук тиканья при этом остаётся **только на своих часах** (см. §3.6/§3.7) — визуальное отображение и слуховой акцент разнесены.

### 3.4 Хук `useGameClockDisplay`

```ts
interface ClockInput {
  whiteMs: number | null;
  blackMs: number | null;
  activeColor: 'white' | 'black' | null;  // null до начала / после конца
  snapshotAt: number;                     // performance.now() в момент приёма
  initialMs: number | null;
  isFinished: boolean;
}

interface ClockOutput {
  whiteDisplayMs: number;
  blackDisplayMs: number;
  whiteUrgency: Urgency;
  blackUrgency: Urgency;
  whiteMode: ClockMode;
  blackMode: ClockMode;
}
```

Внутри:
- Если `isFinished` или нет `activeColor` — рендерим статикой, без таймера.
- Если оба `urgency='normal'` → `setInterval(250)` (грубая частота достаточна для секундной точности; лучше, чем `1000` — меньше дёрганья на границе секунды).
- Если хотя бы один `urgency='low'|'critical'` → `requestAnimationFrame` (~60 fps).

Чистая функция `computeClockDisplay(input, now)` экспортируется отдельно — покрывается unit-тестами (как `computeBroadcastClock` сейчас).

### 3.5 Визуал

CSS в `apps/web/src/styles/game.css`:

```css
.game-sidebar-clock[data-active='true'][data-urgency='normal'] { background: #16a34a; }  /* существующее зелёное */
.game-sidebar-clock[data-active='true'][data-urgency='low']    { background: #d97706; }  /* янтарь */
.game-sidebar-clock[data-active='true'][data-urgency='critical']{
  background: #dc2626;                                                                   /* красный */
  animation: clock-pulse 800ms ease-in-out infinite;
}
@keyframes clock-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.85 } }
```

То же для `.game-clock-bar` (mobile). Подсветка **только активной** стороны (`data-active='true'`); неактивная — нейтральная пилюля.

`prefers-reduced-motion: reduce` — отключает `clock-pulse` (заменяется на статичный red без анимации). Обязательно.

### 3.6 Звук

Добавить `'clock-tick'` в `SoundEvent` (`useSounds.ts`). Реализация в каждой теме — короткий клик:

| тема | реализация |
|---|---|
| `standard` | `playTone(ctx, 800, 0.025, t, 'square', 0.10)` |
| `wood` | `playNoise(ctx, 0.012, t, 0.18, 2500)` |
| `minimal` | `playTone(ctx, 1000, 0.02, t, 'sine', 0.06)` |
| `eightbit` | `playTone(ctx, 600, 0.025, t, 'square', 0.12)` |

**Когда играть** (хук `useClockTickScheduler`):
- только в `GameShell` при `status='active'`,
- только для **своих** часов (`isSelfActive=true`) — на часах соперника не тикаем,
- только при `!muted`,
- `urgency='low'` → каждые 1000 мс,
- `urgency='critical'` → каждые 500 мс,
- сразу остановить при потере активности (ход сделан/партия закончена/звук замьючен/uргентность снова `normal`).

Тик планируется через `setInterval`, но фаза синхронизируется с целыми секундами видимого времени (`displayMs % 1000`), чтобы клик совпадал с прокруткой цифр.

**Никаких .mp3 не добавляем** — это нарушит KS-2172 (синтез WebAudio как единый источник звука, лицензионная чистота, 0 байт ассетов).

### 3.7 Зоны применения

| Место | Визуал (urgency-фон, пульсация) | Десятые/сотые | Тиканье |
|---|---|---|---|
| Live `GamePage` + `GameShell` | да | да | **да** (только свои часы) |
| Local-bot `useLocalBotGame` + `GameShell` | да | да | да (играет с человеком против бота — уместно) |
| Broadcast `useBroadcastClock` + `BroadcastLiveGamePage` | да | да | **нет** (зритель смотрит несколько досок; включение — отдельный тикет с настройкой) |
| `WatchGamePage` (наблюдатель за live-партией) | да | да | нет (тоже наблюдатель) |
| `PuzzleRushPage` | не в скоупе | не в скоупе | не в скоупе |

## 4. Объём работ (для координатора)

Frontend-задачи, которые координатор может создать после ревью ADR:

1. **Утилиты + пороги.** `apps/web/src/utils/formatGameClock.ts` (`formatGameClock`, `computeClockUrgency`) + unit-тесты. Перевод `formatBroadcastClock` на использование новой утилиты с сохранением API.
2. **Live-партия: перевод state на ms + `useGameClockDisplay`.** Заменить `clocks: {white:sec, black:sec}` на `{whiteMs, blackMs, snapshotAt}` в `GamePage.tsx`. Удалить старый `setInterval(1000)`. `useGameClockDisplay` рендерится в `GameShell` через новый prop (вместо текущего `clocks` в секундах). Сохранить совместимость claim-timeout на нуле.
3. **CSS подсветка urgency.** `data-urgency` на `.game-sidebar-clock` / `.game-clock-bar` в `game.css`, янтарь/красный + `clock-pulse` с `prefers-reduced-motion`.
4. **Звук `clock-tick`.** Добавить событие в `useSounds.ts` для всех четырёх тем + хук `useClockTickScheduler`, подключённый в `GameShell`. Тик только на своих часах.
5. **Local-bot.** Перевести `useLocalBotGame` на ms-snapshot + новый display-хук. Без отдельной логики — переиспользует то же.
6. **Broadcast.** Расширить `useBroadcastClock` urgency-флагом, заменить `formatBroadcastClock` вызовом новой утилиты, пробросить `data-urgency` в DOM `BroadcastLiveGamePage` / `BroadcastRoundPage`. Тиканье **выключено**.

Каждая задача — frontend (исполнитель: `frontend`; для CSS-задачи 3 допускается `layout`). Backend, devops, prisma — не затронуты.

Ориентировочно 6 задач × 2-6 часов каждая = **14-19 человеко-часов**. Точные оценки выставляет координатор при создании тикетов.

## 5. Открытые вопросы (требуют решения координатора до старта)

1. **`initialMs` в state живой партии.** Сейчас в `GamePage.tsx` нет явного хранения начального времени контроля. Если в существующем `game:state` его нет — backend добавит одно поле, либо frontend читает из `timeControl.initialSec` props/route-state. Уточнить при старте задачи 2.
2. **Тиканье в local-bot.** В ADR предложено `включено`. Если пользователь сочтёт это лишним для тренировок с ботом — флаг `enableClockTick` в `GameShell` props (по умолчанию `true` для live, передавать `false` из local-bot). Не блокер для ADR.
3. **Broadcast — настройка тиканья.** Не в скоупе текущих задач, но логично оформить отдельным тикетом «настройка `tickInBroadcast`» в Settings.
