/**
 * KS-4639 / ADR-143 §5. Чистая функция-builder индекса упоминаний
 * хода в записи лекции. Без зависимостей от React/DOM/fetch.
 *
 * Контракт результата зафиксирован в `MoveTimestampIndex` (см.
 * `../../types/lecture-replay.ts`). Поведение покрыто фикстурами
 * F1-F8 в `buildMoveTimestampIndex.test.ts` — это формальная
 * спецификация: любое расхождение builder ↔ тесты — критическая
 * регрессия (CI блокирует merge, §12.1).
 *
 * Используется `LectureReplayPage` один раз при загрузке записи
 * в `useMemo([events, durationMs])` — десятки мс на типичной лекции,
 * O(N) по событиям.
 */
import type { RecordedEvent } from '../../types/live-analysis.js';
import {
  type MoveKey,
  type MoveTimestampIndex,
  type MoveVisit,
  type SegmentBoundary,
  serializeMoveKey,
} from '../../types/lecture-replay.js';

/** Внутреннее изменяемое состояние builder'а — наружу не выходит. */
type BuilderState = {
  /** Текущий сегмент. Стартует с 0, инкрементируется на reset/analysis-switch. */
  segment: number;
  /** Узел, на котором «стоит» тренер. `null` — никаких state-patch'ей с
   *  cgi ещё не было / прошёл reset/switch. */
  currentGlobalIndex: number | null;
  /** Момент входа в текущий узел. `null` — currentGlobalIndex `null`. */
  visitStartedAtMs: number | null;
  /** Накопитель посещений. Mutable Map<canonicalKey, MoveVisit[]>. */
  visits: Map<string, MoveVisit[]>;
  /** Накопитель сегментов. Длина ≥ 1 всегда (стартовый сегмент 0). */
  segmentBoundaries: SegmentBoundary[];
};

/**
 * KS-4639 / ADR-143 §5.3. Закрыть текущее посещение (если оно открыто)
 * и записать его в `visits`. После — обнуляет `currentGlobalIndex` /
 * `visitStartedAtMs`. Безопасно вызывать когда посещение не открыто
 * (no-op).
 *
 * `atMs` — момент закрытия (`t` события, которое сменило указатель,
 * или `totalDurationMs` при финализации).
 */
function closeVisit(state: BuilderState, atMs: number): void {
  if (state.currentGlobalIndex === null || state.visitStartedAtMs === null) {
    state.currentGlobalIndex = null;
    state.visitStartedAtMs = null;
    return;
  }
  const key: MoveKey = {
    segment: state.segment,
    globalIndex: state.currentGlobalIndex,
  };
  const enteredAtMs = state.visitStartedAtMs;
  const endedAtMs = atMs;
  const durationMs = endedAtMs - enteredAtMs;
  // ADR-143 §5.5 инвариант: `endedAtMs === enteredAtMs + durationMs`,
  // `durationMs ≥ 0`. Negative durationMs — нарушение порядка events
  // (см. assertion в основной петле); strict comparison + throw тут
  // помог бы, но мы уже отвергли out-of-order вход. Оставим ≥ 0 как
  // допущение — тесты F1-F8 покрывают корректные случаи.
  const visit: MoveVisit = { enteredAtMs, endedAtMs, durationMs };
  const serialized = serializeMoveKey(key);
  let arr = state.visits.get(serialized);
  if (!arr) {
    arr = [];
    state.visits.set(serialized, arr);
  }
  arr.push(visit);
  state.currentGlobalIndex = null;
  state.visitStartedAtMs = null;
}

/**
 * KS-4639 / ADR-143 §5.3. Закрыть текущий сегмент (включая открытое
 * посещение) и открыть следующий с указанным title'ом.
 *
 * Используется обработчиками `reset` / `analysis-switch` / `closed`.
 * Для `closed` следующий сегмент создаётся пустым; финализация
 * (см. конец `buildMoveTimestampIndex`) удалит этот «трейлинговый»
 * boundary, если он не получит реального содержимого.
 */
function closeSegment(
  state: BuilderState,
  atMs: number,
  openNextWithTitle: string | null,
): void {
  closeVisit(state, atMs);
  state.segmentBoundaries[state.segment].endedAtMs = atMs;
  state.segment += 1;
  state.segmentBoundaries.push({
    segment: state.segment,
    startedAtMs: atMs,
    endedAtMs: null,
    title: openNextWithTitle,
  });
}

/**
 * KS-4639 / ADR-143 §5.1. Построить `MoveTimestampIndex` из
 * `LectureRecording.events` и `LectureRecording.durationMs`.
 *
 * Алгоритм детерминирован: два клиента на одних и тех же `events`
 * получат байт-в-байт идентичный результат (фикстуры F1-F8 — §10
 * ADR-143). Не зависит от системных часов, локали, окружения.
 *
 * Поведение по каждому типу события — таблица в §5.4 ADR. Здесь
 * один-в-один:
 *
 *   - `analysis-switch`:
 *       — нулевой синтетический (t=0, ничего ещё не произошло) —
 *         только проставляет `title` нулевого сегмента, не закрывает;
 *       — иначе `closeSegment(t, payload.title)`.
 *   - `reset`: `closeSegment(t, null)`.
 *   - `state-patch`:
 *       — `currentGlobalIndex === undefined` — игнор;
 *       — `currentGlobalIndex !== state.currentGlobalIndex` —
 *         `closeVisit(t)`, переключение указателя на новый узел.
 *   - `move`: игнор (см. §5.6 — `move` не несёт `currentGlobalIndex`,
 *     указатель обновится следующим `state-patch`'ем).
 *   - `closed`: `closeSegment(t, null)`; в финализации трейлинговый
 *     пустой boundary удаляется.
 *
 * После цикла:
 *   - Если есть открытое посещение — закрыть через `totalDurationMs`.
 *   - Если последний `segmentBoundaries[*].endedAtMs === null` —
 *     заменить на `totalDurationMs`.
 *   - Если последний boundary вырожденный (`startedAtMs === endedAtMs`)
 *     — удалить.
 *
 * Защита от нарушения порядка `t` в `events[]` — assertion в петле
 * (риск §12.7 ADR-143). Порядок гарантирован Redis RPUSH в финализаторе
 * `LectureRecording`, но рассинхрон будет видно сразу же.
 */
export function buildMoveTimestampIndex(
  events: ReadonlyArray<RecordedEvent>,
  totalDurationMs: number,
): MoveTimestampIndex {
  const state: BuilderState = {
    segment: 0,
    currentGlobalIndex: null,
    visitStartedAtMs: null,
    visits: new Map(),
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: null, title: null },
    ],
  };

  let prevT = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    // ADR-143 §12.7. Защита от out-of-order events. Финализатор
    // `LectureRecording` пишет в Redis через RPUSH (ADR-142 §6.10),
    // порядок гарантирован — но рассинхрон выловим сразу.
    if (typeof event.t !== 'number' || event.t < prevT) {
      throw new Error(
        `buildMoveTimestampIndex: events out of order at index ${i} (t=${event.t}, prevT=${prevT})`,
      );
    }
    prevT = event.t;

    switch (event.type) {
      case 'analysis-switch': {
        // Нулевой синтетический switch (см. ADR-142 §6.5 / KS-A05
        // финализатора, ADR-143 §3.3, §5.4). Условие — t=0, ничего
        // не успело произойти. Не закрывает сегмент, только проставляет
        // title нулевого boundary.
        const isSynthetic =
          event.t === 0 &&
          state.segment === 0 &&
          state.currentGlobalIndex === null &&
          state.visits.size === 0;
        if (isSynthetic) {
          state.segmentBoundaries[0].title = event.payload.title;
        } else {
          closeSegment(state, event.t, event.payload.title);
        }
        break;
      }
      case 'reset': {
        closeSegment(state, event.t, null);
        break;
      }
      case 'state-patch': {
        const cgi = event.payload.currentGlobalIndex;
        if (cgi === undefined) {
          // ADR-143 §5.4: state-patch без currentGlobalIndex —
          // тренер обновил дерево/аннотации, но указатель не сменил.
          break;
        }
        if (cgi !== state.currentGlobalIndex) {
          closeVisit(state, event.t);
          state.currentGlobalIndex = cgi;
          state.visitStartedAtMs = event.t;
        }
        // cgi === currentGlobalIndex — посещение продолжается, ничего
        // не делаем (§8.5).
        break;
      }
      case 'move': {
        // ADR-143 §5.6: move не несёт currentGlobalIndex; узел будет
        // зафиксирован следующим state-patch'ем.
        break;
      }
      case 'closed': {
        closeSegment(state, event.t, null);
        break;
      }
      default: {
        // Exhaustive check на случай расширения RecordedEvent.
        // Неизвестное событие безопасно игнорируем — индекс
        // остаётся консервативно корректным.
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  // ── Финализация ─────────────────────────────────────────────────
  // (a) Если осталось открытое посещение — закрываем по totalDurationMs.
  if (state.currentGlobalIndex !== null) {
    closeVisit(state, totalDurationMs);
  }
  // (b) Последний boundary без endedAtMs — закрываем по totalDurationMs.
  const lastBoundary =
    state.segmentBoundaries[state.segmentBoundaries.length - 1];
  if (lastBoundary.endedAtMs === null) {
    lastBoundary.endedAtMs = totalDurationMs;
  }
  // (c) Удаляем трейлинговый пустой boundary (артефакт обработки
  // 'closed' или ситуация startedAtMs===totalDurationMs). Без этого
  // в массиве торчал бы лишний сегмент длиной 0 после closed-события.
  if (
    state.segmentBoundaries.length > 1 &&
    state.segmentBoundaries[state.segmentBoundaries.length - 1]
      .startedAtMs ===
      state.segmentBoundaries[state.segmentBoundaries.length - 1].endedAtMs
  ) {
    state.segmentBoundaries.pop();
  }

  return {
    visits: state.visits as ReadonlyMap<string, ReadonlyArray<MoveVisit>>,
    segmentBoundaries: state.segmentBoundaries as ReadonlyArray<SegmentBoundary>,
    totalDurationMs,
  };
}
