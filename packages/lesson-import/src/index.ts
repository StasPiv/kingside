/**
 * @kingside/lesson-import — публичные сущности (для тестов и
 * потенциальной программной интеграции). CLI-точка входа — `./cli.js`.
 */

export { loadBundle, parseCourseYaml, parseLessonYaml, ValidationFailure } from './parser.js';
export { describeAjvErrors, formatError, formatErrors } from './errors.js';
export { diffBundle, diffCourseMeta, diffLesson, diffSteps, deepEqual } from './diff.js';
export { formatBundleDiff } from './diff-print.js';
export { upsertBundle, type UpsertOptions, type UpsertResult } from './upserter.js';
export { AdminApiClient } from './api-client.js';
export {
  exportCourse,
  serializeCourse,
  serializeLesson,
  courseFromSnapshot,
  lessonFromSnapshot,
  type ExportOptions,
  type ExportResult,
} from './exporter.js';
export type {
  ParsedBundle,
  ParsedCourseFile,
  ParsedLessonFile,
  CourseFileData,
  LessonFileData,
  LessonStepData,
  DescribedError,
  BundleDiff,
  LessonDiff,
  StepDiffEntry,
  StepAction,
  DbCourseSnapshot,
  DbLessonSnapshot,
  DbStepSnapshot,
} from './types.js';
