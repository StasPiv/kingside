# ADR-082. Precision-рейтинг — динамика в UI (тренд-график + delta в истории)

Статус: предложен (2026-05-27)
Связано: KS-3373 (этот ADR), ADR-079 (precision-рейтинг Glicko-1),
ADR-056 (Precision UI), ADR-065 (5-звёздочный score), ADR-057
(Precision UX split: /stats и /history разделены).

## 1. Контекст

После ADR-079 / KS-3341 у пользователя есть собственный
precision-рейтинг (Glicko-1, таблица `user_precision_ratings`).
Каждая попытка пишет `ratingBefore`/`ratingAfter`/`ratingDelta` в
`precision_attempts`. Но в UI динамика **не отображается**:

- `/precision/stats` (`PrecisionTrendsChart`) — график только
  accuracy% per bucket.
- `/precision/history` (`PrecisionAttemptsList`) — попытки со
  звёздами / accuracy, без колонки рейтинговой дельты.
- `/puzzle/:id?source=precision` — после solve показывает разовое
  `ratingBefore → ratingAfter (+N)` (ADR-079 §3.5 / KS-3345), но
  кумулятивно за время это не видно.

Что **уже есть** в shared (нашёл при audit'е):

- `PrecisionAttemptListItem` (`packages/shared/src/types/api-contracts.ts:451-459`)
  **уже содержит `ratingBefore | ratingAfter | ratingDelta`** (KS-3341).
  Backend пишет, response отдаёт — фронт просто не отображает.
- `PrecisionTrendsResponse` (`:631-651`) — содержит accuracy/score
  агрегаты per bucket. **НЕ содержит** rating-метрики.

Это значит: **вариант B (колонка delta в /precision/history) — чисто
frontend задача без backend/shared изменений.** Вариант A (тренд
рейтинга) — требует одного backend-расширения существующего
endpoint'а + одно поле в shared + frontend chart-line.

## 2. Решение — вариант C (оба), но раздельные задачи

### 2.1 Делаем оба

- **Вариант B (колонка delta в /history)** — дешёвый, информативный
  на уровне «что произошло с моим рейтингом сейчас». Идеален для
  быстрого scan-а истории.
- **Вариант A (тренд-график в /stats)** — показывает long-term
  траекторию. Это то, что пользователь явно хочет («хочу видеть
  динамику»).

Они не дублируют друг друга, они **взаимодополняют**: detail-view
+ aggregate-view.

### 2.2 Порядок реализации

B первым (1 задача, без backend) — даёт UX-улучшение немедленно.
A вторым (S+B+F тройка).

Решение «делать оба» — финальное; вопрос порядка решает координатор
при назначении.

### 2.3 Что НЕ делаем

- Не вводим отдельный endpoint `/precision/rating-history` —
  расширяем существующий `/precision/trends/me` одним полем.
  Лишних round-trip'ов не плодим.
- Не показываем rating volatility / RD как отдельную линию —
  это шумно. В compact UX-pill «Рейтинг 1487 (±32)» (ADR-079
  KS-3351) deviation уже виден.
- Не делаем opponent-rating per attempt (хотя есть в БД) — на
  detail-странице attempt'а можно показать, но это не входит в
  scope «динамика рейтинга» MVP.
- Не добавляем экспорт CSV / share-картинку — feature-запрос
  отдельно.

## 3. UX

### 3.1 Вариант B — колонка delta в `/precision/history`

В `PrecisionAttemptsList` каждая строка получает дополнительный
визуальный элемент рядом с accuracy/звёздами:

```
[доска]  ★★★★☆  Acc 83%  ⬆ +12   14:30  →
[доска]  ★★☆☆☆  Acc 38%  ⬇ -8    13:55  →
[доска]  ★★★★★  Acc 96%  ⬆ +18   13:22  →
[доска]  ★★★☆☆  Acc 62%  —       12:48  →   ← null delta (skip)
```

- `+N` / `-N` с цветом (зелёный/красный, но с проверкой
  контраста — красный нейтральный, не агрессивный).
- `—` (em-dash) если `ratingDelta == null` (гость, self-created
  skip, hidden/test-аккаунт, legacy attempt до ADR-079).
- Tooltip на ⬆/⬇: «Рейтинг: 1487 → 1499» (полный before→after).
- Мобильный compact: иконка + число, без подписей «Acc»/«★». Уже
  работает в текущей вёрстке `PrecisionAttemptsList`.

**Фильтр в UI** (опц., M2): toggle «показать только
рейтинговые попытки» (`ratingDelta != null`) — но в M1 не делаем,
большинство попыток рейтинговые.

### 3.2 Вариант A — тренд-график в `/precision/stats`

В `PrecisionTrendsChart` добавляется вторая линия / переключатель:

```
┌────────────────────────────────────┐
│  ◉ Точность   ○ Рейтинг            │  ← переключатель режима
│                                    │
│  1500 ─────╱╲────╱──────╲──── 1500│
│  1400 ──╱─────╲╱──────────╲────── │  ← линия рейтинга (когда выбран)
│  1300 ╱──────────────────────╲────│
│       ┴────┴────┴────┴────┴────┴ │
│      окт   ноя   дек   янв  фев  │
└────────────────────────────────────┘
```

Альтернатива «обе линии сразу» (accuracy + rating с двумя Y-осями)
— технически возможно, но визуально шумно на mobile. **Переключатель**
проще, чище. В desktop M2 можно показывать обе разом.

Тип графика: тот же, что для accuracy (Recharts/Chart.js — что
сейчас в `PrecisionTrendsChart`).

**Точка графика** = `ratingEnd` бакета (рейтинг после последней
попытки в этом бакете). Если в бакете не было попыток (no-activity
period) — точка пропускается, линия рисуется между соседними
известными.

Tooltip на hover: «6–12 ноября: 1487 (+12 за неделю, 8 попыток)».

### 3.3 Что показывать на старте

По умолчанию переключатель в положении «Точность» (как сейчас).
URL-state `?metric=accuracy|rating` сохраняет выбор пользователя.

## 4. API

### 4.1 Вариант B — БЕЗ изменений API

`GET /precision/attempts/me` уже возвращает `ratingBefore/After/Delta`
в `PrecisionAttemptListItem` (KS-3341). Backend изменений НЕТ.

### 4.2 Вариант A — расширение `PrecisionTrendsResponse`

В `packages/shared/src/types/api-contracts.ts` к `points[]`
добавляется:

```ts
interface PrecisionTrendsResponse {
  bucket: 'day' | 'week' | 'month';
  points: Array<{
    bucketStart: string;
    attempts: number;
    preserved: number;
    avgAccuracyPercent: number;
    avgWdlLeakPerMove: number;
    avgScore?: number | null;
    avgScorePct?: number | null;
    /**
     * KS-3373 / ADR-082. Precision-рейтинг пользователя НА КОНЕЦ
     * этого бакета (т. е. `ratingAfter` последней попытки в
     * пределах бакета). `null` если в бакете не было ни одной
     * рейтинговой попытки (всё либо guest, либо self-created
     * skip, либо legacy без ratingBefore/After).
     */
    ratingEnd?: number | null;
    /**
     * KS-3373 / ADR-082. Сумма `ratingDelta` за все рейтинговые
     * попытки бакета (для tooltip «+12 за неделю»). `null`
     * синхронно с `ratingEnd`.
     */
    ratingDelta?: number | null;
  }>;
}
```

Backend (`PrecisionService.getTrendsForUser` или эквивалент в
`apps/api/src/precision/precision.service.ts`):

- Расширяем существующий bucket-aggregation запрос:

```sql
SELECT
  DATE_TRUNC($bucket, created_at) AS bucket_start,
  COUNT(*) AS attempts,
  SUM(...) AS preserved,
  AVG(accuracy_percent) AS avg_accuracy,
  AVG(score) AS avg_score,
  AVG(score_pct) AS avg_score_pct,
  -- KS-3373
  (
    SELECT rating_after
    FROM precision_attempts AS inner_pa
    WHERE inner_pa.user_id = pa.user_id
      AND DATE_TRUNC($bucket, inner_pa.created_at) = DATE_TRUNC($bucket, pa.created_at)
      AND inner_pa.rating_after IS NOT NULL
    ORDER BY inner_pa.created_at DESC
    LIMIT 1
  ) AS rating_end,
  SUM(rating_delta) FILTER (WHERE rating_delta IS NOT NULL) AS rating_delta_sum
FROM precision_attempts pa
WHERE user_id = $userId AND created_at BETWEEN $since AND $until
GROUP BY bucket_start
ORDER BY bucket_start ASC;
```

Альтернатива subquery — `LAST_VALUE(rating_after IGNORE NULLS)` /
window-function. Bench-проверка backend'ом, что эффективнее на
индексе `(user_id, created_at)`.

### 4.3 Никаких новых endpoint'ов

Один endpoint `/precision/trends/me`, расширенный полями.

## 5. Лимиты и безопасность

- Endpoint уже за `JwtAuthGuard` (свой рейтинг — личный).
- Никаких новых rate-limits.
- `ratingEnd` / `ratingDelta` — личные числа, не PII, без
  дополнительных проверок.
- Performance: subquery на bucket — один JOIN на бакет, не
  блокирующий. На 1-2 года истории это ≤ 50 бакетов (week) —
  тривиально.

## 6. Риски

1. **Null-точки на графике.** Период без рейтинговых попыток —
   `ratingEnd: null`. Chart рисует line между соседними известными
   (gap-skip), не падает. Тест на пустой бакет в середине.
2. **Legacy attempts (до ADR-079)** у пользователей не имеют
   ratingBefore/After. В `/history` колонка показывает `—`, в
   тренде они не дают bump, что корректно (рейтинга не было).
3. **Цвет дельты.** `+N` зелёный, `-N` нейтрально-серый/красный
   приглушённый (не пугать). Финал на layout.
4. **Subquery в SQL** — на больших данных может тормозить.
   Бенчмарк backend на 10K attempts; если > 200ms — переход на
   window function.
5. **Двойная Y-ось vs переключатель.** Выбрал переключатель —
   проще и чище. Если пользователь захочет обе линии разом — M2
   нарисуем dual-axis на desktop.

## 7. Реализация — follow-up задачи

### KS-3379 (F1) — delta в `PrecisionAttemptsList`

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** —
**Описание:**
- В `apps/web/src/components/precision/PrecisionAttemptsList.tsx`
  отобразить `ratingDelta` (и tooltip `ratingBefore → ratingAfter`)
  каждой строки. Использовать существующие поля `PrecisionAttemptListItem`.
- `null` → em-dash «—», без tooltip.
- Цвета: `+N` зелёный, `-N` приглушённый (классы CSS-переменные,
  не hex).
- На mobile compact: иконка ⬆/⬇ + число.
- Обновить `PrecisionAttemptsList.test.tsx` (3 строки: positive /
  negative / null).
**Acceptance:**
- Рейтинговые попытки показывают дельту.
- Legacy/skip — «—».
- Tooltip срабатывает на hover (desktop) и tap (mobile).

### KS-3380 (S1) — `ratingEnd` / `ratingDelta` в `PrecisionTrendsResponse`

**Assignee:** backend (shared owner).
**Labels:** `puzzle`, `analysis`.
**Описание:**
- В `packages/shared/src/types/api-contracts.ts`
  `PrecisionTrendsResponse.points[]` добавить опц.
  `ratingEnd?: number | null` и `ratingDelta?: number | null`.
- Update docstring со ссылкой на ADR-082 §4.2.
**Acceptance:**
- TS-сборка без ошибок.
- Backward-compat: legacy-клиенты игнорируют новые поля.

### KS-3381 (B1) — bucket-aggregation `ratingEnd` / `ratingDelta`

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3380.
**Описание:**
- В `PrecisionService.getTrendsForUser` (или where bucket SQL):
  - `ratingEnd` = `rating_after` последней попытки в бакете
    (subquery либо window function — на benchmark).
  - `ratingDelta` = `SUM(rating_delta)` FILTER (где не NULL) per bucket.
- Юнит-тесты: bucket с 0 попыток (null), с 1 попыткой (rating_end = тот же), с N попытками (rating_end = последний, delta = сумма).
**Acceptance:**
- API возвращает поля корректно.
- На пустом периоде нет ошибки, поля null.
- Benchmark на 10K attempts ≤ 200ms p95.

### KS-3382 (F2) — переключатель «Точность ↔ Рейтинг» в `PrecisionTrendsChart`

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`.
**Зависит:** KS-3380, KS-3381.
**Описание:**
- В `PrecisionTrendsChart` добавить переключатель режима
  (`metric: 'accuracy' | 'rating'`). URL-state `?metric=rating`.
- При `metric=rating` рисовать линию по `ratingEnd` (skip null).
- Tooltip: «6-12 ноября: 1487 (+12 за неделю, 8 попыток)».
- Default — accuracy (бэкзард-compat).
- Обновить тест.
**Acceptance:**
- Переключатель меняет график.
- URL `?metric=rating` загружает rating-режим сразу.
- Null-бакеты пропускаются (no-data gap).
- Tooltip показывает rating + delta + attempts.

### KS-3383 (L1, опц.) — стили дельты и переключателя метрик

**Assignee:** layout.
**Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** KS-3379, KS-3382.
**Описание:**
- CSS для `+N` / `-N` цветов (semantic-переменные обе темы,
  контраст ≥ 4.5:1).
- Переключатель метрик — radio-style pill, накладывается на
  заголовок графика.
**Acceptance:**
- На viewport 360×844 — дельта читается, переключатель работает.
- В тёмной теме цвета приглушённые, не агрессивные.

## 8. Откат

- Frontend изменения за компонентом — revert F1/F2 убирает UI без
  потери данных.
- Backend поля `ratingEnd/Delta` в `PrecisionTrendsResponse` —
  additive, legacy-клиенты игнорируют.
- Если убрать новые поля shared — backend перестаёт их отдавать,
  фронт показывает null/`—`.
