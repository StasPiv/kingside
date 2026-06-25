/**
 * KS-4639 / ADR-143. Shared-контракт индекса упоминаний хода в записи
 * лекции (`docs/adr/143-lecture-replay-move-audio-seek.md`).
 *
 * Идея: `LectureRecording.events` — источник истины. Клиент один раз
 * пробегает `events[]` через `buildMoveTimestampIndex` (см.
 * `../utils/lecture-replay/buildMoveTimestampIndex.ts`) и получает
 * детерминированный `MoveTimestampIndex` — карту `MoveKey → MoveVisit[]`.
 * Backend об индексе ничего не знает; ни нового REST, ни WS, ни
 * миграций.
 *
 * Каждый тип задокументирован отдельно с привязкой к разделу ADR-143.
 * Любой другой клиент, импортирующий эти типы (Moves panel, popover),
 * обязан использовать `serializeMoveKey` для построения ключа в Map.
 * Запрещено собирать строку `"<segment>:<globalIndex>"` вручную — это
 * единственный канонический формат и единственный helper.
 */

/**
 * KS-4639 / ADR-143 §3. Канонический идентификатор хода в записи
 * лекции. Уникален в пределах одного `LectureRecording`. Backend этот
 * тип не использует — он живёт только на клиенте и в shared-типах,
 * как контракт между builder'ом индекса и потребителями (`MovesPanel`
 * в `LectureReplayPage`).
 *
 * `segment` — порядковый номер сегмента записи. Сегмент 0 начинается
 * с `t=0`. Инкрементируется на каждом `reset` или `analysis-switch`
 * событии (см. ADR-143 §3.3, §5.2). Подробнее — комментарий к
 * `SegmentBoundary`.
 *
 * `globalIndex` — стандартный сквозной индекс узла дерева в пределах
 * сегмента. Источник — `ChessMove.globalIndex` (KS-3780, дерево автора
 * с проставленными индексами).
 *
 * Сериализуется в Map-ключ как строка `"<segment>:<globalIndex>"`
 * через `serializeMoveKey`. Других форматов сериализации нет.
 */
export type MoveKey = {
  /** Порядковый номер сегмента записи. Целое, ≥ 0. */
  segment: number;
  /** Сквозной индекс узла дерева (KS-3780) внутри сегмента. Целое, ≥ 0. */
  globalIndex: number;
};

/**
 * KS-4639 / ADR-143 §4.1. Одно «посещение» узла тренером — отрезок
 * времени, в течение которого `currentGlobalIndex` указывал на этот
 * узел.
 *
 * - `enteredAtMs` — момент входа на узел (мс от `Lecture.startedAt`).
 *   Используется для seek'а аудио:
 *   `audio.currentTime = (enteredAtMs − audio.offsetMs) / 1000`
 *   (формула из ADR-115 §2.4 / ADR-116 §2.4).
 * - `endedAtMs` — момент ухода с узла (мс от `Lecture.startedAt`).
 *   Равен `t` следующего события, изменившего `currentGlobalIndex`,
 *   либо `t` события `reset/analysis-switch/closed` (закрытие сегмента),
 *   либо `totalDurationMs` если тренер «застрял» до конца.
 * - `durationMs` — `endedAtMs − enteredAtMs`. Дублирующее поле,
 *   builder обязан проставлять оба и гарантировать равенство (инвариант
 *   ADR-143 §5.5). Вынесено отдельно, чтобы потребители (popover,
 *   аналитика) не считали по-разному.
 *
 * Допустимое значение `durationMs = 0` — два state-patch'а пришли в
 * одну мс (theoretical edge, см. ADR-143 §8.6).
 */
export type MoveVisit = {
  /** Целое, ≥ 0. Мс от `Lecture.startedAt`. */
  enteredAtMs: number;
  /** Целое, ≥ `enteredAtMs`. Мс от `Lecture.startedAt`. */
  endedAtMs: number;
  /** Целое, = `endedAtMs − enteredAtMs`. ≥ 0. */
  durationMs: number;
};

/**
 * KS-4639 / ADR-143 §4.2. Описание одного сегмента записи. Сегмент —
 * отрезок между двумя «жирными» событиями (`reset` / `analysis-switch`).
 *
 * Используется UI чтобы:
 *   1. Назвать сегмент в popover'е/таймлайне (см. `title`).
 *   2. Найти активный сегмент в момент времени `t` — бинарным поиском
 *      по массиву `segmentBoundaries` (отсортирован по `startedAtMs`).
 *
 * `endedAtMs === null` — единственный кейс «сегмент длится до конца
 * записи». Допустим только для последнего элемента массива (инвариант
 * `MoveTimestampIndex.segmentBoundaries`).
 *
 * `title`:
 *   - Сегмент, начатый `analysis-switch`, — `payload.title`.
 *   - Сегмент, начатый `reset`, — `null` (нет явного заголовка).
 *   - Нулевой сегмент (с `t=0`):
 *       - если первым событием был синтетический `analysis-switch` на
 *         `t=0`, `title` берётся из его `payload.title` (см. §5.4);
 *       - иначе `null`.
 */
export type SegmentBoundary = {
  /** Совпадает с индексом этого объекта в массиве `segmentBoundaries`. */
  segment: number;
  /** Включительно, мс от `Lecture.startedAt`. Для сегмента 0 — 0. */
  startedAtMs: number;
  /** Exclusive. `null` — только для последнего сегмента «до конца записи». */
  endedAtMs: number | null;
  /** UI-метка. См. контракт в комментарии к типу. */
  title: string | null;
};

/**
 * KS-4639 / ADR-143 §4.2. Полный индекс упоминаний всех узлов записи —
 * результат единственного вызова `buildMoveTimestampIndex(events, totalDurationMs)`.
 *
 * Инварианты (гарантирует builder, проверяется тестами в
 * `buildMoveTimestampIndex.test.ts` — фикстуры F1-F8 из ADR-143 §10):
 *
 *   1. Ключи `visits` — строго в формате `serializeMoveKey(MoveKey)`,
 *      т.е. `"<segment>:<globalIndex>"` (см. контракт в комментарии к
 *      `MoveKey`). Других форматов нет.
 *   2. Значение `visits.get(key)` — непустой массив, отсортированный
 *      по `enteredAtMs` возрастанию. Если у узла ноль посещений —
 *      ключа в `visits` НЕТ. Потребители используют
 *      `index.visits.get(key) ?? []` для безопасного fallback'а.
 *   3. `segmentBoundaries` — массив непустой; индекс элемента ===
 *      `element.segment`. Все `endedAtMs` заполнены, кроме, возможно,
 *      последнего элемента (а у него — закрыт через `totalDurationMs`
 *      финализатором builder'а).
 *   4. У каждого `MoveVisit`: `endedAtMs === enteredAtMs + durationMs`
 *      и `durationMs ≥ 0` (см. ADR-143 §5.5).
 *
 * `totalDurationMs` — берётся из `LectureRecording.durationMs`. Нужно
 * для финализации (последнее посещение, последний сегмент).
 */
export type MoveTimestampIndex = {
  /** Канонический формат ключа — `serializeMoveKey(MoveKey)`. Иммутабельный. */
  visits: ReadonlyMap<string, ReadonlyArray<MoveVisit>>;
  /** Хронологический список сегментов. Индекс === `element.segment`. Иммутабельный. */
  segmentBoundaries: ReadonlyArray<SegmentBoundary>;
  /** Полная длительность записи, мс. См. инварианты. */
  totalDurationMs: number;
};

/**
 * KS-4639 / ADR-143 §5.7. Сериализация `MoveKey` в строку для
 * использования как Map-ключ. Десятичные числа, без ведущих нулей,
 * единственный разделитель `:`. Никаких padding/hex/иных форматов.
 *
 * Единственный канонический путь — клиенты обязаны импортировать
 * эту функцию из shared, не собирать строку вручную. ESLint-правило
 * на инлайн-литералы `\d+:\d+` (опционально, §12.3) — у потребителей.
 */
export function serializeMoveKey(k: MoveKey): string {
  return `${k.segment}:${k.globalIndex}`;
}

/**
 * KS-4639 / ADR-143 §5.7. Парс строки обратно в `MoveKey`. Симметричен
 * `serializeMoveKey`. На некорректном входе НЕ кидает исключение, но
 * возвращает `NaN` в соответствующих полях — потребитель сам решает,
 * что с этим делать (как правило, такой ключ просто не найдётся в
 * `visits` и обработается как «нет упоминаний»).
 */
export function parseMoveKey(s: string): MoveKey {
  const [seg, idx] = s.split(':');
  return { segment: Number(seg), globalIndex: Number(idx) };
}
