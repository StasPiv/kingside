# ADR-086. Guess-the-Move — угадывание ходов с сравнением точности (пользователь vs игрок)

Статус: предложен (2026-05-29) — аналитический документ
Связано: KS-3405 (этот ADR), ADR-065 (precision-score / accuracy),
ADR-066 (WDL move-classification), KS-3372 (outcome/rating),
KS-3391/3394 (live WDL-анализ на клиенте), архив партий.

## 1. Контекст

Новая фича: пользователь просматривает партию и угадывает ходы ОДНОЙ
стороны. Если его ход ≠ сыгранному — сравниваем объективную силу
обоих ходов по движковой win-probability/WDL. В конце — две точности:
реального игрока (за кого играли) и пользователя. Пример: игрок
потерял 20% вероятности победы, а пользователь нашёл сильнейший →
сыграл лучше на этом ходу.

Пользователь просит предложить геймификацию.

### Что уже есть (переиспользуем)

- **precision-score** (`packages/shared/src/utils/precision-score.ts`):
  готовая формула accuracy. WDL → win-probability `E = (w + d/2)/1000`;
  per-move accuracy = Lichess-экспонента
  `103.1668·exp(−0.04354·loss%) − 3.1669` (clamp 0..100);
  серия = `0.7·mean + 0.3·min`; звёзды `STAR_THRESHOLDS`
  (5★≥95, 4★≥85, 3★≥70, 2★≥50).
- **move-classification** (`move-classification.ts`, ADR-066): пороги
  loss_E `best≤0.02, good≤0.05, inaccuracy≤0.12, mistake≤0.25,
  blunder>0.25`; `classifyMove()`.
- **wdl.ts**: `wdlSigned`, `wdlOrMateFallback`, `deltaWFromWdl`
  (с POV-инверсией по ходящей стороне).
- **Live WDL-анализ на клиенте** (`useStockfish` /
  `engineAdapter.analyzeLive`): Stockfish WASM/bridge, возвращает
  WDL + PV + multiPV. Precision уже снимает оценки на клиенте.
- **Архив** (`GET /games/:id`, `ArchiveGamePage`): PGN + ходы +
  игроки + навигация по ply. Eval НЕ хранится (auto-review удалён
  KS-2433).
- **PuzzleBoard**: доска с вводом хода (`onPieceDrop`, chess.js).
- **precision_attempts / precision_attempt_moves**: образец схемы
  «попытка + per-move детали».
- **Puzzle Rush / Drill Sprint**: паттерны геймификации (стрики,
  таймер, score, финал-экран, лидерборд).

## 2. UX-флоу

### 2.1 Источник партии

- **M1**: архив (`GET /games/:id`) + загрузка PGN.
- **M2**: свои сыгранные партии, трансляции.

Точка входа: раздел `/guess` (выбор/вставка партии) + кнопка
«Угадай ходы» на странице архивной партии (`ArchiveGamePage`).

### 2.2 Сессия

1. Пользователь выбирает партию + **сторону** (за кого угадывает:
   белые/чёрные).
2. Доска на стартовой позиции. Ходы соперника (не выбранной
   стороны) проигрываются автоматически из PGN.
3. На каждом полуходе выбранной стороны:
   - Доска на позиции ДО хода. Пользователь вводит ход (drag).
   - Система оценивает движком (см. §3) и показывает реакцию:
     - **совпал с игроком** — «Точно как [Игрок]»;
     - **нашёл сильнее реального** — «Сильнее, чем сыграл [Игрок]!
       (+N% точности)»;
     - **слабее** — показ реального хода + дельты;
   - Показ обоих ходов на доске (стрелки: твой / реальный / best),
     loss каждого, classification-бейдж.
   - Кнопка «Дальше» → проигрывается реальный ход (партия идёт по
     реальной линии, не по ходу пользователя — иначе разойдёмся с
     партией), затем автоход соперника, следующая позиция.
4. **Важно:** партия всегда продолжается реально сыгранными ходами
   (мы разбираем конкретную партию, а не играем альтернативную).
   Ход пользователя оценивается, но НЕ меняет течение партии.
5. Навигация: можно листать назад (просмотр), но угадывание —
   вперёд по неугаданным позициям.

### 2.3 Финал

- **Точность пользователя** (precision-композит по его ходам) +
  звёзды.
- **Точность реального игрока** (тот же расчёт по реальным ходам —
  это классическая accuracy игрока в партии).
- Сравнение: «Ты: 87% ★★★★ · [Игрок]: 81% ★★★». Вердикт «Ты сыграл
  точнее!» / «[Игрок] был точнее».
- Список ходов: где нашёл сильнее / совпал / слабее.
- Per-фаза (дебют/миттельшпиль/эндшпиль) — опц. (как precision
  breakdowns).
- Геймификация (§5).

## 3. Логика сравнения хода

Для полухода выбранной стороны в позиции P (`fenBefore`):

1. `E_before` — win-probability выбранной стороны в P. Источник —
   анализ P движком (multiPV=1 даёт best-move + WDL). `E = (w+d/2)/1000`
   POV выбранной стороны.
2. **Реальный игрок** сыграл `playedUci` → `fenAfterPlayed`.
   `E_after_played` = win-probability выбранной стороны там
   (POV-инверсия, как в `deltaWFromWdl`).
   `loss_player = max(0, E_before − E_after_played)`.
3. **Пользователь** сыграл `userUci` → `fenAfterUser`.
   `E_after_user`, `loss_user = max(0, E_before − E_after_user)`.
   Если `userUci == playedUci` — loss идентичен, второй анализ не
   нужен.
4. **accuracy каждого хода** — Lichess-формула от loss
   (precision-score).
5. **Сравнение**: меньший loss = лучше. Вердикт:
   - `loss_user ≤ best-порог (≈0.02)` → «нашёл сильнейший»;
   - `loss_user < loss_player − ε` → «сильнее игрока»;
   - `|loss_user − loss_player| ≤ ε` → «как игрок»;
   - иначе «слабее игрока».
6. **Classification-бейдж** хода пользователя — через `classifyMove`
   (best/good/inaccuracy/mistake/blunder).

**Анализов на угадываемый полуход:** `E_before` (1) +
`E_after_played` (1) + `E_after_user` (1, если ход отличается) =
2-3. Ходы соперника НЕ анализируем (просто проигрываются).

Это та же pre/post-механика, что в precision — переиспользуем
`wdl.ts` + `precision-score.ts`.

## 4. Источник движковых оценок

### M1 — клиент live (как precision)

`useStockfish` / `engineAdapter` анализирует позиции на клиенте.
Никакой новой серверной нагрузки, готовая инфра.

**Снижение задержки через префетч:** `E_before` и `E_after_played`
известны заранее (реальный ход из PGN) — анализируем их, пока
пользователь думает над ходом. После ввода — только `E_after_user`
(если ход отличается). Воспринимаемая задержка ≈ один анализ.

Глубина/лимит — как в precision (фиксированные узлы или depth ~18-20
для быстрой реакции). Качество достаточно для win-probability-
сравнения (не для глубокой теории).

### M2 — серверный eval-кэш партий

Для популярных/трансляционных партий — предрасчёт eval всех
позиций + кэш (таблица `game_eval_cache(gameId, ply, wdl, bestUci)`
или Redis). Даёт мгновенную реакцию и нужен для лидерборда (общая
база сравнения). В M1 не делаем — клиент live достаточно.

## 5. Игровые мотивы

MVP:
1. **Очки за ход:** совпал с игроком — базовые; нашёл сильнее
   реального — бонус; нашёл сильнейший (loss≈0) — макс; слабее —
   меньше/ноль.
2. **«Ты против [Игрок]»** — финальный экран-вызов: твоя точность
   vs точность гроссмейстера. «Ты обыграл [Карлсена] по точности!».
3. **Стрик угадываний:** N ходов подряд ≥ уровня игрока (или best)
   — стрик-бонус (паттерн Puzzle Rush).
4. **Счётчик «сильнее игрока»:** сколько ходов нашёл сильнее
   реального.

M2:
5. **Темы/мотивы** (тэггер ADR-085): «ты нашёл тактику (вилку),
   которую игрок пропустил».
6. **Лидерборд по партии:** кто точнее всех угадал данную партию
   (нужен серверный eval-кэш для общей базы).
7. **Guess-рейтинг** (Glicko по сравнению с best) — сложно
   калибровать, M2/M3.

## 6. Модель данных

По образцу `precision_attempts` + `precision_attempt_moves`:

```prisma
model GuessSession {
  id             String   @id @default(uuid()) @db.Uuid
  userId         String   @db.Uuid
  /// Источник партии: 'archive' | 'pgn' | 'own' (M2) | 'broadcast' (M2).
  gameSource     String
  /// Ссылка на партию (archive gameId / null для inline PGN).
  gameRef        String?
  /// Inline PGN (для source='pgn') или snapshot.
  pgn            String?  @db.Text
  side           String   // 'white' | 'black'
  status         String   // 'active' | 'finished' | 'abandoned'
  userAccuracy   Float?   // precision-композит, null пока не finished
  playerAccuracy Float?
  userStars      Int?
  score          Int      @default(0)
  bestStreak     Int      @default(0)
  betterThanPlayerCount Int @default(0)
  startedAt      DateTime @default(now())
  finishedAt     DateTime?
  @@index([userId, finishedAt])
  @@map("guess_sessions")
}

model GuessMove {
  id            String  @id @default(uuid()) @db.Uuid
  sessionId     String  @db.Uuid
  ply           Int
  fenBefore     String
  playedUci     String
  userUci       String
  eBefore       Float   // win-probability выбранной стороны до
  eAfterPlayed  Float
  eAfterUser    Float
  lossPlayer    Float
  lossUser      Float
  bestUci       String
  userClass     String  // best|good|inaccuracy|mistake|blunder
  verdict       String  // strongest|betterThanPlayer|asPlayer|weaker
  createdAt     DateTime @default(now())
  @@index([sessionId, ply])
  @@map("guess_moves")
}
```

WDL хранить можно как 3 поля или JSON; для UI достаточно `E*` +
class + verdict. Persist даёт review-экран и историю.

**MVP-минимум:** можно без per-move persist (всё на клиенте, в БД
только summary) — но per-move нужен для review-экрана и будущего
лидерборда. Рекомендую persist обоих.

## 7. Переиспользование vs новое

**Готово (переиспользуем):**
- `precision-score.ts` — обе точности + звёзды.
- `move-classification.ts` — бейдж хода.
- `wdl.ts` — win-probability, POV-инверсия.
- `useStockfish`/`engineAdapter` — клиентский WDL-анализ.
- `PuzzleBoard` — доска + ввод хода.
- `archiveApi` / `GET /games/:id` — партия.
- Puzzle Rush / Drill — паттерны геймификации.
- `precision_attempt_moves` — образец схемы.

**Новое:**
- Чистая функция `compareGuessMove(fenBefore, playedUci, userUci,
  engineEvals) → { lossPlayer, lossUser, userClass, verdict }`
  (shared, тестируемая).
- Модель `GuessSession`/`GuessMove` + endpoints (persist).
- UI guess-runner (доска + ввод + live-анализ + реакция + прогресс).
- Финал-экран (две точности + «ты vs игрок» + список + стрик).
- Точка входа (`/guess` + кнопка на ArchiveGamePage + PGN-загрузка).

## 8. Риски

1. **Задержка live-анализа на ход.** Митигация: префетч `E_before`
   + `E_after_played` (известны заранее), анализ `E_after_user`
   после ввода. Лоадер «оцениваю…» если не успели.
2. **Слабое устройство** → медленный WASM-Stockfish. Та же проблема
   что у precision; приемлемо (фича опциональна). M2 — серверный
   кэш для мгновенности.
3. **Партия идёт по реальной линии, не по ходу пользователя** —
   важно для консистентности (мы разбираем конкретную партию).
   Зафиксировано в §2.2.4.
4. **«Точность игрока»** в дебюте бывает 100% (теория) — не путать
   с силой. Это нормально; показываем честно, можно отметить
   «дебютная теория».
5. **Глубина анализа влияет на loss.** Фиксируем лимит, одинаковый
   для played и user хода (честное сравнение в одной глубине).
6. **Promotion/спецходы** — ввод через chess.js (как в puzzle),
   UCI с суффиксом промоции.
7. **Расхождение клиентских eval между устройствами** → точность
   слегка плавает. Для соревновательного режима (лидерборд M2)
   нужен серверный eval (единая база). В MVP — персональный
   разбор, плавание приемлемо.

## 9. Реализация — follow-up задачи

Зависимости: S1 → S2 → B1 → B2; F1 (S1/S2 + useStockfish) → F2 → F3;
L1 после F1/F2.

### KS (S1) — shared types

**Assignee:** backend (shared owner). **Labels:** `analysis`, `puzzle`.
- `GuessSessionDto`, `GuessMoveDto`, `StartGuessSessionRequest`,
  `SubmitGuessMoveRequest/Response`, `FinishGuessSessionResponse`,
  `GuessVerdict = 'strongest'|'betterThanPlayer'|'asPlayer'|'weaker'`.
- Переиспользовать `PrecisionMoveInput`/accuracy-типы.
- Acceptance: TS-сборка чистая; union narrowing на verdict.

### KS (S2) — функция сравнения

**Assignee:** backend (shared). **Labels:** `analysis`, `puzzle`.
**Зависит:** S1.
- `compareGuessMove(fenBefore, playedUci, userUci, evals)` в shared
  utils — на базе `wdl.ts` + `precision-score.ts` + `classifyMove`.
  Чистая, без I/O.
- Acceptance: юнит-тесты — совпал/сильнее/слабее/сильнейший;
  POV-инверсия white/black; promotion.

### KS (B1) — миграция

**Assignee:** backend. **Labels:** `analysis`, `puzzle`, `prisma`.
**Зависит:** S1.
- `guess_sessions` + `guess_moves` (§6).
- Acceptance: `prisma:migrate` чистый; repository CRUD-тест.

### KS (B2) — endpoints сессии

**Assignee:** backend. **Labels:** `analysis`, `puzzle`.
**Зависит:** B1, S2.
- `POST /guess/sessions` (старт: source+gameRef/pgn+side),
  `POST /guess/sessions/:id/move` (persist хода + evals с клиента,
  серверный пересчёт через S2 — server-trust как в precision),
  `POST /guess/sessions/:id/finish` (агрегаты: 2 точности, звёзды,
  стрик), `GET /guess/sessions/:id` (review), `GET /guess/history`.
- **Движок НЕ на сервере в M1** — evals приходят с клиента,
  сервер ПЕРЕСЧИТЫВАЕТ метрики (accuracy/class/verdict) из
  присланных WDL (доверяем WDL, не доверяем accuracy — как
  precision server-trust).
- Acceptance: старт/move/finish/review; owner-check; 2 точности
  считаются; гость — без persist (или 401).

### KS (F1) — guess-runner страница

**Assignee:** frontend. **Labels:** `analysis`, `puzzle`.
**Зависит:** S1, S2.
- `/guess` + runner: доска (PuzzleBoard), автоход соперника из PGN,
  ввод хода выбранной стороны, live-анализ через `useStockfish`
  (префетч E_before + E_after_played), реакция (стрелки твой/
  реальный/best + бейдж + loss), кнопка «Дальше».
- Acceptance: проход партии за выбранную сторону; реакция на
  совпал/сильнее/слабее; партия идёт по реальной линии.

### KS (F2) — финал-экран + геймификация

**Assignee:** frontend. **Labels:** `analysis`, `puzzle`.
**Зависит:** F1, B2.
- Две точности + звёзды + «ты vs [Игрок]» вердикт + список ходов
  (сильнее/совпал/слабее) + стрик + счётчик «сильнее игрока» +
  очки.
- Acceptance: финал показывает обе точности корректно; список
  ходов; геймификация-показатели.

### KS (F3) — точка входа + источники

**Assignee:** frontend. **Labels:** `analysis`, `puzzle`.
**Зависит:** F1.
- Раздел `/guess` (выбор партии: архив-поиск + PGN-вставка) +
  кнопка «Угадай ходы» на `ArchiveGamePage`. Выбор стороны.
- Acceptance: запуск из архива и из PGN; выбор стороны.

### KS (L1) — стили runner + финал + mobile

**Assignee:** layout. **Labels:** `analysis`, `puzzle`, `mobile`.
**Зависит:** F1, F2.
- CSS доски-runner, панели реакции (стрелки/бейджи), финал-экрана,
  прогресс-индикатора. Mobile-адаптив (доска + реакция без
  скролла).
- Acceptance: viewport 360×844 — доска + реакция видны; обе темы.

Frontend-heavy: движок на клиенте (M1), backend — только persist.

## 10. M2 (отложено)

- Серверный eval-кэш партий (мгновенность + лидерборд).
- Лидерборд по партии.
- Свои партии + трансляции как источник.
- Темы/мотивы через тэггер ADR-085.
- Guess-рейтинг (Glicko).
- Per-фаза breakdown на финале.

## 11. Откат

- Фича за feature-flag `guessTheMoveEnabled`. Выключить → раздел
  скрыт, кнопка на ArchiveGamePage не рендерится.
- Таблицы `guess_*` — additive, данные сохраняются при откате
  флага.
- Движок на клиенте — нет серверной нагрузки для отката.
