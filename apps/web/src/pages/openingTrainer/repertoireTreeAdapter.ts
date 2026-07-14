/**
 * KS-3305. Adapter `RepertoireTree → GameMove[]`.
 *
 * Конвертирует структуру репертуара (rootFen + nodes по FEN с edges)
 * в линейный массив `GameMove[]` (главная линия) с прикреплёнными
 * `variations[][]` — формат, который понимает `ReviewMoveList`
 * (`apps/web/src/components/ReviewMoveList.tsx`).
 *
 * Стратегия:
 *   - DFS от `rootFen`. На каждом node ПЕРВЫЙ edge → main move; остальные
 *     edges → variations (рекурсивно — каждая variation сама может
 *     ветвиться).
 *   - GlobalIndex счётчик инкрементируется при добавлении любого хода —
 *     main или variation; индексы > 999 ReviewMoveList трактует как
 *     variation (старый порог из puzzle-analysis), не влияет на нашу
 *     визуализацию, но мы соблюдаем контракт.
 *   - `from/to/uci/ply/fen` — выводим из `RepertoireEdge` (UCI → from/to,
 *     ply = длина пути в полуходах, fen = childFen).
 *   - Защита от циклов: `seenInBranch` Set по FEN'ам — транспозиции
 *     отсекаем (бэк schenken их при парсинге, но для надёжности).
 *
 * Orphan-линии (KS-3286 §2.5) НЕ попадают в вывод — проверяем по
 * `linesByPath[pathKey].orphaned`.
 */
import type {
  OpeningLineProgressDto,
  RepertoireTree,
} from '@kingside/shared';
import type { GameMove } from '../../hooks/useChessGame';

export function pathKey(pathUci: string[]): string {
  return pathUci.join('|');
}

interface BuildCtx {
  tree: RepertoireTree;
  linesByPath: Map<string, OpeningLineProgressDto>;
  nextGlobalIndex: () => number;
  /**
   * KS-4967. Смещение полуходов от стартовой позиции до `rootFen`.
   * ReviewMoveList выводит номер и сторону из `move.ply`
   * (moveNumber = ceil(ply/2), белые — нечётный ply). Для репертуара
   * из PGN с [FEN] rootFen может быть не startpos, поэтому абсолютный
   * ply = basePlyOffset + длина пути. Для startpos offset = 0.
   */
  basePlyOffset: number;
}

/**
 * KS-4967. База полуходов до rootFen: сколько полуходов сыграно от
 * стартовой позиции до неё. Из FEN берём номер полного хода (поле 6)
 * и сторону (поле 2):
 *   - белые к ходу, полный ход F → сыграно 2·(F−1) полуходов;
 *   - чёрные к ходу, полный ход F → сыграно 2·(F−1)+1 полуход.
 * Абсолютный ply первого хода = offset + 1, что даёт корректную
 * нумерацию (напр. rootFen «… b … 8» → первый ход «8…», второй «9.»).
 * Для startpos (w, 1) и нераспознанного FEN (напр. литерал 'start')
 * возвращаем 0 — нумерация как прежде.
 */
export function basePlyOffsetFromRootFen(rootFen: string): number {
  const parts = rootFen.trim().split(/\s+/);
  const side = parts[1];
  const fullmove = Number.parseInt(parts[5], 10);
  if ((side !== 'w' && side !== 'b') || Number.isNaN(fullmove) || fullmove < 1) {
    return 0;
  }
  return side === 'b' ? 2 * (fullmove - 1) + 1 : 2 * (fullmove - 1);
}

function buildSequence(
  ctx: BuildCtx,
  startFen: string,
  startPathUci: string[],
  seenInBranch: Set<string>,
): GameMove[] {
  const result: GameMove[] = [];
  let currentFen = startFen;
  let currentPath = startPathUci;
  while (true) {
    const node = ctx.tree.nodes[currentFen];
    if (!node || node.edges.length === 0) break;
    if (seenInBranch.has(currentFen)) break;
    seenInBranch.add(currentFen);

    // KS-3305: фильтрация orphan'ов — линии не существующих в текущей
    // версии дерева не отображаем.
    const visibleEdges = node.edges.filter((edge) => {
      const childKey = pathKey([...currentPath, edge.moveUci]);
      const line = ctx.linesByPath.get(childKey);
      return !line?.orphaned;
    });
    if (visibleEdges.length === 0) break;

    const mainEdge = visibleEdges[0];
    const altEdges = visibleEdges.slice(1);

    const mainPath = [...currentPath, mainEdge.moveUci];
    const ply = ctx.basePlyOffset + mainPath.length;
    const variations: GameMove[][] = altEdges.map((edge) => {
      // Variation начинается с alt-edge'а; его FEN — childFen.
      const altMove: GameMove = makeMove(ctx, edge, currentPath, ply);
      const altRest = buildSequence(
        ctx,
        edge.childFen,
        [...currentPath, edge.moveUci],
        new Set(seenInBranch), // отдельная ветка — клонируем
      );
      return [altMove, ...altRest];
    });

    const mainMove: GameMove = {
      ...makeMove(ctx, mainEdge, currentPath, ply),
      variations,
    };
    result.push(mainMove);

    currentFen = mainEdge.childFen;
    currentPath = mainPath;
  }
  return result;
}

function makeMove(
  ctx: BuildCtx,
  edge: { moveUci: string; moveSan: string; childFen: string },
  parentPath: string[],
  ply: number,
): GameMove {
  const from = edge.moveUci.slice(0, 2);
  const to = edge.moveUci.slice(2, 4);
  return {
    san: edge.moveSan,
    fen: edge.childFen,
    uci: edge.moveUci,
    from,
    to,
    ply,
    globalIndex: ctx.nextGlobalIndex(),
    variations: [],
    next: null,
    previous: null,
  };
  // next/previous будут заполнены позже linkMoves'ом, если потребуется
  // (для ReviewMoveList глобальный index'ов достаточно — он навигирует
  // через onMoveClick → globalIndex lookup в callback'е). Параметр
  // parentPath сейчас не используется, оставляю для будущих расширений.
  void parentPath;
}

/**
 * KS-3305. Главная точка входа. Возвращает массив главной линии
 * репертуара с прикреплёнными альтернативами через
 * `variations[][]`. На вход — структура из shared.
 */
export function repertoireTreeToGameMoves(
  tree: RepertoireTree,
  lines: OpeningLineProgressDto[],
): GameMove[] {
  const linesByPath = new Map<string, OpeningLineProgressDto>();
  for (const l of lines) {
    linesByPath.set(pathKey(l.pathUci), l);
  }
  let counter = 0;
  const ctx: BuildCtx = {
    tree,
    linesByPath,
    nextGlobalIndex: () => counter++,
    basePlyOffset: basePlyOffsetFromRootFen(tree.rootFen),
  };
  return buildSequence(ctx, tree.rootFen, [], new Set());
}
