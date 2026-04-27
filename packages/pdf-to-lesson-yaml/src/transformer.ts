/**
 * KS-2045 Этап 1 — трансформер AST → lesson YAML.
 *
 * Этап 1 ограничивается типом `text`: каждая логическая секция (между
 * heading'ами уровня ≥ 2) превращается в один text-шаг. Внутри шага:
 *   - bodyMarkdown — собранная проза с inline-маркерами `{{diagram:N}}`,
 *     где N — индекс diagram в `step.diagrams[]` (0-based);
 *   - diagrams[] — FEN'ы соответствующих диаграмм.
 *
 * PGN-партии, puzzle, quiz — Этапы 2..3 (см. ADR KS-2044). На Stage 1
 * последовательность ходов остаётся в bodyMarkdown как обычная проза.
 *
 * Soft-merge правил эвристик:
 *   - Если конфиг главы помечен `singleStep: true` — игнорируем headings,
 *     возвращаем один text-шаг для всего диапазона.
 *   - Иначе heading level ≥ 2 (не «Часть»/«Глава» — она в lesson.title)
 *     создаёт новый step; markdown-уровень — `### N. Title`, чтобы
 *     совпадать с ручной разметкой архитектора.
 */

import type {
  ConverterChapterConfig,
  PdfBlock,
  PdfDiagramBlock,
  PdfExtractResult,
  YamlLessonFile,
  YamlTextStep,
} from './types.js';

interface StepBuilder {
  /** Заголовок секции для bodyMarkdown (без `### `). */
  heading?: string;
  proseBlocks: string[];
  diagramFens: string[];
  /** Маркеры диаграмм, вставленные в bodyMarkdown в виде `{{diagram:N}}`. */
  diagramAt: number[]; // позиции в proseBlocks: после какого блока вставить
}

const FRESH_STEP = (): StepBuilder => ({
  proseBlocks: [],
  diagramFens: [],
  diagramAt: [],
});

function normalizeProse(text: string): string {
  // PyMuPDF возвращает строки, разорванные по ширине столбца; склеиваем
  // по одиночным переводам строки в пробелы. Двойной перевод оставляем
  // как разделитель параграфов.
  return text
    .replace(/-\n/g, '') // мягкий переносы переноса по дефису
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeading(text: string): string {
  // Заголовки в Калиниченко часто заглавными «1. ИГРА» — оставляем как есть,
  // только убираем переносы строк.
  return text.replace(/\s+/g, ' ').trim();
}

function buildBodyMarkdown(s: StepBuilder): string {
  const lines: string[] = [];
  if (s.heading) {
    lines.push(`### ${s.heading}`);
    lines.push('');
  }
  // diagramAt[k] — индекс блока, после которого нужно вставить diagram k.
  // Для блока i: добавляем prose, затем все diagram'ы где diagramAt === i.
  for (let i = 0; i < s.proseBlocks.length; i++) {
    if (s.proseBlocks[i]) {
      lines.push(s.proseBlocks[i]);
      lines.push('');
    }
    for (let k = 0; k < s.diagramAt.length; k++) {
      if (s.diagramAt[k] === i) {
        lines.push(`{{diagram:${k}}}`);
        lines.push('');
      }
    }
  }
  // diagram'ы, оказавшиеся «до» первого prose'а (diagramAt === -1).
  // Stage 1 не должен такое генерировать (heading всегда первый), но
  // защищаемся.
  for (let k = 0; k < s.diagramAt.length; k++) {
    if (s.diagramAt[k] === -1) {
      lines.unshift(`{{diagram:${k}}}`);
      lines.unshift('');
    }
  }
  return lines.join('\n').trim();
}

function builderToStep(s: StepBuilder): YamlTextStep | null {
  const body = buildBodyMarkdown(s);
  if (!body && s.diagramFens.length === 0) {
    return null;
  }
  const step: YamlTextStep = {
    type: 'text',
    bodyMarkdown: body,
  };
  if (s.diagramFens.length > 0) {
    step.diagrams = s.diagramFens.map((fen) => ({ fen, orientation: 'white' }));
  }
  return step;
}

/**
 * AST → массив text-шагов согласно эвристикам Этапа 1.
 *
 * @param ast - результат Python-extractor'а.
 * @param chapter - конфигурация главы (singleStep, slug и т. д.).
 */
export function transformAstToSteps(
  ast: PdfExtractResult,
  chapter: ConverterChapterConfig,
): YamlTextStep[] {
  const steps: YamlTextStep[] = [];
  let current: StepBuilder = FRESH_STEP();

  const closeCurrent = () => {
    const s = builderToStep(current);
    if (s) steps.push(s);
    current = FRESH_STEP();
  };

  for (const block of ast.blocks) {
    if (block.kind === 'heading') {
      // Уровень 1 = «Часть»/«Глава» — это lesson.title, не открываем шаг.
      if (block.level <= 1) continue;
      // Уровень 2..3 — новая секция → новый шаг (если у текущего уже что-то накоплено).
      if (chapter.singleStep) {
        // Записываем как обычную «жирную» строку в bodyMarkdown — без разбиения.
        current.proseBlocks.push(`**${normalizeHeading(block.text)}**`);
        continue;
      }
      // Закрываем предыдущий, открываем новый.
      if (
        current.proseBlocks.length > 0 ||
        current.diagramFens.length > 0 ||
        current.heading
      ) {
        closeCurrent();
      }
      current.heading = normalizeHeading(block.text);
      continue;
    }
    if (block.kind === 'prose') {
      current.proseBlocks.push(normalizeProse(block.text));
      continue;
    }
    if (block.kind === 'diagram') {
      const diagramBlock = block as PdfDiagramBlock;
      const localIdx = current.diagramFens.length;
      current.diagramFens.push(diagramBlock.fen);
      // Вставляем `{{diagram:N}}` в позицию «после последнего prose»
      // (или -1, если prose ещё не было — placeholder ставится в начало
      // body после заголовка).
      const after = current.proseBlocks.length - 1;
      // localIdx — индекс в diagrams[]. Используем массив diagramAt:
      // diagramAt[localIdx] = after.
      current.diagramAt[localIdx] = after;
      continue;
    }
  }
  closeCurrent();
  return steps;
}

/**
 * Свести шаги в готовый объект YamlLessonFile.
 */
export function buildLesson(
  ast: PdfExtractResult,
  chapter: ConverterChapterConfig,
  courseSlug: string,
): YamlLessonFile {
  const steps = transformAstToSteps(ast, chapter);
  // Если ничего не извлеклось (пустая глава) — оставляем один пустой text-шаг
  // с пометкой, чтобы валидация lesson.schema.json не падала
  // (`steps.minItems = 1`).
  if (steps.length === 0) {
    steps.push({
      type: 'text',
      bodyMarkdown: `// TODO: глава пуста после извлечения. Проверить page-range ${ast.pageRange[0]}–${ast.pageRange[1]} в PDF.`,
    });
  }
  const lesson: YamlLessonFile = {
    schemaVersion: 1,
    courseSlug,
    slug: chapter.slug,
    order: chapter.order,
    blockKey: chapter.blockKey,
    kind: chapter.kind,
    isPublished: chapter.isPublished ?? false,
    titleKey: chapter.titleKey,
    summaryKey: chapter.summaryKey,
    title: chapter.title,
    summary: chapter.summary,
    estMinutes: chapter.estMinutes,
    steps,
  };
  return lesson;
}
