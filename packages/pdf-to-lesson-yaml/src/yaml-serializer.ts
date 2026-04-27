/**
 * KS-2045 — сериализация Lesson/Course YAML.
 * Используем js-yaml в режиме block-style с `lineWidth: -1`, чтобы
 * длинные bodyMarkdown'ы не ломались по словам.
 */

import yaml from 'js-yaml';
import type { YamlCourseFile, YamlLessonFile } from './types.js';

const DUMP_OPTS: yaml.DumpOptions = {
  lineWidth: -1,
  noRefs: true,
  // sortKeys: false — сохраняем порядок полей объекта (мы строим их в
  // нужном порядке в transformer'е).
  sortKeys: false,
  styles: { '!!null': 'empty' },
};

export function serializeLesson(lesson: YamlLessonFile): string {
  return yaml.dump(lesson, DUMP_OPTS);
}

export function serializeCourse(course: YamlCourseFile): string {
  return yaml.dump(course, DUMP_OPTS);
}
