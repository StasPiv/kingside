/**
 * KS-2045 — валидация YAML-выхода через AJV.
 * Делегируем `@kingside/lesson-import` — у этого пакета уже подключена
 * `lesson-schema` AJV-валидация через nested ajv@8.x. Дублировать
 * AJV-конфиг тут не нужно (а в монорепе с pinned ajv@6 в root —
 * вредно, см. KS-2045 заметки).
 */

import yaml from 'js-yaml';
import {
  parseCourseYaml,
  parseLessonYaml,
  ValidationFailure,
} from '@kingside/lesson-import';
import type { YamlCourseFile, YamlLessonFile } from './types.js';

export interface ValidationProblem {
  path: string;
  message: string;
}

function failureToProblems(err: ValidationFailure): ValidationProblem[] {
  return err.errors.map((e) => ({
    path: e.instancePath || '/',
    message: e.message || 'invalid',
  }));
}

/**
 * Прогнать через `parseLessonYaml`. Возвращает [] если всё валидно.
 * lesson-import парсит YAML заново, поэтому передаём строку (не объект).
 */
export function validateLesson(data: YamlLessonFile): ValidationProblem[] {
  const text = yaml.dump(data, { lineWidth: -1, noRefs: true, sortKeys: false });
  try {
    parseLessonYaml('<inline>', text);
    return [];
  } catch (e) {
    if (e instanceof ValidationFailure) return failureToProblems(e);
    throw e;
  }
}

export function validateCourse(data: YamlCourseFile): ValidationProblem[] {
  const text = yaml.dump(data, { lineWidth: -1, noRefs: true, sortKeys: false });
  try {
    parseCourseYaml('<inline>', text);
    return [];
  } catch (e) {
    if (e instanceof ValidationFailure) return failureToProblems(e);
    throw e;
  }
}
