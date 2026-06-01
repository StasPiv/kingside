# ADR-088. Blind-board — тренировка «найди фигуру по ходу компьютера»

Статус: принят (2026-06-01, ревизия 3)
Связано: KS-3437 (V1), KS-3483 (V2 — прогрессивная сложность),
KS-3549 (V3 — гибкая длительность уровней),
ADR-081 (training lobby), ADR-086 (guess-the-move),
ADR-076/080 (bottom-sheet).

> **Ревизия 3 (2026-06-01).** Гибкая настройка прогрессии (§16):
> новый параметр `levelDurationRounds` (default 10) + флаг
> `progressionEnabled` (default true). Пользователь может ускорить
> прогрессию, замедлить или полностью отключить («не повышать»).
> Лидерборд расширяется — рекорды с не-дефолтным config'ом
> помечаются бейджем «🛠 custom»; `maxLevel` для лидерборда
> хранится в `User.blindBoardBestLevel` (denorm, точнее чем
> derive для произвольной длительности).

> **Ревизия 2 (2026-05-30).** Прогрессивная сложность поверх
> базовой механики (см. §15). Старт = 3 фигуры; каждые 10
> успешных раундов добавляется фигура (до максимума = 5).
> Базовый алгоритм/анти-чит/UX из §1-14 без изменений.

## 1. Контекст

Новая тренировка. 5 фигур (ферзь, ладья, конь, два слона) ставятся
случайно на пустой доске. Без королей. Игрок НЕ видит фигур —
доска пустая. На каждом раунде компьютер ходит одной из фигур так,
чтобы получилась **ровно одна** «вовлечённая» фигура (атакована
или сама атакует). Игрок, не видя позиции, должен опознать
вовлечённую фигуру: клетка + тип (через промоушн-модал). Цель —
продержаться как можно больше раундов.

Задача — анализ. Пользователь оставил архитектору решить ряд
неоднозначностей.

## 2. Решения по неоднозначностям

### 2.1 Цвета фигур — все одного цвета (белые), без королей

Альтернативы:
- (А) Все 5 фигур ОДНОГО цвета (белые). Без королей.
- (Б) Двух цветов (например, Q+R белые, N+B+B чёрные).

**Выбран (А) — все белые.** Причины:
1. Семантика «атака» в задаче — **геометрический контроль клетки**,
   не «бить фигуру шахматами». Слон одинаково контролирует клетку
   независимо от цвета жертвы.
2. Не нужен chess.js — без королей он не примет позицию. Свой
   минимальный move-generator (~80 строк): 4 типа фигур, движение
   по лучам/прыжкам, препятствие = другая фигура (своя). Это и
   проще, и без хака с фиктивными королями.
3. Нет понятия «бить» — фигуры не съедают друг друга. После хода
   доска по-прежнему содержит все 5 фигур.
4. Цвета (Б) добавляют семантику ходящего/нет, шаха и т.д. — без
   ценности для тренировки.

Препятствия: луч ладьи/слона/ферзя останавливается до своей
фигуры (атака клетки = ход на её клетку формально запрещён, но
**атака для целей задачи засчитывается** — луч «дошёл» до Q,
значит P атакует Q геометрически).

### 2.2 «Этой фигурой» = опознанной игроком (не сходившей)

Формулировка пользователя: «После этого компьютер делает ход уже
этой фигурой с такой же логикой». Грамматически «этой» относится
к ближайшему антецеденту — «фигуру», которую назвал игрок
(вовлечённую жертву/атакующего прошлого хода).

**Выбрано:** на N+1 раунде комп ходит ИМЕННО ТОЙ фигурой, которую
игрок только что опознал. Это **переключение фокуса** между
фигурами — естественно для тренировки памяти позиции (каждый
раунд — другая фигура, цепочка идёт).

Альтернативное прочтение («тот же кусок ходит подряд») —
отвергнуто: статичная фигура, меньше тренировки памяти про
остальные позиции.

**На первом раунде:** компьютер выбирает случайную из 5 фигур.

### 2.3 Что игрок видит / называет

После хода компа доска показывает анимацию хода: **подсветка
from + to + стрелка**, БЕЗ изображения фигуры. Игрок видит «нечто
сходило с e4 на h7».

Что называть? Двойной таргет (атакующий/атакованный) объединяем:
**игрок называет «вовлечённую фигуру»** — её клетку + тип.
- Если P_moved атакует Q → вовлечённая = Q (атакована).
- Если Q атакует P_moved → вовлечённая = Q (атакующая).
- В обоих случаях — единая концепция «фигура, попавшая в новый
  конфликт». UX единообразный, не нужно различать.

Игрок:
1. Кликает по клетке, на которой стоит вовлечённая Q (помнит из
   позиции).
2. Промоушн-модал → выбирает тип Q (Q/R/B/N).

После ответа: правильно → переход к следующему раунду (ходит Q);
неправильно → конец сессии, показ позиции и ответа.

## 3. Алгоритм выбора хода компьютером

Текущая фигура = `target_piece` (на 1-м раунде случайная, далее —
опознанная игроком в прошлом раунде).

```
candidates = []
for move (from→to) of all geometric moves of target_piece:
    simulate: target_piece moves to `to`
    involved = { Q ≠ target_piece :
                 attacks_after_move(target_piece, to, Q.square)
                 ∨ attacks_after_move(Q, Q.square, to) }
    if |involved| == 1:
        candidates.append({ move, target: involved[0] })

if candidates:
    pick = uniform-random(candidates)
    apply pick.move
    expectedAnswer = { square: pick.target.square,
                       pieceType: pick.target.type }
else:
    session ends as 'dead-end' (выход без проигрыша,
                                 best-streak засчитан)
```

`attacks_after_move(piece, fromSquare, targetSquare)` — атакует ли
фигура `piece`, стоящая на `fromSquare`, клетку `targetSquare` с
учётом препятствий (другими фигурами) на доске после хода.

**Граничные случаи:**
- Ход на собственное место (`from == to`) — не рассматриваем
  (фигуры обязаны двигаться).
- Прыжок коня через другие фигуры — разрешено (как в шахматах).
- Атака через свою фигуру (Q атакует Q1 через Q2) — НЕ
  засчитывается (Q2 — препятствие, луч обрывается на нём).

## 4. UX-флоу

### 4.1 Старт сессии

1. Точка входа — `/train/blind-board` (новая training-карточка в
   ADR-081 hero/secondary; M1 — отдельный route).
2. CTA «Начать тренировку». Бэкенд создаёт сессию, выбирает
   случайную расстановку 5 фигур, выбирает первый ход компа,
   возвращает session_id + первый ход (from, to) + опц. стартовую
   позицию для показа (5 сек).
3. **Опция показа стартовой позиции 5 сек** (как в blindfold-
   тренировках) — UX-выбор: либо «холодный старт» (игрок видит
   только пустую доску с самого начала и узнаёт позиции из ходов),
   либо «показ 5 сек» (запомнить → проиграть). Рекомендую
   **холодный старт** (M1): чище, нет «cheat-окна» через
   скриншот. Если методически нужно показ — M2-опция.
4. После показа (если есть) — доска пустеет.

### 4.2 Раунд

1. Доска пустая. Подсветка from+to + стрелка от хода компа. Без
   фигур.
2. Игрок кликает по клетке, на которой, по его памяти, стоит
   **вовлечённая фигура** (атакованная или атакующая).
3. Открывается промоушн-модал (переиспользуем существующий) — 4
   варианта Q/R/B/N. Игрок выбирает.
4. Серверная валидация → ответ:
   - **Правильно** → клиент анимирует «зачёт», обновляет
     счётчик раундов, рендерит следующий ход компа (новая
     подсветка/стрелка).
   - **Неправильно** → клиент показывает где была фигура и какая
     (раскрытие позиции), кнопки «Ещё раз» / «Назад».

### 4.3 Финал

- Раунд закончен: либо ошибка игрока, либо dead-end компа.
- Финал-экран: best-streak текущей сессии, личный рекорд, позиция
  в лидерборде, история раундов (опц.), CTA «Ещё раз».

## 5. Анти-чит

**Позиция держится только на сервере.** Клиент НЕ получает FEN /
типы фигур. Каждый ход компа клиенту отдаётся как `{from, to}` —
просто координаты.

Что клиент знает:
- Стартовую расстановку: ТОЛЬКО если включён «показ 5 сек» (M2-
  опция). В M1 не передаём — холодный старт.
- На каждый раунд: `{from, to}` хода компа.
- После ответа: правильность + (при неудаче) полное раскрытие.

Что клиент НЕ знает:
- Типы фигур на клетках.
- Полный FEN.
- Какая именно фигура «вовлечённая» до отправки ответа.

**Открытие DevTools** ничего полезного не даст — в state клиента
только список координат ходов. Геометрию хода (длина/направление
from→to) игрок видит по подсветке — это **часть челленджа** (он
сам выводит тип фигуры из геометрии хода, и **обязан** для
прохождения тренировки). Это не баг.

Все клики игрока → серверная валидация. Никакой клиентской
«правильно/неправильно» — только сервер знает ответ.

## 6. Однозначность — гарантирована ли всегда

**Нет.** На некоторых расстановках компу может не найти ход с
|involved|=1 для текущей `target_piece`. Эмпирически на 5 фигурах
такие случаи редки (≤ 10-20% позиций — экспертная оценка, нужен
замер на M1), но возможны.

Обработка:
- Если у `target_piece` нет ходов с |involved|=1 → сессия
  завершается с **dead-end** (не проигрыш игрока; current streak
  засчитан + бейдж «загнал компа в угол»).

Альтернативы (отвергнуты):
- Сменить target_piece на случайную → нарушает правило «той же
  фигурой».
- Попытаться |involved|=0 (просто ход без атаки) → ломает
  семантику задачи.

Стартовая расстановка тоже может оказаться без валидных первых
ходов. Решение: при генерации стартовой позиции сервер делает
до 20 попыток подбора случайной расстановки, для каждой проверяет
наличие хотя бы одного хода с |involved|=1 для хотя бы одной
фигуры (стартовый кандидат). Если за 20 попыток не получилось —
ослабляем требование и берём любую (крайне маловероятно).

## 7. Геймификация и метрики

- **Серия (streak)** — раундов подряд без ошибки. Ошибка → конец
  сессии.
- **Best-streak** — личный рекорд, хранится в БД.
- **Лидерборд** — топ best-streak'ов (как Puzzle Rush, M1).
- **Сложность** — M1: фиксированно 5 фигур (Q/R/N/B/B). M2:
  выбор 3/5/7 фигур, разные наборы, тайм-атак.
- **Подсказка** (M2): показать тип фигуры за штраф (-N к streak).
- **Бейдж «загнал компа в угол»** (dead-end) — для UX-радости.

Рейтинг (Glicko) — НЕ в M1 (сложно калибровать на новой механике;
можно после ≥ N сессий).

## 8. Серверная сторона vs клиент

**Всё на сервере** (анти-чит + достоверность).

Сервис `BlindBoardService`:
- `createSession(userId)` → случайная позиция, первый ход, сохранение.
- `submitAnswer(sessionId, { square, pieceType })` → валидация,
  ответ, если правильно — выбор следующего хода компа (новая
  `target_piece` = опознанная), обновление позиции.

Move-generator чисто комбинаторный — без Stockfish, без тяжёлой
логики. Атаки/лучи в shared, чтобы клиент мог их использовать (но
для нашей задачи — только бэк). ~80-100 строк кода.

In-memory state живой сессии: можно держать в Redis (TTL 30 мин
неактивности) + lazy-flush в БД на финале, либо просто в БД (нет
hot path — пользователь думает над ходом секундами/минутами,
read/write не критичны).

Решение: **БД-state** (`blind_board_sessions.currentPosition` JSON),
без Redis-кэша. Простота важнее микросекунд.

## 9. Переиспользование

| Готово | Применение |
|---|---|
| react-chessboard | Доска (пустая, drag disabled, click на клетку, customSquareStyles+customArrows для подсветки from/to) |
| Промоушн-модал (PromotionDialog или подобный, есть в puzzle-flow) | Выбор фигуры Q/R/B/N после клика клетки |
| Puzzle Rush леидерборд | Шаблон leaderboard'а по best-score |
| Drill Sprint UI | Шаблон финал-экрана со streak |
| Auth-flow | Сессии привязаны к userId; гость — только без persist рекорда (или 401) |

**Не нужно:** Stockfish, chess.js (своя move-логика без шахов/
королей).

**Новое:**
- Свой `moveGen` модуль (атаки/лучи 4 фигур) — shared.
- Сервис `BlindBoardService` + endpoints.
- UI runner-страница (пустая доска + клик + промоушн-модал).
- Финал + лидерборд.

## 10. Модель данных

```prisma
model BlindBoardSession {
  id              String   @id @default(uuid()) @db.Uuid
  userId          String?  @db.Uuid              // гость — null (без persist рекорда)
  /// Стартовая расстановка (JSON: [{square, type}, ...]).
  startPosition   Json
  /// Текущая позиция (JSON, обновляется после каждого хода).
  currentPosition Json
  /// Фигура, которой ходит комп СЛЕДУЮЩИМ (для удобства).
  nextTargetPiece Json?    // { square, type } или null после ответа
  streak          Int      @default(0)
  bestStreak      Int      @default(0)  // в этой сессии
  status          String              // 'active' | 'finished' | 'dead-end'
  finishReason    String?             // 'wrong-answer' | 'dead-end' | 'abandoned'
  startedAt       DateTime @default(now())
  finishedAt      DateTime?
  @@index([userId, finishedAt])
  @@map("blind_board_sessions")
}

model BlindBoardAttempt {
  id              String   @id @default(uuid()) @db.Uuid
  sessionId       String   @db.Uuid
  round           Int                            // 1-based
  compMoveFrom    String                         // 'e4'
  compMoveTo      String                         // 'h7'
  expectedSquare  String
  expectedPieceType String                       // 'Q'|'R'|'B'|'N'
  userSquare      String?
  userPieceType   String?
  correct         Boolean
  createdAt       DateTime @default(now())
  @@index([sessionId, round])
  @@map("blind_board_attempts")
}

// Опц. в User:
//   blindBoardBestStreak Int @default(0)  // глобальный рекорд для лидерборда
```

## 11. Реализация — follow-up задачи

Зависимости: S1 → S2 → B1 → B2; F1 (S1) → F2 → F3; L1 после F1/F2.

### KS (S1) — shared types

**Assignee:** backend (shared). **Labels:** `puzzle`, `analysis`.
- `PieceType = 'Q'|'R'|'B'|'N'`, `Square` (a1..h8),
  `BlindBoardPiece = { square: Square; type: PieceType }`,
  `BlindBoardSessionDto`, `StartSessionResponse` (sid + first move
  + опц. show-startup), `SubmitAnswerRequest/Response`
  (`{ correct, expectedSquare?, expectedPieceType?, nextMove? }`),
  `BlindBoardFinishReason`.
- Acceptance: TS-сборка чистая.

### KS (S2) — shared move-generator (атаки/лучи 4 фигур)

**Assignee:** backend (shared). **Labels:** `puzzle`.
**Зависит:** S1.
- Чистые функции в `packages/shared/src/utils/blind-board/`:
  - `geometricMoves(piece, board): Square[]` — все клетки, куда
    фигура может пойти (с учётом препятствий-своих).
  - `attacks(piece, board): Set<Square>` — клетки которые фигура
    атакует (геометрически контролирует, луч до первого
    препятствия).
  - `findUniqueTargetMoves(board, movingPieceCoord):
    Array<{ to, target }>` — кандидаты с |involved|=1.
- Acceptance: юнит-тесты — конь (8 прыжков), ладья/слон/ферзь
  лучи с препятствиями, поиск кандидатов на 5 фикстурах.

### KS (B1) — миграция Prisma

**Assignee:** backend. **Labels:** `puzzle`, `analysis`, `prisma`.
**Зависит:** S1.
- `blind_board_sessions` + `blind_board_attempts` (§10).
- Опц. `User.blindBoardBestStreak`.
- Acceptance: `prisma:migrate` чистый.

### KS (B2) — сервис + endpoints

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S2, B1.
- `BlindBoardService.createSession(userId?)` — генерация
  расстановки (до 20 попыток на валидность), выбор первого хода,
  persist.
- `BlindBoardService.submitAnswer(sessionId, userId?, answer)` —
  валидация (owner-check), сравнение с expected, если правильно
  — выбор следующего хода компа, обновление, ответ. При dead-end
  → finish 'dead-end'. При ошибке → finish 'wrong-answer'.
- Endpoints `POST /blind-board/sessions`, `POST /blind-board/
  sessions/:id/answer`, `GET /blind-board/leaderboard` (top best-
  streak).
- Гость: persist сессии без userId (или без persist вообще — то
  есть state только в Redis на 30 мин). Решение M1: **гость БЕЗ
  persist** (нет лидерборда для гостя, простая логика); auth
  даёт persist + лидерборд.
- Acceptance: 6 юнит-тестов (правильный ответ, ошибка, dead-end,
  гость без persist, лидерборд, owner-check), integration на
  цепочку из 5 раундов.

### KS (F1) — guess-runner страница

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S1, B2.
- `/train/blind-board` (или `/blind-board`). Runner: пустая
  доска (react-chessboard, FEN=`8/8/8/8/8/8/8/8`,
  arePiecesDraggable=false, onSquareClick для ввода).
- Анимация хода компа: подсветка from+to (customSquareStyles) +
  стрелка (customArrows).
- Клик клетки → промоушн-модал (переиспользуем) → submit answer.
- Реакция: правильно → перерисовка следующего хода; неправильно
  → раскрытие позиции + кнопки.
- Acceptance: проход 3 раундов; неправильный ответ показывает
  ожидаемое; гость может играть без persist; сессия не утекает
  типы фигур в DOM (audit DevTools).

### KS (F2) — финал-экран + лидерборд

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** F1, B2.
- Финал: streak, best-streak, личный рекорд (для auth), позиция
  в лидерборде, CTA «Ещё раз».
- Страница `/blind-board/leaderboard` с топом.
- Acceptance: показывает корректные значения; лидерборд работает;
  гость видит финал без рекорда.

### KS (F3) — точка входа в /train

**Assignee:** frontend. **Labels:** `puzzle`, `onboarding`.
**Зависит:** F1, ADR-081 (если уже в работе training-lobby —
координатор синхронизирует).
- Новая training-карточка «Blind-board» в `/train` (как
  secondary-card по ADR-081).
- Acceptance: карточка ведёт на /train/blind-board.

### KS (L1) — CSS + mobile-адаптив

**Assignee:** layout. **Labels:** `puzzle`, `mobile`.
**Зависит:** F1, F2.
- Подсветки клеток (from-цвет, to-цвет), стрелка, анимация ~200ms.
- Промоушн-модал в blind-board контексте — без фон-промоции,
  просто выбор фигуры. Проверить, что подходит UX (если есть
  «продвижение пешки» текст — скрыть/локализовать).
- Финал-экран mobile-friendly.
- Acceptance: viewport 360×844 — без скролла; обе темы.

## 12. M2 (отложено)

- Разные сложности (3/5/7 фигур, разные наборы).
- Показ стартовой позиции 5 сек (опция).
- Подсказка за штраф (тип фигуры по клетке).
- Тайм-атак режим (N секунд на ход).
- Review-режим (после сессии — пройти все ходы с раскрытой
  позицией).
- Рейтинг (Glicko по best-streak'ам после калибровки).
- Два цвета фигур (вариант (Б) §2.1) — если методически нужно.

## 13. Риски

1. **Однозначность не всегда достижима.** Митигация §6 (dead-end
   как валидный финал, не проигрыш).
2. **Стартовая расстановка без валидных ходов.** Митигация: до
   20 попыток подбора при создании сессии.
3. **Геометрия хода частично раскрывает тип фигуры.** Это
   ожидаемо — часть челленджа (игрок выводит тип из направления
   хода). Не баг.
4. **Промоушн-модал семантически другой.** Может содержать текст
   «Выберите фигуру для превращения». Проверить L1, либо
   локализация условная, либо отдельный variant модала.
5. **Гость без persist** — лёгкая UX-несимметрия. Можно сделать
   in-memory сессию (без БД) для гостя, либо просто 401. M1 —
   401 проще; M2 — guest-режим если будет спрос.
6. **Лидерборд читерство** (множественные сессии). Persist
   bestStreak only на финале корректной сессии; rate-limit на
   создание сессий (`@UserRateLimit(20, 3600)`).
7. **Move-generator баги.** Чистая комбинаторика — юнит-тесты
   фикстурами критичны (5 тестов на каждую фигуру минимум).

## 14. Откат

- Feature-flag `blindBoardEnabled` (как drillsEnabled / lessonsEnabled).
- Таблицы additive — данные сохраняются при откате флага.
- Move-generator в shared — чистый, не влияет на остальной код.
- Промоушн-модал — расширение или вариант (не ломает существующий).

---

## 15. Ревизия 2 — прогрессивная сложность (KS-3483)

### 15.1 Запрос пользователя

«Начинаем с 3 фигур. После серии из 10 угадываний добавляем ещё
одну фигуру, и так далее».

### 15.2 Уточнения пользователя (после черновика V2)

- **Дефолтный стартовый набор:** Q + N + R (3 фигуры).
- **Дефолтный порядок добавления:** B (→ 4) → B (→ 5) → R (→ 6)
  → N (→ 7).
- **Максимум 7 фигур:** 1Q, 2R, 2B, 2N.
- **Override:** игрок может в настройках сессии выбрать свой
  стартовый набор и свой порядок добавления.

### 15.2.1 Финальные ответы (после черновика open questions)

- **minStart = 3** (Q1 закрыт; «начинаем с 3» строго).
- **Expert-start с 7 фигурами — разрешён** (Q2 закрыт; addOrder
  пустой → нет уровней, фиксированная сложность).
- **Лидерборд показывает достигнутый уровень** рядом со streak,
  формат «28 · L3» (Q6 закрыт).
- **Memorize-time — настройка игрока в UI** (Q7 закрыт). Пресеты
  3 / 5 / 10 секунд, дефолт 5. Применяется И к стартовому
  memorize, И к level-up overlay.

### 15.3 Конфигурация уровней (дефолтная)

| Уровень | Раунды | Состав | Дельта |
|---|---|---|---|
| L1 | 1–10 | Q, N, R | старт |
| L2 | 11–20 | Q, N, R, B | + B (1-й слон) |
| L3 | 21–30 | Q, N, R, B, B | + B (2-й слон, разнопольный) |
| L4 | 31–40 | Q, N, R, B, B, R | + R (2-я ладья) |
| L5 | 41+ | Q, N, R, B, B, R, N | + N (2-й конь). Максимум. |

После L5 (раунды 41+) состав не меняется, streak продолжает
расти. **Без override** прогрессия — фиксированная.

### 15.4 Override игроком

На лендинге blind-board (`BlindBoardLandingPage`) — раскрывающийся
блок «Настройки сложности» (свёрнут по умолчанию, дефолты в
заголовке: «Старт: 3 (Q+N+R), порядок: B,B,R,N»).

**Селектор стартового набора:**
- Counter-selector по типам: `[Q ▾ 1]` `[R ▾ 1]` `[B ▾ 0]`
  `[N ▾ 1]`. Сумма ≥ minStart.
- Ограничения квот (§15.5).

**Селектор порядка добавления:**
- Сортируемый список с drag&drop (или up/down кнопки): `1: B`,
  `2: B`, `3: R`, `4: N`.
- Каждая позиция — выбор типа фигуры из доступных по квоте.
- Можно удалить позицию (меньше уровней).
- Если start уже содержит 7 фигур — addOrder пустой (уровней
  нет, играем как фиксированную сложность).

CTA «Начать» с выбранными настройками или дефолтами. LocalStorage
сохраняет выбор для quick-retry.

### 15.5 Ограничения квот

Максимальные квоты на доске:
- **Q**: max 1.
- **R**: max 2.
- **B**: max 2 (требование разнопольности — §15.6).
- **N**: max 2.

Сумма max = 7. **`minStart = 3`** (подтверждено пользователем,
§15.2.1).

Каждое последующее добавление — фигура из остатка квоты. Frontend
валидация UI + backend re-validation на старте сессии.

### 15.6 Разнопольность слонов (расширение KS-3449)

- **Add 2-й B через level-up** — backend выбирает клетку
  противоположного цвета относительно уже стоящего B (как
  KS-3449).
- **Старт с 2 B сразу** (override) — backend размещает на клетках
  разных цветов: 1-й B на случайной, 2-й на случайной пустой
  противоположной.

На 64-клеточной доске с ≤ 7 фигурами всегда есть свободные
клетки обеих цветностей; pathological case невозможен.

### 15.7 Алгоритм level-up в backend

В `BlindBoardService.submitAnswer` после успешного ответа:

```
session.streak++
if hasNextLevelInConfig(session) AND session.streak % 10 === 0:
  newPiece = session.startConfig.addOrder[session.level - 1]
              // L1 → addOrder[0], L2 → addOrder[1]...
  newSquare = pickRandomEmptySquare(currentPosition,
                                    colorConstraint(newPiece))
  currentPosition.push({ square: newSquare, type: newPiece })
  session.level++
  return { ..., levelUp: { newLevel, newPiece, newSquare } }
// иначе обычный flow
generateNextCompMove(...)
```

`computeLevel(streak)` = `Math.floor(streak / 10) + 1`.
`hasNextLevelInConfig` = `session.level - 1 < addOrder.length`.

### 15.8 UX перехода уровня — обновлённый memorize

При level-up в SubmitAnswerResponse фронт получает `levelUp`-поле:

- Overlay поверх runner-а: доска со ВСЕМИ текущими фигурами
  (старые + новая), новая **подсвечена 1.5 сек**.
- Подпись «Уровень 2 — добавился слон на e5».
- Таймер 5 сек → доска снова «слепая», продолжается раунд с
  новым ходом компа.

Этот вариант (Б из черновика) предпочтительнее «отдельного экрана
только новой» (теряем контекст) и «текста без визуала» (нет
зрительного якоря).

HUD во время игры:
- Текущий уровень: «L2 · 14/20 → +B на L3» (мотивация).

### 15.9 Streak ломается → level не сохраняется

После wrong-answer сессия завершается (`finishReason='wrong-answer'`).
Новая сессия начинается с L1 (= user-config или дефолт). Best-
streak в лидерборде остаётся прежним (max по всем сессиям).

### 15.10 Хранение

Расширение `BlindBoardSession`:
- `level Int @default(1)` — текущий уровень (1..N).
- `startConfig Json @map("start_config")` — snapshot конфигурации
  сессии: `{ startPieces: PieceType[], addOrder: PieceType[],
  memorizeTimeSec: number }`. Хранится для review, для нахождения
  следующей фигуры при level-up и для применения memorize-time
  на стартовом экране и при level-up overlay (без зависимости
  от user-prefs, которые могли поменяться).
- `currentPosition` уже хранится — добавление фигур обновляет.

Backfill existing-сессий: `level=1`, `startConfig={ ...DEFAULT,
memorizeTimeSec: 5 }`.

Опц. (M2) `BlindBoardAttempt.levelAtRound Int?` для аналитики.

### 15.11 Лидерборд

Текущий лидерборд (`bestStreak`) работает корректно — высокий
streak теперь объективно сложнее. **Показываем достигнутый
максимальный уровень** рядом со streak (формат «28 · L3»,
подтверждено §15.2.1). Источник level — derived из streak (`max
level reached = computeLevel(bestStreak)` на момент достижения
рекорда) либо денормализованный в `User.blindBoardBestLevel` —
выбор реализации backend.

### 15.12 Что НЕ делаем (M1 ревизии 2)

- НЕ персистируем user-config в БД отдельно (только в
  `startConfig` snapshot сессии + localStorage).
- НЕ добавляем `levelAtRound` per-attempt (опц. M2).
- НЕ меняем memorize-time с уровнем автоматически — это **выбор
  игрока** в UI (пресеты 3/5/10, §15.2.1).
- НЕ ограничиваем 7-figure start (expert-mode разрешён §15.2.1).

### 15.13 Реализация — follow-up задачи (V2)

Базовая инфра ADR-088 реализована. Дельта:

#### KS (S2) — shared types V2

**Assignee:** backend (shared). **Labels:** `puzzle`, `analysis`.
- В `BlindBoardSessionDto` добавить `level: number`, `startConfig:
  BlindBoardConfig`.
- `BlindBoardConfig = { startPieces: PieceType[]; addOrder:
  PieceType[]; memorizeTimeSec: number }`.
- В `SubmitAnswerResponse` опц. `levelUp?: { newLevel, newPiece,
  newSquare }`.
- Константы `BLIND_BOARD_LIMITS`: `maxQ=1, maxR=2, maxB=2, maxN=2,
  minStart=3, maxTotal=7`, `memorizeTimePresets = [3, 5, 10]`,
  `defaultMemorizeTimeSec = 5`.
- `BLIND_BOARD_DEFAULT_CONFIG = { startPieces: ['Q','N','R'],
  addOrder: ['B','B','R','N'], memorizeTimeSec: 5 }`.
- Acceptance: TS-сборка чистая.

#### KS (B0-v2) — миграция Prisma

**Assignee:** backend (prisma). **Labels:** `puzzle`, `prisma`.
- В `BlindBoardSession`: `level Int @default(1)` + `startConfig
  Json @map("start_config")`. JSON-shape включает
  `memorizeTimeSec`.
- Опц. (для лидерборда) `User.blindBoardBestLevel Int @default(1)`
  (либо считать derived из bestStreak; backend решает).
- Backfill: existing-сессии получают `level=1` и `startConfig=
  { startPieces:['Q','N','R'], addOrder:['B','B','R','N'],
  memorizeTimeSec: 5 }` через SQL UPDATE WHERE.
- Acceptance: миграция чистая; backfill применён.

#### KS (B1-v2) — `createSession` принимает config

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S2, B0-v2.
- DTO `StartBlindBoardSessionRequest.config?: BlindBoardConfig`
  (опц., null → DEFAULT_CONFIG).
- Валидация: квоты (§15.5), длина start ≥ minStart, sum
  start+addOrder ≤ maxTotal, разнопольность 2 B при старте
  (§15.6).
- Генерация стартовой позиции с учётом color-constraint.
- Acceptance: дефолт → Q+N+R; override → старт по config;
  невалидный → 400.

#### KS (B2-v2) — `submitAnswer` обработка level-up

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B1-v2.
- После успешного ответа: если есть следующая фигура в
  `addOrder` и `streak % 10 === 0` → выбрать random empty square
  (с color-constraint для B), добавить в `currentPosition`,
  `session.level++`, вернуть `levelUp` в response.
- Acceptance: на 10-м correct ответ содержит levelUp; на 11-м
  — обычный; разнопольность 2-го B; после исчерпания addOrder
  нет level-up.

#### KS (F1-v2) — UI настроек сложности на лендинге

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S2.
- На `BlindBoardLandingPage` раскрывающийся блок «Настройки
  сложности» (свёрнут).
- Counter-selector startPieces (с подсветкой нарушений квот;
  валидация `minStart=3`).
- Sortable список addOrder (drag&drop или up/down).
- **Memorize-time селектор** — pill-toggle на 3 пресета: 3с /
  5с / 10с (дефолт 5).
- LocalStorage сохранение всего config (включая memorizeTimeSec).
- Acceptance: дефолт → CTA enabled (Q+N+R, addOrder=B,B,R,N,
  memorize=5); нарушение квоты или start<3 → disabled CTA с
  tooltip; expert-start 7 → addOrder скрыт/пуст, CTA enabled;
  config сохраняется в localStorage.

#### KS (F2-v2) — Runner: HUD + level-up overlay

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B2-v2.
- В `BlindBoardSessionRunner`:
  - HUD-pill «L2 · 14/20» в углу доски.
  - На `levelUp` в SubmitAnswerResponse → overlay memorize-
    экрана: 1.5с подсветка новой + **таймер
    `session.startConfig.memorizeTimeSec` секунд** (вместо
    фикс 5), потом раунд продолжается.
  - Стартовый memorize-экран также использует
    `startConfig.memorizeTimeSec` (а не зашитую константу).
- Acceptance: 10-й correct → overlay длиной `memorizeTimeSec`;
  HUD обновляется; непрерывный поток; при `memorizeTimeSec=3`
  overlay показывается 3 сек, при `=10` — 10 сек.

#### KS (L1-v2) — CSS HUD-уровня + overlay

**Assignee:** layout. **Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** F2-v2.
- HUD-pill стиль; overlay блюр доски + центрированная подпись +
  highlight новой клетки.
- Mobile-адаптив.
- Acceptance: viewport 360×844 — HUD и overlay читаются.

Итого **6 новых задач V2** (S2 + B0-v2 + B1-v2 + B2-v2 + F1-v2 +
F2-v2 + L1-v2). Конфликтов с базовой инфрой ADR-088 нет — всё
additive.

### 15.14 Открытые вопросы — закрыты

**Подтверждено пользователем:**
- ✓ Q1 — `minStart = 3` (строго).
- ✓ Q2 — expert-start с 7 фигурами разрешён (addOrder пустой,
  фиксированная сложность).
- ✓ Q3 — backend сам выбирает разные цвета для 2 B при старте
  (как KS-3449 для level-up).
- ✓ Q5 — localStorage для quick-retry.
- ✓ Q6 — лидерборд показывает достигнутый уровень («28 · L3»).
- ✓ Q7 — memorize-time = user-setting (пресеты 3/5/10, default 5).

**Осталось решить frontend'у (UX-выбор, не блокирует backend):**
- Q4: UX порядка добавления — drag&drop / up-down кнопки /
  dropdowns. Решается при F1-v2.

---

## 16. Ревизия 3 — гибкая настройка прогрессии (KS-3549)

### 16.1 Запрос пользователя

«Сейчас L1→L2→L3 каждые 10 раундов автоматически. Хочу
настраивать длительность каждого уровня вплоть до "никогда не
повышать"».

### 16.2 Решение

Два новых поля в `BlindBoardConfig` (доп. к §15):

- **`levelDurationRounds: number`** — сколько успешных раундов
  на одном уровне до перехода к следующему. Default 10
  (текущее поведение). Пресеты 5 / 10 / 15 / 20 (Open Q2).
- **`progressionEnabled: boolean`** — глобальный switch. Default
  `true`. При `false` — level-up НЕ срабатывает никогда,
  играем фиксированной стартовой сложностью бесконечно.

**Per-level array** (разная длительность для L1/L2/L3) — НЕ в M1
(Open Q1). Один параметр для всех переходов достаточно для
запроса; per-level можно ввести в M2 если потребуется.

### 16.3 Формула level-up V3

В `BlindBoardService.submitAnswer` (заменяет §15.7):

```
session.streak++
if !session.startConfig.progressionEnabled:
  return obычный flow  // прогрессии нет вообще
if hasNextLevelInConfig(session)
   AND session.streak % session.startConfig.levelDurationRounds === 0:
  newPiece = session.startConfig.addOrder[session.level - 1]
  newSquare = pickRandomEmptySquare(currentPosition,
                                    colorConstraint(newPiece))
  currentPosition.push({ square: newSquare, type: newPiece })
  session.level++
  return { ..., levelUp: { newLevel, newPiece, newSquare } }
generateNextCompMove(...)
```

`computeLevel(streak, durationRounds)` = `Math.floor(streak /
durationRounds) + 1`. При `progressionEnabled=false` всегда
возвращает 1 (или, точнее, остаётся на startLevel).

### 16.4 UX в BlindBoardConfigForm (F1-v3)

В раскрывающейся секции «Настройки сложности» (после addOrder,
перед memorize-time) **новая подгруппа «Прогрессия»**:

```
▼ Настройки сложности

  Старт (3..7 фигур): [Q ▾ 1] [R ▾ 1] [B ▾ 0] [N ▾ 1]

  Порядок добавления: [B] [B] [R] [N]   (drag&drop)

  ── Прогрессия ────────────────────
  ☑ Повышать сложность автоматически
     Длительность уровня:
     [ 5 ] [ 10* ] [ 15 ] [ 20 ]   (pill, дефолт 10)

  Memorize-time: [ 3 ] [ 5* ] [ 10 ]   (pill, дефолт 5)
```

При снятии чекбокса «Повышать сложность автоматически»:
- pill «Длительность уровня» disabled (visual greyed).
- pill «Порядок добавления» — disabled или скрыт (не имеет
  смысла без прогрессии). Решение: скрываем (меньше шума), но
  сохраняем значение в state для возврата.
- В заголовке свёрнутой секции показывается «Без повышения».

LocalStorage сохраняет всё (включая `progressionEnabled` +
`levelDurationRounds`).

### 16.5 Лидерборд (B-leader + F-leader)

Текущий (§15.11): `bestStreak` + derive `maxLevel =
floor(bestStreak/10)+1` для дефолта.

**Проблема V3:** derive формула неточна для custom
`levelDurationRounds` (при `=5` уровень другой). При
`progressionEnabled=false` derive ВСЕГДА даёт уровень = 1
(нелогично, у игрока 28 раундов на одном уровне).

**Решение V3:** денормализуем `maxLevel` и флаг конфига в
`User`:

```prisma
model User {
  ...
  blindBoardBestStreak Int @default(0)  // уже есть (KS-3440)
  blindBoardBestLevel  Int @default(1)   // новое V3
  blindBoardBestConfigIsDefault Boolean @default(true)  // новое V3
}
```

При finish-обработке: если `newBestStreak`, в той же транзакции
обновляем `User.blindBoardBestLevel = session.level` (фактический
максимальный уровень из сессии-рекордсмена) и
`blindBoardBestConfigIsDefault = isDefaultConfig(session.
startConfig)`.

`isDefaultConfig(config)`:
- startPieces === DEFAULT.startPieces
- addOrder === DEFAULT.addOrder
- levelDurationRounds === 10
- progressionEnabled === true
- memorizeTimeSec === 5 (V2)

**Лидерборд UI V3:**

```
🏆 Слепая доска
─────────────────────────────
1. user_a    34 раундов · L4
2. user_b    28 раундов · L3
3. user_c    27 раундов · L4  🛠
4. user_d    20 раундов · L2
```

Бейдж **🛠** рядом со streak/level если запись установлена с
не-дефолтным config'ом. Без бейджа = дефолтная прогрессия.

Семантика: рекорды custom-config не дискриминируются (один
общий лидерборд = одна линия мотивации), но прозрачно помечаются.
Любопытные могут навести на бейдж и увидеть «custom config:
levelDurationRounds=5, без повышения, и т.д.» (tooltip).

**Альтернативы (отвергнуты):**
- Отдельные лидерборды per-config — комбинаторно много.
- Только default config в лидерборде — жёстко, дискриминирует
  expert-mode (старт 7, expert-mode тоже достижение).
- Без бейджа (общий зачёт без указания config) — несправедливо
  (рекорд `progressionEnabled=false` со старт 3 фигуры всегда
  даст streak больше, чем с прогрессией).

### 16.6 Хранение (V3)

Расширение `BlindBoardSession.startConfig` JSON-shape:
- `startPieces: PieceType[]` (V2)
- `addOrder: PieceType[]` (V2)
- `memorizeTimeSec: number` (V2)
- **`levelDurationRounds: number`** (V3, default 10)
- **`progressionEnabled: boolean`** (V3, default true)

`BlindBoardSession.level Int` (V2) — текущий уровень при
`progressionEnabled=true`; при `false` всегда 1.

`User.blindBoardBestLevel Int @default(1)` (V3) — denorm для
лидерборда.

`User.blindBoardBestConfigIsDefault Boolean @default(true)` (V3)
— флаг рекордной сессии.

**Backfill V3:** existing sessions получают
`startConfig.levelDurationRounds=10`, `progressionEnabled=true`.
existing `User.blindBoardBestLevel = floor(blindBoardBestStreak/10)+1`
(derive из существующего рекорда), `blindBoardBestConfigIsDefault=
true` (все existing рекорды установлены с дефолтным config'ом —
он был единственным до V2/V3).

### 16.7 Что НЕ делаем (M1 ревизии 3)

- НЕ вводим per-level array длительностей (Open Q1, M2 если
  понадобится).
- НЕ создаём отдельные лидерборды по config'у.
- НЕ позволяем кастомные числовые input для длительности —
  только пресеты pill (Open Q3).
- НЕ ретроактивно меняем `User.blindBoardBestConfigIsDefault` для
  существующих рекордов (см. §16.6 backfill — всё default).

### 16.8 Реализация — подзадачи V3 (расширения V2)

Зависимости: S2-v3 → B0-v3 → B-update (level-up + finish-hook) →
F-leader; F1-v3 параллельно.

#### KS (S2-v3) — shared types: levelDurationRounds + progressionEnabled

**Assignee:** backend (shared). **Labels:** `puzzle`, `analysis`.
- В `BlindBoardConfig`: `levelDurationRounds: number` + `progressionEnabled:
  boolean`.
- В `BLIND_BOARD_DEFAULT_CONFIG`: `levelDurationRounds: 10`,
  `progressionEnabled: true`.
- `LEVEL_DURATION_PRESETS = [5, 10, 15, 20]`.
- В `BlindBoardLeaderboardEntry` (если есть в shared) — добавить
  `bestLevel: number` + `isDefaultConfig: boolean`.
- Acceptance: TS-сборка чистая.

#### KS (B0-v3) — миграция Prisma

**Assignee:** backend (prisma). **Labels:** `puzzle`, `prisma`.
- `User.blindBoardBestLevel Int @default(1)`.
- `User.blindBoardBestConfigIsDefault Boolean @default(true)`.
- Backfill startConfig в existing sessions с
  `levelDurationRounds=10`, `progressionEnabled=true`.
- Backfill `User.blindBoardBestLevel = floor(blindBoardBestStreak
  / 10) + 1` для всех users.
- Acceptance: миграция чистая, backfill применён.

#### KS (B-update) — `submitAnswer`: учёт `levelDurationRounds` + `progressionEnabled`; finish: обновление User.*

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S2-v3, B0-v3.
- В `BlindBoardService.submitAnswer` — формула level-up по
  §16.3: skip при `!progressionEnabled`, иначе
  `streak % levelDurationRounds === 0`.
- В finish-обработке: если `session.streak > User.blindBoardBestStreak`
  — атомарно обновить `User.blindBoardBestStreak/Level/
  ConfigIsDefault` из session (level и isDefaultConfig).
- `isDefaultConfig()` helper в shared (или backend), сравнивает с
  DEFAULT_CONFIG.
- Acceptance: при `progressionEnabled=false` — no level-up; при
  `levelDurationRounds=5` — level-up на 5/10/15...; при finish
  с новым рекордом обновлены 3 поля User.

#### KS (F1-v3) — UI «Прогрессия» в BlindBoardConfigForm

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** S2-v3.
- Чекбокс «Повышать сложность автоматически» (default on).
- Pill-toggle «Длительность уровня» (5/10/15/20, default 10).
- При снятом чекбоксе — pill длительности disabled, addOrder
  скрыт.
- LocalStorage сохраняет `progressionEnabled` +
  `levelDurationRounds`.
- В заголовке свёрнутой секции — «Без повышения» если off.
- Acceptance: дефолт = on + 10; off → CTA enabled, addOrder
  скрыт; localStorage; квоты не нарушаются.

#### KS (F-leader) — обновление лидерборда: бейдж config

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B-update.
- На странице лидерборда `/blind-board/leaderboard` — рядом со
  streak/level показывать бейдж **🛠** если `!isDefaultConfig`.
- Tooltip на бейдже — «Custom config» (или раскрытие в
  hover: levelDurationRounds=5, etc.) — опционально M2.
- Acceptance: рекорды с дефолтным config — без бейджа; с custom
  — с бейджем; tooltip опционально.

#### KS (L1-v3) — CSS «Прогрессия»-блока + бейджа лидерборда

**Assignee:** layout. **Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** F1-v3, F-leader.
- CSS подгруппы «Прогрессия» (toggle + pill).
- Бейдж «🛠» — компактный иконочный.
- Mobile-адаптив.
- Acceptance: viewport 360×844 — настройки помещаются;
  лидерборд с бейджем читается.

Итого **5 задач V3** (S2-v3 + B0-v3 + B-update + F1-v3 +
F-leader + L1-v3). Всё additive к V2.

### 16.9 Open questions V3

1. **Per-level array** `levelDurations[]` (разные L1/L2/L3 длины)
   — M2 (моё) или сразу M1? Один параметр покрывает запрос.
2. **Пресеты `levelDurationRounds`** — `[5, 10, 15, 20]` (моё) или
   другие (например `[3, 5, 10, 15, 25]`)?
3. **Кастомное число** в input (override пресетов) — позволять
   или только pill?
4. **Бейдж лидерборда** — единый «🛠 custom» (моё) или градации
   («⚡ fast / 🐢 slow / 🛠 no-progression»)? Tooltip с деталями
   — M2.
5. **Денормализация `User.blindBoardBestLevel/ConfigIsDefault`**
   (моё) vs derive через JOIN на сессию-рекордсменку? Денорм
   проще и быстрее (одна запись пишется в finish-hook).
6. **Backfill `isDefaultConfig=true`** для всех existing — все
   рекорды были установлены до V3, на default config'е. Это
   правильно (моё). Подтвердить.
7. **`progressionEnabled=false`** — нужно ли в UI визуально
   как-то поощрять (бейдж «Без повышения» в HUD во время
   тренировки)? UX-bonus, не блокер.
