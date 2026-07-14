/**
 * KS-4953 (ADR-165 rev4 §4/§7.4). Парсинг машинного тега `[%exit <kind>]`
 * из комментария узла-листа дерева разбора репертуара и подсчёт
 * недостроенных по предохранителю веток.
 *
 * Тег ставит генератор (positionReview.ts): каждый лист помечен причиной
 * завершения ветки. Фронт парсит тег, показывает причину и стиль.
 */

export type ExitKind =
  | 'theory'
  | 'refuted'
  | 'transposition'
  | 'forced'
  | 'limit';

const EXIT_RE = /\[%exit\s+(theory|refuted|transposition|forced|limit)\]\s*/i;

export interface ParsedExit {
  /** Причина завершения ветки, либо null если тега нет. */
  kind: ExitKind | null;
  /** Комментарий без тега [%exit …] (человекочитаемый остаток). */
  text: string;
}

/** Извлечь `[%exit <kind>]` из комментария; вернуть kind + остальной текст. */
export function parseExitTag(comment?: string | null): ParsedExit {
  if (!comment) return { kind: null, text: '' };
  const m = comment.match(EXIT_RE);
  if (!m) return { kind: null, text: comment.trim() };
  const kind = m[1].toLowerCase() as ExitKind;
  const text = comment.replace(EXIT_RE, '').trim();
  return { kind, text };
}

/** Минимальная форма узла дерева для обхода (next + variations). */
export interface ExitTreeNode {
  comment?: string;
  next?: ExitTreeNode | null;
  variations?: ExitTreeNode[][];
}

/**
 * Число листьев, помеченных `[%exit limit]` во всём дереве — «N веток не
 * достроено (лимит)». Обходит основную линию и все вариации.
 */
export function countUnfinishedBranches(
  history: readonly ExitTreeNode[] | null | undefined,
): number {
  if (!history || history.length === 0) return 0;
  let count = 0;
  const seen = new Set<ExitTreeNode>();
  const stack: ExitTreeNode[] = [...history];
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (parseExitTag(node.comment).kind === 'limit') count += 1;
    if (node.next) stack.push(node.next);
    if (node.variations) {
      for (const v of node.variations) stack.push(...v);
    }
  }
  return count;
}
