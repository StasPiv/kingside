/**
 * KS-2017 / B-1 — печать diff'а в формат, описанный в ADR §5.5.
 */

import pc from 'picocolors';
import type { BundleDiff } from './types.js';

export interface PrintOptions {
  useColor?: boolean;
}

export function formatBundleDiff(diff: BundleDiff, opts: PrintOptions = {}): string {
  const c = opts.useColor === false ? noColor : pc;
  const lines: string[] = [];

  if (diff.course) {
    const tag = colorAction(diff.course.action, c);
    const fields = diff.course.changedFields?.length
      ? ` (fields: ${diff.course.changedFields.join(', ')})`
      : '';
    lines.push(`Course «${diff.course.slug}»: ${tag}${fields}`);
  }

  for (const lesson of diff.lessons) {
    const tag = colorAction(lesson.lessonAction, c);
    const fields = lesson.changedLessonFields?.length
      ? ` (fields: ${lesson.changedLessonFields.join(', ')})`
      : '';
    lines.push(`Lesson «${lesson.slug}»: ${tag}${fields}`);
    lines.push(`Steps (${lesson.steps.length}):`);
    for (const s of lesson.steps) {
      const stepTag = colorAction(s.action, c);
      const detail = s.details ? c.dim(`  (${s.details})`) : '';
      lines.push(
        `  #${String(s.order).padStart(2, ' ')} ${s.type.padEnd(15, ' ')} ${stepTag}${detail}`,
      );
    }
  }

  // Сводка.
  const totals = summarize(diff);
  lines.push('');
  lines.push(
    `Summary: ${totals.created} created, ${totals.updated} updated, ` +
      `${totals.unchanged} unchanged, ${totals.deleted} deleted.`,
  );
  return lines.join('\n');
}

function summarize(diff: BundleDiff) {
  const t = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
  if (diff.course) {
    if (diff.course.action === 'create') t.created++;
    else if (diff.course.action === 'update') t.updated++;
    else t.unchanged++;
  }
  for (const l of diff.lessons) {
    if (l.lessonAction === 'create') t.created++;
    else if (l.lessonAction === 'update') t.updated++;
    else t.unchanged++;
    for (const s of l.steps) {
      if (s.action === 'create') t.created++;
      else if (s.action === 'update') t.updated++;
      else if (s.action === 'delete') t.deleted++;
      else t.unchanged++;
    }
  }
  return t;
}

function colorAction(
  action: 'create' | 'update' | 'delete' | 'unchanged',
  c: typeof pc | typeof noColor,
): string {
  switch (action) {
    case 'create':
      return c.green('created');
    case 'update':
      return c.yellow('updated');
    case 'delete':
      return c.red('deleted');
    default:
      return c.dim('unchanged');
  }
}

const noColor = {
  red: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
  cyan: (s: string) => s,
  bold: (s: string) => s,
  dim: (s: string) => s,
};
