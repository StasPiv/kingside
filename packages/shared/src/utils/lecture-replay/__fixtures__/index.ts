/**
 * KS-4639 / ADR-143 §10. Восемь синтетических фикстур F1-F8 — формальная
 * спецификация поведения `buildMoveTimestampIndex`. Любое расхождение
 * builder ↔ ожидание здесь — критическая регрессия (см. §12.1).
 *
 * Расписаны строго по ADR §10. Не редактировать без согласования
 * правки самого ADR.
 */
import type { RecordedEvent } from '../../../types/live-analysis.js';

export type Fixture = {
  /** F1, F2, …; используется в имени теста. */
  label: string;
  /** Описание из ADR (для читаемости). */
  description: string;
  events: RecordedEvent[];
  totalDurationMs: number;
  /** Ожидание — компактный snapshot. visits — Record для удобства
   *  сравнения (Map → Object); порядок ключей не важен. */
  expected: {
    visits: Record<string, Array<{ enteredAtMs: number; endedAtMs: number; durationMs: number }>>;
    segmentBoundaries: Array<{
      segment: number;
      startedAtMs: number;
      endedAtMs: number | null;
      title: string | null;
    }>;
    totalDurationMs: number;
  };
};

/** F1. Прямая партия без вариаций. */
export const F1: Fixture = {
  label: 'F1',
  description: 'прямая партия без вариаций — два посещения подряд',
  events: [
    { t: 0, type: 'move', payload: { uci: 'e2e4', ply: 1 } },
    {
      t: 200,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    { t: 5000, type: 'move', payload: { uci: 'e7e5', ply: 2 } },
    {
      t: 5100,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 1, orientation: 'white' },
    },
    { t: 12000, type: 'closed', payload: { reason: 'by_owner' } },
  ],
  totalDurationMs: 12000,
  expected: {
    visits: {
      '0:0': [{ enteredAtMs: 200, endedAtMs: 5100, durationMs: 4900 }],
      '0:1': [{ enteredAtMs: 5100, endedAtMs: 12000, durationMs: 6900 }],
    },
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 12000, title: null },
    ],
    totalDurationMs: 12000,
  },
};

/** F2. Возврат к узлу — у одного ключа два посещения. */
export const F2: Fixture = {
  label: 'F2',
  description: 'возврат на узел 0 после захода на узел 1',
  events: [
    {
      t: 100,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    {
      t: 2000,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 1, orientation: 'white' },
    },
    {
      t: 5000,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    {
      t: 9000,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 2, orientation: 'white' },
    },
    { t: 15000, type: 'closed', payload: { reason: 'by_owner' } },
  ],
  totalDurationMs: 15000,
  expected: {
    visits: {
      '0:0': [
        { enteredAtMs: 100, endedAtMs: 2000, durationMs: 1900 },
        { enteredAtMs: 5000, endedAtMs: 9000, durationMs: 4000 },
      ],
      '0:1': [{ enteredAtMs: 2000, endedAtMs: 5000, durationMs: 3000 }],
      '0:2': [{ enteredAtMs: 9000, endedAtMs: 15000, durationMs: 6000 }],
    },
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 15000, title: null },
    ],
    totalDurationMs: 15000,
  },
};

/** F3. Reset в середине — сегмент инкрементируется, title=null. */
export const F3: Fixture = {
  label: 'F3',
  description: 'reset разделяет на два сегмента; ключи "0:0" и "1:0" разные',
  events: [
    {
      t: 100,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    { t: 3000, type: 'reset', payload: { fen: 'startpos', orientation: 'white' } },
    {
      t: 4000,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    { t: 10000, type: 'closed', payload: { reason: 'by_owner' } },
  ],
  totalDurationMs: 10000,
  expected: {
    visits: {
      '0:0': [{ enteredAtMs: 100, endedAtMs: 3000, durationMs: 2900 }],
      '1:0': [{ enteredAtMs: 4000, endedAtMs: 10000, durationMs: 6000 }],
    },
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 3000, title: null },
      { segment: 1, startedAtMs: 3000, endedAtMs: 10000, title: null },
    ],
    totalDurationMs: 10000,
  },
};

/** F4. Analysis-switch синтетический на t=0 — НЕ инкрементирует, только title. */
export const F4: Fixture = {
  label: 'F4',
  description:
    'нулевой синтетический analysis-switch проставляет title без сдвига сегмента',
  events: [
    { t: 0, type: 'analysis-switch', payload: { analysisId: 'A1', title: 'A1' } },
    {
      t: 500,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    { t: 10000, type: 'analysis-switch', payload: { analysisId: 'A2', title: 'A2' } },
    {
      t: 11000,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    { t: 20000, type: 'closed', payload: { reason: 'by_owner' } },
  ],
  totalDurationMs: 20000,
  expected: {
    visits: {
      '0:0': [{ enteredAtMs: 500, endedAtMs: 10000, durationMs: 9500 }],
      '1:0': [{ enteredAtMs: 11000, endedAtMs: 20000, durationMs: 9000 }],
    },
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 10000, title: 'A1' },
      { segment: 1, startedAtMs: 10000, endedAtMs: 20000, title: 'A2' },
    ],
    totalDurationMs: 20000,
  },
};

/** F5. state-patch без currentGlobalIndex — не закрывает посещение. */
export const F5: Fixture = {
  label: 'F5',
  description:
    'промежуточный state-patch без currentGlobalIndex не сдвигает указатель',
  events: [
    {
      t: 100,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    // currentGlobalIndex опущен — только tree.
    {
      t: 2000,
      type: 'state-patch',
      payload: { tree: '{"updated":true}', orientation: 'white' },
    },
    {
      t: 5000,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 1, orientation: 'white' },
    },
    { t: 10000, type: 'closed', payload: { reason: 'by_owner' } },
  ],
  totalDurationMs: 10000,
  expected: {
    visits: {
      '0:0': [{ enteredAtMs: 100, endedAtMs: 5000, durationMs: 4900 }],
      '0:1': [{ enteredAtMs: 5000, endedAtMs: 10000, durationMs: 5000 }],
    },
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 10000, title: null },
    ],
    totalDurationMs: 10000,
  },
};

/** F6. Move без следующего state-patch — нового посещения нет. */
export const F6: Fixture = {
  label: 'F6',
  description:
    'move без последующего state-patch не создаёт нового посещения; узел остаётся прежним',
  events: [
    {
      t: 1000,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 3, orientation: 'white' },
    },
    { t: 8000, type: 'move', payload: { uci: 'e2e4', ply: 5 } },
    { t: 10000, type: 'closed', payload: { reason: 'by_owner' } },
  ],
  totalDurationMs: 10000,
  expected: {
    visits: {
      '0:3': [{ enteredAtMs: 1000, endedAtMs: 10000, durationMs: 9000 }],
    },
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 10000, title: null },
    ],
    totalDurationMs: 10000,
  },
};

/** F7. Узел никогда не активен — только один введённый узел в индексе. */
export const F7: Fixture = {
  label: 'F7',
  description:
    'единственное посещение; узлы, на которых тренер не стоял, в индекс не попадают',
  events: [
    {
      t: 100,
      type: 'state-patch',
      payload: { tree: '{}', currentGlobalIndex: 0, orientation: 'white' },
    },
    { t: 5000, type: 'closed', payload: { reason: 'by_owner' } },
  ],
  totalDurationMs: 5000,
  expected: {
    visits: {
      '0:0': [{ enteredAtMs: 100, endedAtMs: 5000, durationMs: 4900 }],
    },
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 5000, title: null },
    ],
    totalDurationMs: 5000,
  },
};

/** F8. Только closed — пустой индекс посещений. */
export const F8: Fixture = {
  label: 'F8',
  description: 'closed без предшествующего активного узла — visits.size === 0',
  events: [{ t: 3000, type: 'closed', payload: { reason: 'by_owner' } }],
  totalDurationMs: 3000,
  expected: {
    visits: {},
    segmentBoundaries: [
      { segment: 0, startedAtMs: 0, endedAtMs: 3000, title: null },
    ],
    totalDurationMs: 3000,
  },
};

export const ALL_FIXTURES: Fixture[] = [F1, F2, F3, F4, F5, F6, F7, F8];
