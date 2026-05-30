# ADR-089. Guess → Analysis — формирование разбора с NAG из guess-сессии

Статус: предложен (2026-05-30) — аналитический документ
Связано: KS-3459 (этот ADR), ADR-086 (guess-the-move), KS-3426
(verdict-логика), KS-3433 (Lichess accuracy), ADR-066 (WDL
move-classification), ADR-051 (analyses share).

## 1. Контекст

Цитата пользователя: «В разборе тренажёра угадай ход надо
формировать новый анализ с расставленными nag и добавлять ссылку
на него. Игрок может проверить свои ошибки на движке».

Цель: после finish guess-сессии — кнопка «Разобрать в анализе» на
финал-экране, по клику создаётся новый Analysis с PGN партии и
размеченными NAG'ами (ошибки игрока в основной линии, альтернативы
пользователя как варианты с NAG verdict'ом), пользователь
переходит в `/analysis/:id` для глубокой работы с движком.

## 2. Проверено по коду (без выдумок)

### 2.1 Источник — `GuessSession` + `GuessMove`

`packages/db/prisma/schema.prisma:531-590`:

- `GuessSession`: `id, userId, gameSource ('archive'|'pgn'|'own'|
  'broadcast'), gameRef, pgn (TEXT — snapshot партии), side, status,
  userAccuracy, playerAccuracy, userStars, score, bestStreak,
  betterThanPlayerCount, startedAt, finishedAt`.
- `GuessMove`: `sessionId, ply, fenBefore, playedUci, userUci,
  bestUci, eBefore, eAfterPlayed, eAfterUser, lossPlayer, lossUser,
  accuracyPlayer, accuracyUser, userClass ('best'|'good'|
  'inaccuracy'|'mistake'|'blunder'), verdict ('strongest'|
  'betterThanPlayer'|'asPlayer'|'weaker'), createdAt`.

Контроллер `apps/api/src/guess/guess.controller.ts:22` —
`@UseGuards(JwtAuthGuard)`. Гостей нет (для всех endpoint'ов нужен
userId).

### 2.2 Целевая структура — `Analysis`

`schema.prisma:707-740`:

- `Analysis`: `id, userId, title, headline, pgn (TEXT), fen, opening,
  event, site, pgnDate, round, white, black, whiteElo, blackElo,
  result, category ('analysis'|'game_review'|'puzzle'), tags,
  currentPosition, boardOrientation, isPublic, sourceHash,
  lichessGameId, archiveGameId, lastOpenedAt, createdAt, updatedAt`.
- PGN — обычное TEXT-поле, любой формат (chess.js#loadPgn парсит
  варианты `()` и NAG `$N`).

Создание — `AnalysisService.create(userId, dto)` (`analysis.service.ts:382`).
`CreateAnalysisDto` (`dto/create-analysis.dto.ts`): `title?, pgn?,
fen?, category?, lichessGameId?, archiveGameId?`. Дедуп по
`sourceHash` (по lichess/archive id или pgn-hash).

**Никаких полей про guess-source в Analysis сейчас нет** — для
дедупа повторного клика нужно добавить (см. §6.3).

### 2.3 Финал-экран

`apps/web/src/components/guess/GuessFinalScreen.tsx` принимает
`moves: GuessMoveDto[]` + `finalResult: FinishGuessSessionResponse`.
Уже умеет конвертировать UCI→SAN через `chess.js` (фикстура
`uciToSan(fen, uci)`). Туда добавляется кнопка.

## 3. Преобразование — основная линия = партия, варианты = ходы пользователя

### 3.1 Выбор подхода

Два варианта:
- **A.** Основная линия = реальная партия (из `session.pgn`).
  Альтернативы пользователя (`userUci ≠ playedUci`) — как варианты
  `(...)` с NAG.
- **B.** Основная линия = ходы пользователя. Реальные — в комментариях.

**Выбран A** — единственно корректный:
- Партия осмысленна только в реальной последовательности (после
  хода пользователя позиция отличается, реальные ходы соперника
  туда не подходят).
- Пользователь играет только за ОДНУ сторону (`session.side`) —
  ходы другой стороны он не угадывает; собрать «партию пользователя»
  технически нельзя.
- Семантика «вариант» в PGN ровно об этом: «вот ещё ход в той же
  позиции».

### 3.2 Алгоритм построения PGN

`session.pgn` — исходник партии (snapshot, может уже содержать
заголовки и movetext без вариантов). Алгоритм:

1. **Парс PGN** через `chess.js#loadPgn(session.pgn)`. Получаем
   headers + verbose-history.
2. **Заголовки** копируем в новый PGN дословно (+ опц. дополняем
   `[Annotator "Kingside guess-session"]`).
3. **Movetext** строим вручную (PGN-builder ~100 строк):
   - Идём по `history({verbose:true})`, формируем `1. e4 e5 2. Nf3 …`.
   - Для каждого хода — после его SAN проверяем: есть ли
     `GuessMove` с этим `ply`?
   - **Если есть** → после SAN основного хода:
     - Добавляем **NAG основной линии** (по `lossPlayer` через
       classifyMove — см. §4 «реальный ход»).
     - Если `userUci !== playedUci` — добавляем **вариант**:
       `(<userSan> {комментарий} $NAG)`.
       userSan — через `chess.js.move({from,to,promotion})` на
       `fenBefore` из `GuessMove`.
     - Если `userUci === playedUci` — варианта НЕ вставляем (это
       тот же ход), но NAG основной линии всё равно ставим (показывает
       что игрок сыграл лучшее/мистейк/блан).
4. **Сериализуем** в строку PGN.

**Почему свой PGN-builder, а не `chess.js#pgn()`:** chess.js НЕ
выводит варианты в `pgn()` — это его известное ограничение.
Альтернатива — внешняя библиотека (`@mliebelt/pgn-parser`,
`kokopu`), но добавление зависимости для одной фичи избыточно.
Свой builder простой: токенизация в строку, поддержка `()` и `$N`.

### 3.3 Где живёт PGN-builder

`packages/shared/src/utils/guess-to-pgn/` или
`apps/api/src/guess/pgn-builder.ts` — на бэке (создание идёт там).
Чистая функция: `buildAnnotatedPgn(sessionPgn, side, moves):
string`. Тестируется фикстурами.

## 4. NAG-mapping (таблица)

NAG-коды (PGN-стандарт):
- `$1` = `!` — good move
- `$2` = `?` — mistake
- `$3` = `!!` — brilliant
- `$4` = `??` — blunder
- `$5` = `!?` — interesting
- `$6` = `?!` — dubious / questionable

### 4.1 Основная линия (реальные ходы партии)

По `lossPlayer` (использует те же пороги, что `classifyMove` ADR-066):

| Условие | NAG | Семантика |
|---|---|---|
| `lossPlayer > 0.25` (blunder) | `$4` `??` | Зевок реальной партии |
| `lossPlayer > 0.12` (mistake) | `$2` `?` | Ошибка |
| `lossPlayer > 0.05` (inaccuracy) | `$6` `?!` | Неточность |
| `lossPlayer ≤ 0.05` | — (нет NAG) | Норма |

Эти NAG ставятся **только на ходах выбранной стороны** (где есть
guess_move; противоположная сторона остаётся «как есть» без
аннотаций — это и логично: мы её не оценивали в guess).

### 4.2 Варианты (ходы пользователя, `userUci ≠ playedUci`)

По `verdict` + `userClass`:

| verdict | userClass | NAG | Семантика |
|---|---|---|---|
| `strongest` | (best) | `$3` `!!` | Сильнейший — нашёл best движка |
| `betterThanPlayer` | (good или best) | `$1` `!` | Сильнее реального |
| `asPlayer` | * | (нет NAG) | Равноценен; комментарий «как в партии по силе» |
| `weaker` | `blunder` | `$4` `??` | Зевок |
| `weaker` | `mistake` | `$2` `?` | Ошибка |
| `weaker` | `inaccuracy` | `$6` `?!` | Неточность |
| `weaker` | `good`/`best` | `$5` `!?` | Интересный, но слабее реального |

Случай `verdict='asPlayer' & userUci===playedUci` — вариант
**вообще не вставляем** (тот же ход). NAG основной линии всё равно
ставится по §4.1.

**Zugzwang** — это шахматный концепт, не наш verdict. К текущему
mapping'у не относится; визуализацию zugzwang делать не надо.

## 5. Комментарии в вариантах

Короткий локализованный комментарий внутри варианта `{…}`:

- `asPlayer`: `{Как в партии}`
- `strongest`: `{Сильнейший · точность {accuracyUser}%}`
- `betterThanPlayer`: `{Сильнее реального · {accuracyUser}% vs {accuracyPlayer}%}`
- `weaker` (mistake/blunder/inacc): `{Слабее · потеря {loss%}}`
- `weaker` (good/best): `{Чуть слабее · {accuracyUser}% vs {accuracyPlayer}%}`

Локализация — в момент создания анализа на языке пользователя
(простой текст в PGN, не i18n-ключи — анализ хранится как plain
PGN, дальше используется как любой анализ).

В основной линии — без комментариев (NAG достаточно). Альтернативно
M2 — добавить комментарий на mistake/blunder реального хода
(«игрок сыграл хуже на N%»).

## 6. API

### 6.1 Новый endpoint

```
POST /guess/sessions/:id/to-analysis
  body: {}  (никаких параметров — всё берётся из сессии)
  auth:  JwtAuthGuard (как остальной /guess)
  200:   { analysisId: string, url: string, existing: boolean }
  404:   сессия не найдена / чужая
  409:   сессия не finished (нечего разбирать)
```

Внутри:
1. Owner-check `GuessSession.userId === req.user.id`.
2. Проверка `status === 'finished'`.
3. Дедуп: `Analysis.findFirst({ userId, guessSessionId })` → если
   есть, вернуть `{ existing: true }`.
4. Загрузить `GuessMove[]` по `sessionId`.
5. `pgnBuilder.buildAnnotatedPgn(session.pgn, session.side, moves)`
   → новый PGN с NAG.
6. Делегировать в `AnalysisService.create(userId, { pgn,
   title, category: 'analysis' })`.
7. После create — UPDATE Analysis SET guessSessionId = sessionId
   (см. §6.3 поле).
8. Вернуть `{ analysisId: id, url: '/analysis/' + id, existing: false }`.

Дополнительно: исходный sourceHash дедуп **отключаем** для этого
flow (передаём pgn, без lichessGameId/archiveGameId) — guess-PGN с
NAG другая запись, не должен слиться с уже существующим анализом
этой же партии.

### 6.2 Альтернатива — расширить `CreateAnalysisDto`

Отвергнуто. Расширение `CreateAnalysisDto` опц. `fromGuessSessionId`
размывает API: AnalysisService должен знать про guess-сервис →
циклическая зависимость модулей. Отдельный endpoint в guess-
namespace чище.

### 6.3 Дедуп через `Analysis.guessSessionId`

Миграция: добавить поле `guessSessionId String? @db.Uuid @map(
"guess_session_id")` в `Analysis` + индекс `[userId, guessSessionId]`.

Это:
- даёт идемпотентность endpoint'а (повторный клик не плодит дубли);
- даёт обратную ссылку «этот анализ был создан из guess-сессии X»
  (можно показать badge на странице analysis: «Создан из guess-
  тренировки» + ссылка обратно).

Без этого поля дедуп пришлось бы делать по содержимому PGN или
комбинации hash'ей — менее надёжно.

## 7. UI — ссылка на финал-экране

В `GuessFinalScreen` добавить кнопку **«Разобрать в анализе →»**
рядом с уже существующими кнопками (Играть ещё / Назад):

- onClick → `POST /guess/sessions/:id/to-analysis`.
- Loading-state кнопки (spinner).
- При успехе → navigate `/analysis/:analysisId` (в текущей вкладке;
  M2 — опция target=_blank).
- При ошибке → toast.
- Если `existing=true` — kn toast «Открываю существующий разбор».

i18n-ключи: `guess.final.openInAnalysis`, `guess.final.opening`,
`guess.final.analysisError`.

## 8. Что НЕ делаем

- НЕ создаём analysis автоматически при finish — только по клику
  пользователя (не плодим лишние записи).
- НЕ дублируем NAG на основной линии за противоположную сторону —
  мы оценивали только выбранную сторону, аннотации соперника были
  бы лживы.
- НЕ копируем `lichessGameId` / `archiveGameId` в новый анализ —
  guess-PGN с NAG = отдельная запись (см. §6.1).
- НЕ строим analysis в режиме `category='game_review'` — это
  отдельный category-флоу (review-pipeline). Наш `category='analysis'`
  с pre-PGN-ом, чтобы он попал в обычные «мои анализы».
- НЕ публикуем `isPublic=true` — приватный по умолчанию (как все
  новые анализы).
- НЕ удаляем guess-сессию после создания анализа — нужна для
  истории + возможности перегенерировать.

## 9. Реализация — follow-up задачи

Зависимости: S1 → B0 → B1 → B2 → F1 → (F2 опц.). L1 не нужен
(используем существующие стили финал-экрана).

### KS (S1) — shared типы для endpoint'а

**Assignee:** backend (shared). **Labels:** `puzzle`, `analysis`.
- `GuessToAnalysisResponse = { analysisId: string; url: string;
  existing: boolean }`.
- `NAG_MAP_GUESS` (опц. shared-константа для синхронизации
  бэкенд/тестов; не критично, может быть только в backend).
- Acceptance: TS-сборка чистая.

### KS (B0) — миграция `Analysis.guessSessionId`

**Assignee:** backend (prisma). **Labels:** `analysis`, `puzzle`,
`prisma`.
- Поле `guessSessionId String? @db.Uuid @map("guess_session_id")`
  в `Analysis` + индекс `[userId, guessSessionId]`. Опц. FK на
  `GuessSession.id` (или без FK — soft-link).
- Acceptance: `prisma:migrate` чистый.

### KS (B1) — PGN-builder с NAG

**Assignee:** backend. **Labels:** `analysis`, `puzzle`.
- Чистая функция `buildAnnotatedPgn(sessionPgn, side, moves):
  string` в `apps/api/src/guess/pgn-builder.ts` (или shared).
- Парсит исходный PGN через chess.js (loadPgn), итерирует
  history(), для каждого хода выбранной стороны достаёт
  соответствующий `GuessMove`, формирует SAN, добавляет NAG
  основной линии (§4.1), и при `userUci !== playedUci` —
  вариант `(userSan {комментарий} $NAG)` (§4.2 + §5).
- Сериализует обратно (headers + movetext с вариантами).
- Acceptance: фикстуры — 5 сценариев (только strongest; смесь
  verdict'ов с blunder игрока; promotion; короткая партия; длинная
  партия с десятком guess-ходов). Готовый PGN парсится обратно
  `chess.js#loadPgn` без ошибки. Варианты содержат правильные SAN
  и NAG. Комментарии локализованы.

### KS (B2) — endpoint `POST /guess/sessions/:id/to-analysis`

**Assignee:** backend. **Labels:** `analysis`, `puzzle`.
**Зависит:** B0, B1.
- В `GuessService` метод `toAnalysis(userId, sessionId)`:
  - Owner-check; статус 'finished'; дедуп по `guessSessionId`.
  - PGN-builder → `AnalysisService.create({ pgn, title:
    'Разбор guess ' + дата, category: 'analysis' })` (без
    lichessGameId/archiveGameId — отдельная запись).
  - UPDATE `Analysis SET guessSessionId = sessionId`.
- Controller: `@Post('sessions/:id/to-analysis')`.
- Acceptance: создаёт analysis; повторный вызов отдаёт existing;
  чужая сессия — 404; не-finished — 409; в PGN есть NAG и
  варианты согласно фикстурам.

### KS (F1) — кнопка «Разобрать в анализе» на GuessFinalScreen

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B2.
- В `GuessFinalScreen` рядом с существующими CTA — кнопка
  `[Разобрать в анализе →]`. Только при `outcome` finished
  (есть finalResult) — на in-progress сессии не показываем.
- onClick → POST → navigate `/analysis/:id` (или toast при
  ошибке). Loading-spinner на кнопке.
- Existing → toast «Открываю существующий разбор», navigate в тот
  же.
- Acceptance: кнопка появляется на финале; happy-path открывает
  /analysis; error-toast.

### KS (F2, опц.) — обратная ссылка на странице analysis

**Assignee:** frontend. **Labels:** `analysis`.
**Зависит:** B0, B2.
- На странице `/analysis/:id`, если `analysis.guessSessionId !== null`,
  показать badge/кнопку «Создан из guess-сессии → [Вернуться в
  guess]» (ссылка на review guess-сессии).
- Acceptance: badge виден; ссылка ведёт на guess-review (если есть)
  или скрывается, если guess-review-страницы ещё нет.

Backend нагрузка минимальная (PGN-builder чистая комбинаторика,
без движка). Frontend — одна кнопка + опц. badge.

## 10. Риски

1. **PGN-builder с вариантами — нестандартная задача.** Чистая
   функция, юнит-тесты обязательны. При сложных partials
   (длинные партии с promotion + en passant + castling) — SAN
   через chess.js даёт стандарт, баги в строковой сериализации
   будут найдены фикстурами.
2. **chess.js#pgn() не выводит варианты — НЕ используем для
   builder'а.** Свой builder.
3. **chess.js#loadPgn на нашем выходе** должен принять (для
   валидации/отображения). Тест-обратимости: build → loadPgn → нет
   ошибки.
4. **Дедуп.** Повторный клик не плодит. Поле
   `Analysis.guessSessionId` + индекс — лёгкая миграция.
5. **Локализация комментариев.** Жёстко на языке пользователя в
   момент создания (через i18next на бэке либо принимаем locale в
   body). M1 — серверный i18n или передача locale из клиента.
   Если бэк i18n не поднят — лоадим из локали JWT user'а; либо
   просто передаём в DTO `lang?: 'ru'|'en'`.
6. **categy='analysis' vs 'game_review'.** Используем 'analysis'
   (как обычный пользовательский разбор) — не блокирует
   существующий review-pipeline.
7. **Старые сессии без `guessSessionId` поля** (legacy): после
   миграции значение NULL; повторный клик после миграции создаст
   новую запись (дедуп не сработает на legacy). Приемлемо —
   старые сессии не имели этой фичи.

## 11. Откат

- Endpoint additive — удаление не влияет на остальное.
- Поле `Analysis.guessSessionId` — additive, NULL по умолчанию.
- Frontend кнопка за feature-flag `guessToAnalysisEnabled` — при
  выключении скрыта.
- Существующие анализы, созданные через этот flow, остаются
  обычными analyses (с PGN и NAG); пользователь продолжает с
  ними работать как с любым другим разбором.
