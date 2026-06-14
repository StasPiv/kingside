# ADR-108b. Стрелки и подсветка клеток от модели для «Оценка позиции от AI»

Статус: предложен (KS-3688).
Дата: 2026-06-04.
Связано:
- ADR-108 (UX-эпик кнопки «Оценка позиции от AI»).
- KS-3680 — `useAiPositionComment`, `AiPositionCommentPanel` (hook + UI).
- KS-3681 — две версии (RU/EN) короткой инструкции модели.
- KS-3686 — упоминание `sf18_eval`/`sf18_pv` в инструкции.

## 1. Контекст

Сейчас `POST /analyses/position/comment` возвращает только строку `{ comment: string }`. Пользователь хочет, чтобы модель дополнительно выделяла 1–2 ключевых фактора визуально на доске:
- какие клетки подсветить и каким цветом;
- какие стрелки нарисовать и каким цветом.

Фронт уже умеет рисовать произвольные `highlights` и `arrows` (пользовательские аннотации правой кнопкой, ADR-038). Палитра ровно 4 цвета (lichess): `red | green | blue | yellow` (`AnnotationColor` в `apps/web/src/review/types.ts:5`), CSS-значения — в `HIGHLIGHT_COLORS` (`apps/web/src/hooks/useSquareHighlights.ts:7`). Те же типы используют `SquareHighlight { square, color }` и `ArrowAnnotation { from, to, color }`.

На доске в `AnalysisPage.tsx` уже есть слойная сборка визуальных слоёв (строки 1701–1884): `useBoardHighlights` (last-move / selected / legal moves) + `currentAnnotations` (пользовательские highlights/arrows) → `mergedSquareStyles` + `mergedArrows` → `boardOptions` → `MemoChessboard`. Engine `bestArrow` сейчас НЕ рисуется; единственная engine-стрелка — `suggestedArrow` для hover над архивным деревом (полупрозрачная голубая).

`PositionCommentService.comment()` принимает строку от webhook и `.trim()`-ит её. Если расширим формат ответа модели на JSON — нужно валидировать на стороне бэка.

## 2. Граница задачи

### Входит

1. Формат ответа модели и контракт `POST /analyses/position/comment` (расширение, обратная совместимость).
2. Правка `buildSystemPrompt` (RU + EN): инструкция выдавать JSON, цветовая конвенция, лимиты.
3. Валидация и фолбэк на бэке.
4. Точка приёма в `useAiPositionComment` + проброс overlay в `AnalysisPage` для рисования.
5. Сброс подсветки при смене FEN/перегенерации/«full-review».
6. UX: toggle «скрыть подсветку», конфликт с `suggestedArrow`.

### НЕ входит

- Запись AI-overlay в PGN/дубль. Только in-memory кэш (как и текст комментария, ADR-108 §5).
- Перевод существующих PGN-комментариев из полного разбора в overlay — там нет структурированных данных, оставляем пустой overlay для `source='full-review'`.
- Stream/partial-overlay. Модель возвращает один JSON целиком за один запрос.
- Расширение палитры. Используем существующие 4 цвета фронта, без новых CSS-токенов.

## 3. Контракт

### 3.1. Ответ endpoint'а

`POST /analyses/position/comment` отвечает:

```ts
type PositionCommentResponse = {
  comment: string;
  highlights?: Array<{ square: string; color: AiOverlayColor }>;
  arrows?: Array<{ from: string; to: string; color: AiOverlayColor }>;
};

type AiOverlayColor = 'red' | 'green' | 'yellow' | 'blue';
```

Поля `highlights`/`arrows` — опциональные. Старый фронт без обработки полей продолжает читать только `comment` (обратная совместимость).

`square`/`from`/`to` — координаты в формате `a1`..`h8` (нижний регистр, `[a-h][1-8]`).

Новый endpoint не вводим — расширяем существующий. Аргументы:
- Один запрос, один ответ — нет необходимости в отдельной обвязке (auth/rate-limit/webhook-flow).
- Backward-compat за счёт необязательности полей.
- Нет смысла плодить дублирующий URL ради двух массивов.

### 3.2. Shared-типы

Тип `PositionCommentResponse` живёт в `packages/shared/src/types/api-contracts.ts`. Фронт импортирует его из `@kingside/shared`, чтобы не дублировать. `AiOverlayColor` — алиас, синонимичный `AnnotationColor` (`apps/web/src/review/types.ts:5`); фронт-side утилита `toAnnotationColor(value): AnnotationColor | null` нормализует и отбрасывает «not in union».

### 3.3. Лимиты

- `highlights` — до 4 клеток.
- `arrows` — до 2 стрелок.
- Запрос модели: «выдели 1–2 ключевых фактора», по 1–2 элемента на тип. Бэк дополнительно обрезает излишек (срез до 4 / 2).

Аргумент за лимиты: доска 8×8, больше 4 квадратов / 2 стрелок превращают визуал в хаос; в задаче явно сказано «1–2 ключевых фактора».

## 4. Цветовая конвенция

Используем 3 из 4 существующих цветов фронта; синий резервируем за уже сложившейся пользовательской семантикой (Alt-drag), модель его не производит:

| Цвет | Семантика | Когда применять |
|---|---|---|
| `red` | слабость, угроза, опасная фигура/клетка | висящая фигура; квадрат под ударом; ход соперника, который ведёт к материальной потере; стрелка от атакующей фигуры на её цель |
| `green` | рекомендуемый план / лучший ход / опорное продолжение | стрелка `from → to` для лучшего хода стороны, чей ход; квадрат форпоста для рекомендуемого манёвра |
| `yellow` | ключевая идея / точка внимания, не угроза и не план | важная клетка структуры (форпост, слабый комплекс); стрелка-намёк на тактическую идею |
| `blue` | НЕ ИСПОЛЬЗУЕТСЯ моделью; зарезервирован за пользователем (Alt-drag) | фронт принимает blue от модели для forward-compat, но в инструкции явно не упоминается |

Маппинг повторяет существующую интуицию `useSquareHighlights.ts:23` (модификаторы → цвет) и lichess-конвенцию `[%csl/%cal]` — пользователь, знакомый со стандартом, не будет переучиваться.

## 5. Формат вывода модели

Модель возвращает **один JSON-объект** в теле ответа webhook:

```json
{
  "comment": "Белые имеют решающий материальный перевес…",
  "highlights": [
    {"square": "f8", "color": "red"},
    {"square": "d5", "color": "yellow"}
  ],
  "arrows": [
    {"from": "e1", "to": "e8", "color": "green"}
  ]
}
```

### 5.1. Правки `buildSystemPrompt` (RU + EN)

К текущему prompt'у (KS-3686) добавляем хвост (одна и та же структура в обеих локалях):

```
Формат ответа — ОДИН JSON-объект:
{ "comment": "<текст>", "highlights": [...], "arrows": [...] }

- comment — комментарий человеческими словами (как сейчас).
- highlights — 0–4 элемента вида { "square": "e4", "color": "red" }.
- arrows — 0–2 элемента вида { "from": "e2", "to": "e4", "color": "green" }.

Цветовая конвенция:
- red — слабость/угроза/опасная фигура;
- green — рекомендуемый план или лучший ход;
- yellow — ключевая идея / внимание.

Выдели не больше 1–2 факторов суммарно. Если факторов нет — верни пустые массивы.
Не оборачивай JSON в код-fences. Не добавляй комментарии вне JSON.
```

EN-версия — симметричный перевод. Сохраняем правило из KS-3686 «не озвучивай численную оценку».

### 5.2. Почему JSON-объект, а не markdown-fenced

Простой single-shot JSON парсится одним `JSON.parse`. Markdown-fenced (```json ... ```) добавляет лишний шаг (snip fence) и шум в ответ. Защитой от случайного fence-обрамления служит strip на стороне бэка (§6.2).

## 6. Бэкенд: парсинг и валидация

### 6.1. Изменения в `PositionCommentService`

- `buildSystemPrompt(language)` — добавить хвост из §5.1 в обе версии (RU/EN).
- `comment(userId, dto)` — возвращает `Promise<PositionCommentResponse>` вместо `Promise<string>`. Внутри:
  1. Получает строку `raw` от webhook (как сейчас).
  2. `parseModelOutput(raw)` — pure-функция (новая, в том же модуле или `lib/parseModelOutput.ts`).
  3. Возвращает результат.
- Контроллер `PositionCommentController.comment()` — отдаёт тот же объект.

### 6.2. `parseModelOutput`

Алгоритм:

1. **Strip fences.** Если `raw.trim()` начинается с ``` ```` или ``` ```json ``` — снять обрамляющий блок. Регулярно: `/^```(?:json)?\s*([\s\S]*?)\s*```$/`. Иначе работаем как есть.
2. **JSON.parse.** Если бросает — фолбэк: `{ comment: raw.trim(), highlights: [], arrows: [] }`.
3. **Тип-гард результата:**
   - Если результат не объект или `comment` не строка — фолбэк (как в шаге 2).
   - Иначе: `comment = String(parsed.comment).trim()`.
4. **Валидация highlights:**
   - Если `parsed.highlights` не массив — `highlights = []`.
   - Иначе: для каждого элемента проверить `square` (regex `/^[a-h][1-8]$/`) и `color` ∈ {`red`,`green`,`yellow`,`blue`}. Невалидные — отбросить.
   - Дедупликация по `square` (последний выигрывает).
   - Срез до 4 элементов.
5. **Валидация arrows:**
   - Если не массив — `arrows = []`.
   - Каждый элемент: `from`, `to` через ту же regex; `from !== to`; `color` валидный.
   - Дедупликация по `(from, to)` (последний выигрывает).
   - Срез до 2 элементов.
6. Возврат `{ comment, highlights, arrows }`. Если в массиве не осталось элементов — пустой массив (не `undefined`); сериализация всё равно сжимает.

### 6.3. Фолбэк-семантика

- Модель вернула чистый текст (без JSON) → `comment = raw.trim()`, массивы пустые. Старое поведение сохраняется.
- Модель вернула JSON, но `comment` отсутствует → фолбэк (`comment = raw.trim()`), массивы пустые. Не пишем `comment = ''`, иначе пользователь увидит ничего вместо потенциально читаемого текста.
- Модель вернула JSON с `comment` и невалидным `highlights` (например, `'z9'`) → массивы фильтруются, остаются пустыми; comment проходит.
- `comment` есть, остальные поля валидные → возвращаем как есть с лимитами/дедупом.

### 6.4. Тесты

Юнит-тесты `parseModelOutput.spec.ts`:
- Чистый JSON.
- JSON в fences ```` ```json ```` / ``` ``` ``` ```.
- Чистый текст без JSON → фолбэк.
- JSON без `comment` → фолбэк на raw.
- Невалидные клетки (`z9`, `g0`, `aa1`) отбрасываются.
- Невалидный цвет (`magenta`) отбрасывается.
- Стрелка `from===to` отбрасывается.
- 5 highlights → срезается до 4.
- 3 arrows → срезается до 2.
- Дубликаты по `square`/`(from,to)` дедуплицируются (поздний выигрывает).
- `comment` с ведущими/завершающими пробелами тримится.

### 6.5. Лог

При `parseModelOutput` отбрасывает элементы — `logger.debug` с количеством отброшенного. На критические сбои (`JSON.parse` бросил) — `logger.warn` с первыми 200 символами `raw`.

## 7. Фронт: приём и рисование

### 7.1. Хук `useAiPositionComment`

Расширения:

- `AiCommentState`:
  - `success` теперь несёт `comment`, `source`, `highlights: SquareHighlight[]`, `arrows: ArrowAnnotation[]`.
  - Остальные состояния без изменений (overlay не имеет смысла без success).
- In-memory кэш: ключ — нормализованный FEN, значение — `{ comment, highlights, arrows }`. Сейчас хранится `string` — расширяем до объекта. Размер 50 записей сохраняем.
- Сетевой клиент — читает новый шейп ответа. `highlights`/`arrows` опциональны; если их нет — пустые массивы.
- `source='full-review'`: всегда пустые `highlights`/`arrows` (PGN-комментарий не несёт структуры). Кнопка «Перегенерировать» при срабатывании может вернуть свежую запись с overlay.
- Возврат хука: добавить `overlay: { highlights, arrows }` (или `null`, если состояние не success / overlay скрыт). Также `overlayHidden: boolean`, `toggleOverlay(): void` — локальный флаг, сбрасывается при смене FEN и при свежем success.

### 7.2. `AiPositionCommentPanel`

- При state=success и (highlights.length + arrows.length > 0) — мелкая кнопка-тогл «скрыть подсветку / показать подсветку» рядом с success-комментарием. Использует `overlayHidden`/`toggleOverlay`.
- Кнопка появляется только когда есть что скрывать — без overlay скрытие бессмысленно.
- i18n-ключи: `analysis.aiComment.hideOverlay`, `analysis.aiComment.showOverlay`.

### 7.3. `AnalysisPage` — рисование

Хук уже поднят на уровень `AnalysisPage.tsx:1022`. Добавить:

- `aiOverlay = aiPositionComment.overlay` (от F1).
- Подмешать в существующий мердж:

```ts
// Между squareStyles (system) и highlightStyles (user):
const aiSquareStyles = useMemo(() => {
  if (!aiOverlay) return {};
  const styles: Record<string, React.CSSProperties> = {};
  for (const h of aiOverlay.highlights) {
    styles[h.square] = { backgroundColor: HIGHLIGHT_COLORS[h.color] };
  }
  return styles;
}, [aiOverlay]);

const mergedSquareStyles = useMemo(() => {
  const merged: Record<string, React.CSSProperties> = { ...squareStyles };
  for (const [sq, style] of Object.entries(aiSquareStyles)) {
    merged[sq] = { ...merged[sq], ...style };
  }
  for (const [sq, style] of Object.entries(highlightStyles)) {
    merged[sq] = { ...merged[sq], ...style };  // user annotations поверх AI
  }
  return merged;
}, [squareStyles, aiSquareStyles, highlightStyles]);

const aiArrows = useMemo(() => {
  if (!aiOverlay) return [];
  return aiOverlay.arrows.map((a) => ({
    startSquare: a.from,
    endSquare: a.to,
    color: HIGHLIGHT_COLORS[a.color],
  }));
}, [aiOverlay]);

const mergedArrows = useMemo(
  () => [...arrows, ...aiArrows, ...annotationArrows],
  [arrows, aiArrows, annotationArrows],
);
```

Порядок слоёв на доске (нижний → верхний):
1. last-move / selected / legal-moves (system).
2. **AI overlay** (новое).
3. User annotations (правый клик).

Для стрелок порядок в массиве почти не критичен (доска рендерит все); user-стрелки добавляем последними, чтобы при идентичных `from→to` user-цвет имел визуальный приоритет (library рисует по порядку).

### 7.4. Ключ ремоунта Chessboard

Сейчас `annotationsKey = '${currentGlobalIndex}|${currentFen}|${JSON.stringify(currentAnnotations?.arrows ?? null)}'` (`AnalysisPage.tsx:1898`). Добавить AI-стрелки в JSON-часть ключа — иначе react-chessboard может закэшировать свои internal-arrows и не перерисовать overlay:

```ts
() => `${currentGlobalIndex}|${currentFen}|${JSON.stringify({user: currentAnnotations?.arrows ?? null, ai: aiOverlay?.arrows ?? null})}`
```

### 7.5. Сброс overlay

| Триггер | Поведение |
|---|---|
| Смена FEN | хук перерисовывается через `useEffect` (KS-3680), state идёт из cache-look-up по новому нормализованному FEN. Если по новому FEN кэш-хит → overlay из кэша. Если miss → overlay пустой (idle). |
| Перегенерация (`regenerate()`) | `state=loading`, overlay прячется. После ответа — overlay из свежего success. |
| `source='full-review'` | overlay пустой (`highlights:[]`, `arrows:[]`). |
| `toggleOverlay()` | overlay перестаёт пробрасываться, доска перерисовывается без AI-слоя. Кнопка переключается в «показать подсветку». При смене FEN/новом success — состояние сброса исчезает (по умолчанию «показать»). |

### 7.6. Конфликт с `suggestedArrow`

`suggestedArrow` (hover на архивном дереве) полупрозрачный голубой (`rgba(56,189,248,0.55)`), `AnalysisPage.tsx` источник — отдельный (`useBoardHighlights`). Семантика и цвет различны, одновременное появление возможно, но визуально не путается (разная толщина, разная intensity). Подавление не нужно.

Если в будущем добавим engine `bestArrow` от Stockfish — AI overlay и engine-arrow в одном поле зрения; нужно будет вернуться к приоритезации. Пока не возникает.

## 8. UX-нюансы

- При state=success, но `overlay` пустой (модель вернула `[]`/`[]`) — toggle-кнопка не появляется (нечего скрывать).
- При state=loading кнопка-тогл скрыта; текущий overlay уже не рендерится (хук возвращает `null` overlay в этом состоянии).
- При state=error/empty/rate-limited/unsupported/unauthenticated — overlay не рендерится.
- На полупрозрачные ai-highlight'ы возможна семантическая коллизия с last-move (тоже жёлтый). На практике last-move рисуется ниже, ai-highlight перекрывает — пользователь видит ai-yellow. Это терпимо: ai-highlight живёт только во время чтения комментария; last-move постоянный фон.

## 9. Декомпозиция

### B1 — backend (~0.75 дня), метки `analysis`, `chat`, `i18n`

- `packages/shared/src/types/api-contracts.ts` — типы `AiOverlayColor`, `AiPositionHighlight`, `AiPositionArrow`, `PositionCommentResponse`. Экспорт через `@kingside/shared`.
- `apps/api/src/position-comment/position-comment.service.ts`:
  - Хвост `buildSystemPrompt` (RU + EN) по §5.1.
  - `parseModelOutput(raw: string): PositionCommentResponse` — pure-функция (§6.2).
  - `comment(userId, dto)` — `Promise<PositionCommentResponse>` вместо строки.
- `position-comment.controller.ts` — возврат `Promise<PositionCommentResponse>`.
- Тесты `parseModelOutput.spec.ts` по §6.4.
- Обновить `review-comment` и прочие callsite'ы, если они дёргают строку — поиск `position-comment.service` / `comment(` показывает только controller (см. `apps/api/src/position-comment/position-comment.controller.ts:20`); правка точечная.

### F1 — frontend, hook + overlay merge (~1 день), метки `analysis`, `chat`, `stockfish`

- `apps/web/src/hooks/useAiPositionComment.ts`:
  - Расширить кэш до `{ comment, highlights, arrows }`. `normalizeFen` без изменений.
  - Расширить `AiCommentState.success` полями `highlights`/`arrows`.
  - Сетевой клиент читает новые поля ответа.
  - В результат добавить `overlay: { highlights: SquareHighlight[]; arrows: ArrowAnnotation[] } | null`, `overlayHidden`, `toggleOverlay`.
  - `source='full-review'` всегда даёт `overlay: { highlights: [], arrows: [] }` (или `null`).
  - При смене FEN `overlayHidden = false` (сброс).
- `apps/web/src/pages/AnalysisPage.tsx`:
  - Получить `overlay` из контроллера, добавить `aiSquareStyles` и `aiArrows`, подмешать в `mergedSquareStyles`/`mergedArrows` (см. §7.3).
  - Расширить `annotationsKey` (см. §7.4).
- `apps/web/src/components/analysis/AiPositionCommentPanel.tsx`:
  - Кнопка-тогл «скрыть/показать подсветку» в success-блоке когда `overlay.highlights.length + overlay.arrows.length > 0`.
  - i18n.
- Тесты:
  - `useAiPositionComment.spec.ts` — расширение: success с overlay, кэш сохраняет overlay, full-review даёт пустой overlay, toggleOverlay меняет флаг, смена FEN сбрасывает флаг.
  - `AiPositionCommentPanel.spec.tsx` — кнопка-тогл появляется/исчезает, переключается.
  - `AnalysisPage.aiOverlay.test.tsx` (новый) — мердж стилей и стрелок при наличии overlay; `annotationsKey` меняется при смене overlay.

### F2 — frontend, i18n + минимальные стили (~0.25 дня), метки `analysis`, `i18n`

- Ключи `analysis.aiComment.hideOverlay`, `analysis.aiComment.showOverlay` в `apps/web/src/i18n/locales/{ru,en}.json`.
- Без новых CSS-токенов: используем `HIGHLIGHT_COLORS` напрямую.

### Q1 — QA (~0.5 дня), метки `analysis`, `tests`

- Корректная отрисовка highlights/arrows из живого ответа (один прогон с реальным webhook).
- **Q1.2.** Случай «модель вернула не-JSON ответ» (искусственно через mock webhook, HTTP 200) — бэк после фикса KS-3690 возвращает пустой шейп `{comment:'', highlights:[], arrows:[]}`. Фронт корректно обрабатывает оба возможных состояния: `state.kind='empty'` («По этой позиции добавить нечего» — основной путь, kind='empty' изначально под «модели нечего сказать») либо `state.kind='error'`. Инвариант сценария: **никакая подсветка/стрелки от модели на доске не появляются**, рендера невалидного содержимого нет. Отдельно: при HTTP 5xx от api или таймауте webhook'а → остаётся `state.kind='error'` (инвариант overlay тот же).
- Случай «модель вернула невалидные клетки» (`z9`/`g0`) — отброшены, остальные нарисовались.
- Сброс overlay при смене FEN: переход по дереву партии очищает доску, новый FEN — idle.
- Toggle «скрыть подсветку» убирает AI overlay, оставляя пользовательские аннотации; при новом success — overlay снова виден.
- `full-review`: лейбл «Из полного разбора», overlay пуст, кнопка-тогл отсутствует.
- Сосуществование с `suggestedArrow` (hover на архивном дереве) — оба арт-объекта видны без перекрытия по цвету.
- Кэш-хит при возврате на ту же позицию — overlay восстановлен.

### Зависимости

```
B1 ──> F1 ──> F2
            └──> Q1
```

F1 после B1 (нужен новый шейп ответа и shared-типы). F2 — мелочи поверх F1. Q1 в конце. Срок до прода — ~2 рабочих дня.

## 10. Открытые вопросы

1. **Стиль AI-highlight'ов vs user-highlight'ов** — сейчас используем тот же `HIGHLIGHT_COLORS` (одинаковый альфа-канал). Если по фидбэку выяснится, что AI overlay путают с собственной разметкой — введём отдельные CSS-токены (`HIGHLIGHT_COLORS_AI`) с другой прозрачностью / штриховкой / тонким контуром. Не блокер MVP.
2. **Качество выдачи модели** — может оказаться, что модель часто промахивается мимо JSON-формата или мажет цветами без логики. После B1+F1 прогнать на 5–10 живых позициях; если плохо — итерация prompt-у в §5.1 (примеров не добавляем заранее, чтобы не зашумлять текущую короткую инструкцию KS-3686).

Остальные развилки закрыты в §3–§8.

## 11. Резюме

**Контракт** — расширяем `POST /analyses/position/comment` опциональными полями `highlights` и `arrows` в ответе. Backward-compat за счёт необязательности.

**Цвета** — повторяем существующую палитру фронта (red/green/yellow/blue), модель использует первые три по семантике red=угроза, green=план, yellow=идея. Blue резервирован за пользователем.

**Формат вывода модели** — один JSON-объект `{comment, highlights, arrows}` в теле ответа webhook'а. Бэк делает strip-fences → `JSON.parse` → валидация (regex клеток, union цветов, дедуп, срез до 4/2) → фолбэк на сырой текст в `comment` при сбое разбора.

**Фронт** — `useAiPositionComment` отдаёт overlay (`{highlights,arrows}` или `null`), `AnalysisPage` подмешивает его между system-слоем и user-аннотациями. `AiPositionCommentPanel` показывает кнопку-тогл «скрыть/показать подсветку», когда overlay есть. Смена FEN сбрасывает скрытие; `full-review` всегда даёт пустой overlay.

**Лимиты** — 4 клетки и 2 стрелки максимум.

**Декомпозиция** — B1 (~0.75 дня) → F1 (~1 день) → F2 (~0.25 дня), Q1 (~0.5 дня) в конце. Срок до прода ~2 рабочих дня.
