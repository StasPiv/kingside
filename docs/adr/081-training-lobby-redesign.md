# ADR-081. /train — редизайн тренировочного лобби (hero + secondary + resume)

Статус: предложен (2026-05-27)
Связано: KS-3371 (этот ADR), ADR-058 §11 (sidebar + lobby-redirect
на desktop, KS-2844), KS-2796 (исходный TrainLobbyPage),
ADR-079 (UserPrecisionRating M2), ADR-077 (Opening Trainer).

## 1. Контекст

`/train` (`apps/web/src/pages/TrainLobbyPage.tsx`) сейчас показывает
5 одинаковых карточек: Задачи / Puzzle Rush / Тренажёры / Точность /
Дебюты. Каждая — emoji-иконка + title + 1-2 строки описания, всё на
белом фоне, без личных данных. На mobile (скриншот
`/tmp/telegram/326130550_0.jpg`) выглядит как вертикальный список из
5 идентичных блоков — нет визуальной иерархии, никакого «куда мне
сейчас».

На desktop сейчас вообще нет лобби — `Navigate replace` на `/puzzles`
(KS-2844 / ADR-058 §11.5). Это даёт быстрый вход «sidebar
показывает подразделы», но **лишает пользователя контекстного
dashboard'а** (его рейтинги, прогресс, продолжение последней
сессии).

Что доступно как данные для обогащения:

- `User.ratingPuzzle` — общий puzzle-рейтинг (lichess-задачи).
- `UserPrecisionRating` (ADR-079 M2) — отдельный рейтинг точности
  (Glicko-1).
- `TacticDrillRating` (KS-2311, ADR-035) — рейтинг drill'ов.
- Puzzle Rush — лучший score (`PuzzleRushAttempt`).
- Opening Trainer — `OpeningRepertoire[]` + (M2) `OpeningLineProgress`
  с masteredLines / due.
- Recent activity timestamps по каждому модулю — для «продолжить».

## 2. Решение

### 2.1 3-уровневая структура

```
┌─────────────────────────────────────┐
│ Тренировка                          │  ← compact header (без длинного subtitle)
├─────────────────────────────────────┤
│ ⟳  Продолжить: Точность (2 дня…)   │  ← опционально, ResumeSessionCard
│    Сессия не закончена — Продолжить→│     показана только если есть активная сессия
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ 🧩  ЗАДАЧИ                      │ │  ← Hero, 1×wide
│ │     Рейтинг 1487  +12 / нед.    │ │
│ │     Последняя: 14:30            │ │
│ │     [▶  Начать решать]          │ │
│ └─────────────────────────────────┘ │
├──────────────────┬──────────────────┤
│ ⚡  Puzzle Rush  │ 🧠  Тренажёры    │
│ Лучший 24       │ 1532 · 156 решено│  ← Secondary, 2×2
├──────────────────┼──────────────────┤
│ 🎯  Точность     │ ♔  Дебюты        │
│ 1601 (±32) ★★★★ │ 3 реп. · 47%     │
└──────────────────┴──────────────────┘
```

- **Header** — компактный заголовок «Тренировка», без длинного
  subtitle «Оттачивайте тактику, паттерны и точность» (он
  избыточен и съедает 60 px вертикали на mobile).
- **Resume card** — sticky-карточка-баннер сверху, рендерится **только
  при наличии recent open session**. Показывает домен последней
  активности и CTA «Продолжить». Скрыта, если открытых сессий нет.
- **Hero card** — «Задачи» как primary CTA. Самая частая активность
  (lichess-bank, рейтинговая тактика — основной use-case). Крупная,
  с рейтингом, недельной дельтой и кнопкой «Начать решать».
- **Secondary 2×2** — Puzzle Rush / Drills / Precision / Openings.
  Каждая с метрикой per-domain (см. §2.3).

### 2.2 Hero «Задачи» — почему фиксированный

В MVP hero = puzzles (рейтинговая тактика). Аргументы:
- Самый универсальный модуль (новичок → продвинутый).
- Самая частая активность пользователя в шахматных платформах.
- Уже есть готовая метрика (`User.ratingPuzzle`).

Альтернатива — авто-выбор hero по recent activity («что чаще всего
открывал»). Отвергнуто для M1: добавляет complexity без явной
выгоды на 5-модульном лобби. M2-улучшение, если на практике hero
надо персонализировать.

### 2.3 Метрики per-card

| Карточка | Метрика | Источник |
|---|---|---|
| **Задачи** (hero) | Рейтинг + Δ за 7 дней + время последней попытки | `User.ratingPuzzle` + `PuzzleAttempt` (агрегат) |
| Puzzle Rush | Лучший score (`bestScore`) + время последней попытки | `PuzzleRushAttempt MAX(score)` |
| Тренажёры | Рейтинг drill + всего решено | `TacticDrillRating` (если есть) + count attempts |
| Точность | Рейтинг (±отклонение) + средние звёзды | `UserPrecisionRating` (ADR-079) + ср. `PrecisionAttempt.score` |
| Дебюты | N репертуаров + % mastered (M2-aware) | `OpeningRepertoire` count + `OpeningLineProgress` agg |

**Нет данных** (user не пробовал модуль) — метрика заменяется на CTA
«Попробовать». Не показываем «0 / 1500 / —» — это демотивирует.

**Гость** — все метрики скрыты, карточки показывают только CTA.
ResumeSession-карточка скрыта.

### 2.4 Цветовая палитра

Сейчас все карточки на одном фоне — однообразно. Решение —
**color-accent на иконке + тонкая полоска сверху карточки**, без
заливки всей карточки (это плохо смотрится в тёмной теме).

| Карточка | Цвет акцента (HSL semantic) |
|---|---|
| Задачи | `--accent-tactics` (blue 220° 70% 55%) |
| Puzzle Rush | `--accent-rush` (orange 25° 85% 55%) |
| Тренажёры | `--accent-drills` (green 145° 60% 45%) |
| Точность | `--accent-precision` (purple 270° 55% 60%) |
| Дебюты | `--accent-openings` (gold 45° 75% 50%) |

Цвета — semantic, не hardcode. Layout сам решает hex'ы под темы
(см. KS-L1).

### 2.5 Desktop — отменить redirect

ADR-058 §11.5 / KS-2844 сейчас на desktop делает `Navigate replace`
на `/puzzles`. Для UX dashboard'а это плохо — пользователь
теряет контекст «что у меня по всем модулям».

Решение: **отменить редирект**, показывать тот же hero + grid на
desktop. Sidebar (KS-2800) продолжает давать прямой доступ к
подразделам, но `/train` — теперь полноценный dashboard.

Это **изменение ADR-058 §11.5** — фиксируем в §6 этого ADR.

### 2.6 Группировка — НЕ делаем в M1

Можно сгруппировать по «Тактика / Скорость / Глубина / Дебют» (3+1+1
или 4+1). На 5 модулях это overengineering — введёт visual noise
без выгоды. Группировка имеет смысл с 8+ модулями. Сейчас 5 — flat-
layout с hero+secondary достаточен.

В M2 если добавятся modules (например «Эндшпили», «Манёвры»,
«Расчёт вариантов») — пересмотрим.

### 2.7 Что НЕ делаем (M1)

- Графики тренда рейтинга (это уже есть на `/precision/stats` и
  отдельных stats-страницах).
- Personalized рекомендации («сегодня попробуй pin»).
- Achievements / streak / гамификация — отдельная фича, ADR на
  будущее.
- Heatmap активности.
- Авто-выбор hero по recent activity (только если в M2 окажется
  нужным).
- Видео-тутор / onboarding на лобби (отдельный feature-запрос).
- Подзаголовок «Оттачивайте тактику…» — убираем, дублирует title.

## 3. UX-сценарии

### 3.1 Залогиненный с историей

- Видит resume-карточку (если была сессия) → tap → возврат.
- Hero с реальным рейтингом + Δ → tap «Начать» → авто-подбор задачи.
- Secondary: каждая со своей метрикой → tap → раздел.

### 3.2 Залогиненный без истории (новый user)

- Resume-карточка скрыта.
- Hero «Задачи» с рейтингом-по-умолчанию (1500, новичок) → CTA
  «Начать решать».
- Secondary показывают CTA «Попробовать» вместо метрики.

### 3.3 Гость

- Resume-карточка скрыта.
- Hero с CTA «Начать решать» (без рейтинга — он залогинит,
  потом — рейтинг).
- Secondary: только CTA, без метрик.

### 3.4 Desktop

- Тот же layout, но шире: hero — 60% ширины, secondary — справа
  2×2 (или 4 в один ряд внизу). Resume — full-width баннер
  сверху.
- Sidebar остаётся (прямой доступ к подразделам).

## 4. API

### 4.1 Новый endpoint `GET /train/summary`

```
GET /train/summary
```

- Auth: `OptionalJwtGuard` (гость → все поля без user-метрик).
- Cache: in-process или Redis 60 секунд per-user.
- Response:

```ts
interface TrainingLobbySummaryDto {
  resumeSession: ResumeSessionDto | null;

  puzzles: {
    ratingPuzzle: number | null;   // null для гостя
    weeklyDelta: number | null;    // Δ за последние 7 дней
    lastActivityAt: string | null;
  };

  puzzleRush: {
    bestScore: number | null;
    lastActivityAt: string | null;
  };

  drills: {
    rating: number | null;
    totalSolved: number;           // 0 если не пробовал
    lastActivityAt: string | null;
  };

  precision: {
    rating: number | null;
    deviation: number | null;
    avgStars: number | null;       // 0..5
    lastActivityAt: string | null;
  };

  opening: {
    repertoiresCount: number;
    masteredLines: number;         // 0 пока M2 не выкатили
    dueLinesCount: number;         // 0 пока M2 не выкатили
    lastActivityAt: string | null;
  };
}

interface ResumeSessionDto {
  kind: 'puzzles' | 'puzzle-rush' | 'drills' | 'precision' | 'opening-trainer';
  /** Человекочитаемый ярлык, локализованный на бэке (или ключ для t()). */
  labelI18nKey: string;
  /** Готовая ссылка для `Link to`. */
  href: string;
  /** ISO-строка последней активности. */
  lastActivityAt: string;
}
```

### 4.2 Источник `resumeSession`

Алгоритм:
1. Собрать `lastActivityAt` из 5 модулей (макс из per-module
   запросов).
2. Если для пользователя активна **открытая** сессия (Puzzle Rush
   незакрытая, Opening Trainer `finishedAt IS NULL`,
   Precision-attempt в процессе) — приоритет ей.
3. Если открытых нет — последняя по `lastActivityAt` если она в
   пределах 7 дней, иначе null.

Для M1 — простая версия: открытая Opening Trainer-сессия → resume;
иначе last activity Precision в пределах 24h → resume. Остальные
модули в M1 не имеют persistent-сессии для resume. Если ни одно
не подходит — `resumeSession: null`.

### 4.3 Лимиты / производительность

- 5 запросов агрегатов параллельно (`Promise.all`) — самый дорогой
  — `PuzzleAttempt` weekly delta. С индексом по `(userId,
  createdAt)` — ≤ 50 ms.
- Cache 60s per-user — почти отсутствует нагрузка (отображение
  лобби нечасто, пользователь не F5'ит).
- Гость — Promise.all со всеми null, ≤ 10 ms (только resume-чек,
  который тоже null).

## 5. Лимиты и безопасность

- Endpoint только read; никаких write-операций.
- `OptionalJwtGuard` — без auth работает (карточки без метрик).
- Лимит запросов — общий chat/page rate-limit; отдельный rate-limit
  не нужен (читается 1 раз при mount странички).
- Никаких PII в payload (только агрегаты + ссылки).

## 6. Влияние на другие ADR

- **ADR-058 §11.5 / KS-2844** — отменяем редирект на desktop.
  `/train` становится полноценным dashboard'ом. Sidebar
  продолжает давать прямой доступ к подразделам — `/train` это
  альтернативная точка входа с агрегатом, не дублирует sidebar
  логически.
- **ADR-077 / ADR-079** — данные для метрик opening / precision
  читаются как есть. Никаких изменений в shared/backend этих
  модулей не требуется.

## 7. Риски

1. **Цвет акцентов в тёмной теме.** HSL semantic с контролем
   контраста (≥ 4.5:1). Layout проверяет на обеих темах.
2. **Метрики None vs 0.** Чётко различаем: «не пробовал» (null →
   CTA «Попробовать») vs «пробовал, но 0» (например drill
   bestScore=0 — редко). Для drill `totalSolved=0` → null-treatment
   (CTA, не «0 решено»).
3. **Weekly delta `puzzles`** — может быть отрицательной (рейтинг
   упал). Показывать честно с минус-знаком; цвет — нейтрально-
   серый, не красный («не пугать»). Только +N зелёным.
4. **Resume-карточка ложная** — пример: pole-session Opening
   Trainer заброшена 2 месяца назад, всё ещё `finishedAt=null`.
   Решение: 7-дневный TTL для resume (логика §4.2). Старше — не
   показываем; пользователь сам зайдёт в раздел и продолжит.
5. **Desktop редирект уберём — регрессия?** Тест на
   `TrainLobbyPage.test.tsx` — нужно обновить (сейчас тестирует
   redirect). Layout проверит, что Sidebar+`/train` на desktop не
   конфликтуют.
6. **Backend агрегат 5 запросов** — если один модуль упадёт
   (например, opening-trainer-сервис недоступен) — graceful
   fallback (поле = null), не валим всю страницу.

## 8. Реализация — follow-up задачи

Зависимости: S1 → B1 → F1 → F2 → L1. Тест и i18n — параллельно с
F1/F2.

### KS-3372 (S1) — shared types для лобби-summary

**Assignee:** backend (shared owner).
**Labels:** `onboarding`.
**Описание:**
- В `packages/shared/src/types/api-contracts.ts` (или новый
  `training-lobby.ts`) добавить `TrainingLobbySummaryDto`,
  `ResumeSessionDto`, sub-DTO per домен (см. §4.1).
**Acceptance:**
- TS-сборка `packages/shared` без ошибок.
- Все нумерики nullable где это уместно (новый user / гость).

### KS-3373 (B1) — endpoint `GET /train/summary`

**Assignee:** backend.
**Labels:** `onboarding`, `puzzle`.
**Зависит:** KS-3372.
**Описание:**
- `TrainLobbyController.GET /train/summary` с `OptionalJwtGuard`.
- Сервис `TrainLobbySummaryService.build(userId)` агрегирует
  5 источников через `Promise.all`:
  - `User.ratingPuzzle` + weekly delta из `PuzzleAttempt`.
  - `PuzzleRushAttempt` MAX(score) + last attempt.
  - `TacticDrillRating` (если есть) + count attempts.
  - `UserPrecisionRating` (ADR-079) + ср. score из `PrecisionAttempt`.
  - `OpeningRepertoire` count + (M2-aware) `OpeningLineProgress` agg.
- ResumeSession: упрощённый алгоритм §4.2 (Opening Trainer
  открытая сессия > Precision <24h; остальные модули — null).
- Graceful: если запрос к одному источнику падает — поле = null,
  страница работает.
- Cache 60s in-process per userId (`Map<userId, {data, ts}>`,
  TTL-чек на read).
**Acceptance:**
- Залогиненный с историей: все 5 полей содержат данные.
- Гость: все user-metrics = null, resumeSession = null.
- Новый user (без attempts): все nullable = null, counters = 0.
- Один источник падает — endpoint всё равно 200 с null-полем.
- Юнит-тесты на 4 сценария + интеграционный happy-path.

### KS-3374 (F1) — компоненты `TrainingHeroCard` / `TrainingSecondaryCard` / `ResumeSessionCard`

**Assignee:** frontend.
**Labels:** `onboarding`.
**Зависит:** KS-3372.
**Описание:**
- Три новых компонента в `apps/web/src/components/train/`:
  - `TrainingHeroCard.tsx`: title + rating + Δ-неделя + last activity
    + CTA «Начать решать» (→ `/puzzles`).
  - `TrainingSecondaryCard.tsx`: title + icon-accent + metric или
    CTA. Принимает props `{ kind, title, icon, accentColor,
    metric, cta, href }`.
  - `ResumeSessionCard.tsx`: full-width баннер с label + CTA
    «Продолжить →». Скрыт если `resumeSession == null`.
- В `TrainingHeroCard` поддержать оба состояния: с метрикой и
  без (CTA «Попробовать» / «Начать»).
**Acceptance:**
- Все 3 компонента отдельно тестируемы (jest).
- Hero показывает 4 разных state: с данными / без данных / гость
  / loading.
- Secondary card принимает все 4 вариации (puzzle-rush, drills,
  precision, openings).

### KS-3375 (F2) — обновление `TrainLobbyPage` + отмена desktop-redirect

**Assignee:** frontend.
**Labels:** `onboarding`.
**Зависит:** KS-3374, KS-3373.
**Описание:**
- Заменить текущий 5-карточный grid на:
  - `<ResumeSessionCard />` (опц.).
  - `<TrainingHeroCard kind="puzzles" />`.
  - 2×2 grid из `<TrainingSecondaryCard />` (puzzle-rush, drills,
    precision, openings).
- Убрать `if (!isMobile) return <Navigate to={target} replace />;`
  — теперь desktop тоже показывает лобби.
- Источник данных — `useTrainingSummary()` хук, делает GET
  `/train/summary` при mount, обновляет state.
- Loading state: skeleton-карточки.
- Error state: fallback на текущий 5-card grid без метрик.
- Обновить тесты `TrainLobbyPage.test.tsx`.
**Acceptance:**
- На mobile видны hero + 2×2 grid + (опц.) resume.
- На desktop то же (без redirect).
- Loading: skeleton.
- При ошибке `/train/summary` — fallback на старое 5-card.
- Test: redirect-теста больше нет; добавлены тесты на hero +
  resume-логику.

### KS-3376 (F3, опц.) — i18n обновление

**Assignee:** frontend.
**Labels:** `onboarding`, `i18n`.
**Зависит:** KS-3374.
**Описание:**
- Добавить ключи `train.hero.cta` («Начать решать»),
  `train.secondary.<kind>.metric.empty` («Попробовать»),
  `train.resume.cta` («Продолжить →»), и т.д.
- Убрать (или обновить) `train.lobby.subtitle`.
- RU + EN.
**Acceptance:**
- Все hardcoded строки в новых компонентах вынесены в i18n.
- Существующие ключи `train.lobby.*` остаются работать (легаси).

### KS-3377 (L1) — CSS hero + secondary + resume + цвета + mobile-адаптив

**Assignee:** layout.
**Labels:** `onboarding`, `mobile`.
**Зависит:** KS-3374, KS-3375.
**Описание:**
- CSS для `.training-hero-card`: gradient/accent на иконке, large
  rating (24px), Δ-badge, CTA-button full-width на mobile.
- CSS для `.training-secondary-card`: compact (140×140 на mobile),
  color-accent-bar сверху, metric small (12px), CTA-link.
- CSS для `.resume-session-card`: full-width баннер с иконкой ⟳ +
  text + CTA.
- CSS semantic-переменные `--accent-tactics/-rush/-drills/-precision/
  -openings` (HSL, оба theme'а).
- Mobile-first: hero full-width, секондари 2×2 grid с
  `grid-template-columns: 1fr 1fr`. Desktop: hero 60% width +
  секондари 2×2 справа.
- Контраст ≥ 4.5:1 во всех состояниях.
**Acceptance:**
- На viewport 360×844 — без горизонтального скролла, hero +
  resume + 2×2 helmet'ятся.
- На desktop 1280px — hero слева 60%, секондари 2×2 справа.
- В тёмной теме — все цвета читаемы, не «пёстро».
- Playwright-скриншот mobile + desktop в обеих темах — приложить
  к задаче для review.

### KS-3378 (S2, опц.) — изменение ADR-058 §11.5

**Assignee:** architect (закроет тот же агент при выполнении
KS-3375, либо отдельным мелким коммитом).
**Labels:** `onboarding`.
**Описание:**
- В `docs/adr/058-sidebar-restructure.md` §11.5 добавить пометку
  «KS-3375 отменил desktop-redirect на `/puzzles`; `/train`
  теперь полноценный dashboard».
**Acceptance:**
- Один Edit в ADR-058. Не требует коммита кода.

## 9. M2 (отложено)

- Авто-выбор hero по recent activity (если фиксированный «Задачи»
  не сработает в реальности).
- Графики мини-трендов на карточках (mini-sparklines).
- Personalized recommendations («попробуй pin-задачи сегодня»).
- Onboarding-tour для нового пользователя.
- Achievements / streak / гамификация.
- Heatmap активности.
- Расширение группировки до 6+ модулей (когда модули добавятся).

## 10. Откат

- Feature-flag `trainLobbyV2Enabled` в `FeatureFlagsContext`. При
  выключенном — рендерится legacy 5-card layout. По умолчанию
  включён после выкатки.
- Backend endpoint `/train/summary` — additive, удаление не
  ломает старый UI.
- Отмена desktop-redirect — также за тем же флагом; при rollback
  возвращается `Navigate to /puzzles`.
