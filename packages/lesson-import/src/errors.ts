/**
 * KS-2017 / B-1 — форматирование AJV-ошибок в человекочитаемые
 * сообщения вида «<file>: steps[3].pgn — must be string (keyword=type)».
 *
 * AJV возвращает массив `errors` с полями `instancePath`, `keyword`,
 * `message`, `params`. Мы их раскладываем по файлам и красим контекст.
 */

import type { ErrorObject } from 'ajv';
import pc from 'picocolors';
import type { DescribedError, LessonStepData } from './types.js';

/**
 * Прокинуть AJV-ошибки через картирование «которая степень какого
 * шага». На входе — instance (распарсенный YAML), на выходе строки
 * вида `steps[3] (game_review).pgn` вместо `/steps/3/pgn`.
 */
/**
 * type → имя sub-схемы в lesson.schema.json#/definitions. AJV в
 * `errors[].schemaPath` указывает путь до схемы, по которой ошибка;
 * для шага с `type: 'text'` оставляем только ошибки, попавшие в
 * `#/definitions/StepText/...` или в саму `oneOf` ветку, и
 * выкидываем шумные ошибки от других 7 sub-схем.
 */
const STEP_TYPE_TO_SCHEMA: Record<string, string> = {
  text: 'StepText',
  game_review: 'StepGameReview',
  position: 'StepPosition',
  quiz: 'StepQuiz',
  puzzle: 'StepPuzzle',
  endgame_drill: 'StepEndgameDrill',
  opening_drill: 'StepOpeningDrill',
  video: 'StepVideo',
};

export function describeAjvErrors(
  file: string,
  instance: unknown,
  errors: readonly ErrorObject[] | null | undefined,
): DescribedError[] {
  if (!errors || errors.length === 0) return [];
  const filtered = filterOneOfNoise(errors, instance);
  return filtered.map((err) => ({
    file,
    instancePath: humanizePath(err.instancePath, instance),
    message: err.message ?? '<no message>',
    keyword: err.keyword,
    params: err.params as Record<string, unknown> | undefined,
  }));
}

/**
 * Сократить шум `oneOf` дискриминатора по `type`. AJV прогоняет
 * объект через все 8 sub-схем шагов и для каждой неподходящей выдаёт
 * 5–10 ошибок («required: fen», «additionalProperties: body», …).
 *
 * Стратегия:
 *  - если у шага есть осмысленный `type` (входит в STEP_TYPE_TO_SCHEMA),
 *    оставляем только ошибки, попавшие в его собственную sub-схему
 *    либо в углубление `/steps/N/<field>...` (это всегда «свои» поля
 *    шага, в т. ч. через `$ref` на Fen/Diagram/CustomPuzzle и т. п.);
 *  - если `type` не задан / неизвестен — оставляем оригинальный
 *    набор + общую ошибку oneOf, чтобы автор увидел «type должен быть
 *    одним из …».
 */
function filterOneOfNoise(
  errors: readonly ErrorObject[],
  instance: unknown,
): ErrorObject[] {
  const stepTypes = collectStepTypes(instance); // idx → StepXxx-имя
  const stepRawTypes = collectRawStepTypes(instance); // idx → 'text'|'game_review'|...
  const out: ErrorObject[] = [];
  for (const err of errors) {
    const m = err.instancePath.match(/^\/steps\/(\d+)(\/.*)?$/);
    if (!m) {
      out.push(err);
      continue;
    }
    const idx = Number(m[1]);
    const tail = m[2] ?? '';
    const expected = stepTypes[idx];
    const rawType = stepRawTypes[idx];
    if (!expected) {
      // type шага неизвестен — пользователю важно увидеть варианты.
      out.push(err);
      continue;
    }

    // Спецслучай: ошибка `/steps/N/type` от чужой sub-схемы (AJV даёт
    // const-ошибку для каждой из 7 не-подходящих веток `oneOf`).
    // Скрываем такие — type шага уже валиден сам по себе.
    if (tail === '/type' && err.keyword === 'const') {
      const allowed = (err.params as { allowedValue?: unknown } | undefined)?.allowedValue;
      if (allowed !== rawType) continue;
    }

    if (tail.length > 0) {
      // ошибка вглубь поля шага — оставляем (пример: diagrams[0].fen, body, …).
      out.push(err);
      continue;
    }

    // На самом шаге: оставляем только ошибки нашей sub-схемы либо
    // общую oneOf на корневом Step (полезно когда ни одна не подошла).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaPath = (err as any).schemaPath as string | undefined;
    if (!schemaPath) continue;
    if (schemaPath.includes(`#/definitions/${expected}`)) {
      out.push(err);
      continue;
    }
    if (schemaPath === '#/oneOf' || schemaPath === '#/definitions/Step/oneOf') {
      out.push(err);
      continue;
    }
  }
  return out;
}

function collectStepTypes(instance: unknown): Record<number, string | undefined> {
  const out: Record<number, string | undefined> = {};
  if (instance === null || typeof instance !== 'object') return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = (instance as any).steps;
  if (!Array.isArray(steps)) return out;
  for (let i = 0; i < steps.length; i++) {
    const t = steps[i]?.type;
    if (typeof t === 'string' && t in STEP_TYPE_TO_SCHEMA) {
      out[i] = STEP_TYPE_TO_SCHEMA[t];
    } else {
      out[i] = undefined;
    }
  }
  return out;
}

function collectRawStepTypes(instance: unknown): Record<number, string | undefined> {
  const out: Record<number, string | undefined> = {};
  if (instance === null || typeof instance !== 'object') return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = (instance as any).steps;
  if (!Array.isArray(steps)) return out;
  for (let i = 0; i < steps.length; i++) {
    const t = steps[i]?.type;
    out[i] = typeof t === 'string' ? t : undefined;
  }
  return out;
}


/**
 * AJV выдаёт `instancePath` вида `/steps/3/diagrams/0/fen`. Превращаем
 * в `steps[3] (text).diagrams[0].fen` — добавляем `type` шага в скобках,
 * чтобы автору урока было видно, какой шаг сломан.
 */
export function humanizePath(instancePath: string, instance: unknown): string {
  if (!instancePath || instancePath === '') return '<root>';
  // AJV draft-07 разделитель — '/'.
  const segments = instancePath.split('/').filter(Boolean);
  const out: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = instance;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const num = Number(seg);
    if (Number.isInteger(num) && String(num) === seg) {
      // Индекс массива.
      const prev = out.pop() ?? '';
      out.push(`${prev}[${num}]`);
      // Если шагаем по `steps[N]` — вытащим тип.
      if (cur && Array.isArray(cur)) {
        cur = cur[num];
        if (
          prev === 'steps' &&
          cur &&
          typeof cur === 'object' &&
          typeof (cur as LessonStepData).type === 'string'
        ) {
          // Заменяем `steps[N]` → `steps[N] (text)`.
          const tag = `steps[${num}] (${(cur as LessonStepData).type})`;
          out[out.length - 1] = tag;
        }
      }
    } else {
      out.push(seg);
      if (cur && typeof cur === 'object') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cur = (cur as any)[seg];
      }
    }
  }
  return out.join('.');
}

/** Печатаемая строка одной ошибки для CLI-вывода. */
export function formatError(err: DescribedError, useColor = true): string {
  const c = useColor ? pc : noColor;
  const path = err.instancePath === '<root>' ? '' : ` ${c.cyan(err.instancePath)}`;
  const params = err.params && Object.keys(err.params).length > 0
    ? ` ${c.dim(JSON.stringify(err.params))}`
    : '';
  return `${c.red('✗')} ${c.bold(err.file)}:${path} — ${err.message} ${c.dim(`(${err.keyword})`)}${params}`;
}

export function formatErrors(errs: DescribedError[], useColor = true): string {
  return errs.map((e) => formatError(e, useColor)).join('\n');
}

const noColor = {
  red: (s: string) => s,
  cyan: (s: string) => s,
  bold: (s: string) => s,
  dim: (s: string) => s,
};
