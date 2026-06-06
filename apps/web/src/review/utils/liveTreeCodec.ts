import type { ChessMove, NodeAnnotations } from '../types';
import { safeClone, linkAllMovesRecursively } from './ChessHistoryUtils';

/**
 * KS-3780: формат «дерева трансляции» — это сериализованный JSON-
 * объект, который автор отправляет зрителю через `state-patch.tree`.
 * Backend хранит его как непрозрачную строку и отдаёт обратно в
 * `sync.tree`.
 *
 * Содержимое:
 *  - `history` — массив `ChessMove` с уже проставленными `globalIndex`
 *    (теми же, что у автора в reducer'е). Циклические ссылки
 *    `next`/`previous` отфильтрованы `safeClone`'ом; зритель
 *    восстанавливает их через `linkAllMovesRecursively` после
 *    `JSON.parse`. В каждый узел вшиты аннотации (стрелочки/выделения)
 *    из reducer-карты автора `annotationsByIndex` — у зрителя
 *    `LOAD_FROM_PGN` соберёт обратно `annotationsByIndex` из
 *    `move.annotations` стандартной DFS-логикой.
 *  - `initialFen` — стартовая позиция автора.
 *  - `initialAnnotations` — аннотации к стартовой позиции
 *    (у root-узла нет `ChessMove`, поэтому они идут отдельно).
 */
export interface LiveAnalysisTreePayload {
  history: ChessMove[];
  initialFen?: string;
  initialAnnotations?: NodeAnnotations;
  /**
   * Заголовки PGN автора (`Event`/`White`/`Black`/`Result`/`WhiteElo`/...).
   * Backend хранит `tree` как непрозрачную строку, поэтому заголовки
   * едут внутри самого дерева — отдельного поля в контракте
   * `state-patch` для них нет. У зрителя `applyLiveTree` зовёт
   * `setPgnHeaders(parsed.headers ?? {})`.
   */
  headers?: Record<string, string>;
  /**
   * Заголовок анализа (по умолчанию «New analysis», редактируется
   * автором через `AnalysisHeader`). Передаём вместе с деревом, чтобы
   * у зрителя обновлялось в реальном времени без перезапроса REST-
   * снимка `/live-analyses/:slug`.
   */
  title?: string;
}

export interface SerializeLiveTreeArgs {
  history: ChessMove[];
  initialFen?: string;
  initialAnnotations?: NodeAnnotations;
  /**
   * Карта аннотаций автора, ключ — `globalIndex` узла. В reducer'е
   * `SET_ANNOTATIONS` пишет сюда, а не в `move.annotations`, поэтому
   * при сериализации мы «впечатываем» нужный элемент в каждый узел
   * клона дерева. Параметр опциональный — без него уедут только
   * `nags`/`comment`, которые reducer хранит непосредственно в узлах.
   */
  annotationsByIndex?: Record<number, NodeAnnotations>;
  /** Заголовки PGN автора (см. описание поля в `LiveAnalysisTreePayload`). */
  headers?: Record<string, string>;
  /** Заголовок анализа (см. описание поля в `LiveAnalysisTreePayload`). */
  title?: string;
}

/**
 * Пройти по клонированному дереву и проставить `annotations` каждому
 * узлу из переданной карты. Используется только перед сериализацией —
 * сам reducer карту не дублирует в узлы и мы не хотим её мутировать.
 */
function bakeAnnotations(
  moves: ChessMove[],
  byIndex: Record<number, NodeAnnotations>,
): void {
  for (const m of moves) {
    const a = byIndex[m.globalIndex];
    if (a) {
      m.annotations = a;
    }
    if (m.variations) {
      for (const v of m.variations) bakeAnnotations(v, byIndex);
    }
  }
}

/**
 * Сериализовать дерево анализа в строку для отправки в `state-patch.tree`.
 * `safeClone` удаляет циклические ссылки `next`/`previous` — иначе
 * `JSON.stringify` бы упал. После клонирования вшиваем аннотации
 * автора (см. `bakeAnnotations`).
 */
export function serializeLiveTree(args: SerializeLiveTreeArgs): string {
  const clone = safeClone(args.history);
  if (args.annotationsByIndex) {
    bakeAnnotations(clone, args.annotationsByIndex);
  }
  return JSON.stringify({
    history: clone,
    initialFen: args.initialFen,
    initialAnnotations: args.initialAnnotations,
    headers: args.headers,
    title: args.title,
  });
}

/**
 * Разобрать строку из `sync.tree` обратно в `LiveAnalysisTreePayload`.
 * После `JSON.parse` поля `next`/`previous` отсутствуют — восстанавливаем
 * их через `linkAllMovesRecursively`, чтобы дерево было готово к
 * использованию в reducer'е (`LOAD_FROM_PGN`-action). Аннотации
 * остаются в `move.annotations`; `LOAD_FROM_PGN` сам соберёт их в
 * `annotationsByIndex`.
 *
 * Бросает при невалидном JSON или несоответствии формы — caller сам
 * решит, делать ли soft-fallback.
 */
export function deserializeLiveTree(tree: string): LiveAnalysisTreePayload {
  const parsed = JSON.parse(tree) as Partial<LiveAnalysisTreePayload>;
  if (!parsed || !Array.isArray(parsed.history)) {
    throw new Error('liveTreeCodec: invalid tree payload');
  }
  linkAllMovesRecursively(parsed.history);
  return {
    history: parsed.history,
    initialFen: parsed.initialFen,
    initialAnnotations: parsed.initialAnnotations,
    headers: parsed.headers,
    title: parsed.title,
  };
}
