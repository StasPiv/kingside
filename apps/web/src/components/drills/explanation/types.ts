/**
 * KS-2456 (ADR-043 §3.3, §3.4). Контракт типов explanation-движка.
 *
 * `explainDrill()` принимает `(drill, correctAnswer, userAnswer, solved)`
 * и возвращает `DrillExplanation` — стрелки + подсветки + текстовые
 * notes (i18n keys + params + tone). UI-слой (KS-2457) рендерит этот
 * объект на доске; i18n (KS-2459) переводит keys в RU/EN текст.
 *
 * Pure-функции: никакого state, никакого fetch, никакой зависимости от
 * React. Принимаем только данные, возвращаем только данные.
 *
 * Роли стрелок и клеток финализированы в KS-2454 (chess-expert
 * методическое ревью). Ключевые соглашения:
 *  - count-attackers: одна `correct-attack` (или `defense` для defenders-
 *    варианта KS-2452) от каждой фигуры → клетка target. Стрелка идёт
 *    в КЛЕТКУ, не в фигуру на ней (X-ray, батарея).
 *  - find-pin: одна `pin-line` от attacker → anchor + клетка pinned-
 *    фигуры как `context`. Не две стрелки — связка геометрически —
 *    единый луч.
 *  - find-fork: `correct-attack` от forking-фигуры → каждая жертва.
 *    Если среди жертв король — fork с шахом, отдельная формулировка.
 *  - find-all-checks: `correct-move` от стартовой клетки → клетки-цели
 *    шахующих ходов. `missed-attack` для пропущенных пользователем,
 *    `wrong-attack` для ошибочно выбранных.
 */
import type { AnswerData, TacticDrillDto } from '@kingside/shared';

/**
 * Семантическая роль стрелки. UI-слой маппит роль → цвет + стиль (см.
 * KS-2457). Разделение `correct-attack` / `missed-attack` / `wrong-attack`
 * нужно для корректной визуальной дифференциации в drill'ах с
 * множеством ответов (find-all-checks): зелёная / серая (упущенная) /
 * красная.
 */
export type ArrowRole =
  | 'correct-attack'
  | 'missed-attack'
  | 'wrong-attack'
  | 'correct-move'
  | 'pin-line'
  | 'defense'
  | 'threat-target';

/**
 * Семантическая роль подсветки клетки. UI-слой маппит → цвет фона
 * (KS-2457). `target` — клетка, о которой задача (выделяется всегда),
 * `correct` — правильный ответ, `wrong` — ошибка пользователя,
 * `missed` — правильный, не выбранный пользователем (для shape='squares'),
 * `context` — вспомогательная клетка (anchor связки, защитники,
 * стартовая клетка хода).
 */
export type SquareRole =
  | 'target'
  | 'correct'
  | 'missed'
  | 'wrong'
  | 'context';

export interface DrillExplanationArrow {
  from: string;
  to: string;
  role: ArrowRole;
}

export interface DrillExplanationHighlight {
  square: string;
  role: SquareRole;
}

export type DrillExplanationNoteTone = 'success' | 'missed' | 'wrong' | 'info';

/**
 * Текстовая заметка. UI читает `key` через i18next, подставляет `params`,
 * раскрашивает по `tone`. Конкретные ключи и формулировки — KS-2459 +
 * комментарий chess-expert в KS-2454.
 */
export interface DrillExplanationNote {
  key: string;
  params?: Record<string, string | number>;
  tone: DrillExplanationNoteTone;
}

export interface DrillExplanation {
  arrows: DrillExplanationArrow[];
  highlights: DrillExplanationHighlight[];
  notes: DrillExplanationNote[];
}

/**
 * Вход для всех by-type функций и `explainDrill()`. `userAnswer` может
 * быть `null` если пользователь не ответил (timeout / skip), `solved`
 * — итог валидации (true ⇔ ответ совпал с эталоном по правилам §4
 * валидатора в shared).
 */
export interface ExplainDrillInput {
  drill: TacticDrillDto;
  correctAnswer: AnswerData;
  userAnswer: AnswerData | null;
  solved: boolean;
}

/** Пустой результат — для случаев когда explanation пока не собрать. */
export const EMPTY_EXPLANATION: DrillExplanation = {
  arrows: [],
  highlights: [],
  notes: [],
};
