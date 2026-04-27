/**
 * KS-2045 — публичный API пакета `@kingside/pdf-to-lesson-yaml`.
 *
 * Этап 1: только text-шаги с inline-диаграммами. PGN/puzzle — этапы 2..3.
 */

export { extractPdf } from './extractor.js';
export { transformAstToSteps, buildLesson } from './transformer.js';
export { serializeLesson, serializeCourse } from './yaml-serializer.js';
export { validateLesson, validateCourse } from './validator.js';
export type {
  ConverterConfig,
  ConverterChapterConfig,
  ConverterCourseConfig,
  PdfBlock,
  PdfHeadingBlock,
  PdfProseBlock,
  PdfDiagramBlock,
  PdfExtractResult,
  YamlLessonFile,
  YamlCourseFile,
  YamlTextStep,
  YamlTextDiagram,
} from './types.js';
