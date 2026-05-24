/**
 * KS-3296 (M2 F2). RepertoireTreeView — вертикальный DFS-обход дерева
 * репертуара. Каждый edge раскрашен по статусу линии (пути от root до
 * childFen):
 *   - mastered  — зелёный (✓ освоено)
 *   - due       — синий   (🔁 пора повторить)
 *   - learning  — жёлтый  (в процессе изучения)
 *   - wrong     — красный (преобладают ошибки)
 *   - not-played — серый  (ещё не пробовали)
 *
 * Orphan-линии (из старого PGN до пересборки) НЕ рендерим. Статус
 * приходит per-line в `OpeningLineProgressDto.status` (бэк KS-3286/B6
 * вычисляет в /progress). Сопоставление по `pathHash` (SHA-1 от
 * `pathUci.join('|')`) — формула гарантируется backend'ом, фронт её
 * только сравнивает.
 *
 * Tooltip по клику на edge: counters {correct, wrong, mastery
 * threshold remaining}. Mobile + desktop одинаково — кликом, не hover.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  OpeningLineProgressDto,
  OpeningLineStatus,
  RepertoireTree,
  OpeningRepertoireDetailDto,
} from '@kingside/shared';
import { OPENING_LINE_MASTERY_THRESHOLD } from '@kingside/shared';

interface Props {
  tree: OpeningRepertoireDetailDto['tree'];
  /** Per-line прогресс из GET /repertoires/:id/progress (KS-3292). */
  lines: OpeningLineProgressDto[];
}

interface EdgeRowInfo {
  /** UCI-путь от root до childFen (включительно). */
  pathUci: string[];
  moveSan: string;
  childFen: string;
  /** Только для отрисовки — глубина (полуходы от корня). */
  depth: number;
  /** Статус, дедуцированный по pathHash сопоставлению. */
  status: OpeningLineStatus;
  /** Если есть progress-запись — даём её для tooltip'а. */
  progress: OpeningLineProgressDto | null;
}

const STATUS_COLOR: Record<OpeningLineStatus, string> = {
  mastered: '#22c55e', // green
  due: '#3b82f6', // blue
  learning: '#eab308', // yellow
  wrong: '#ef4444', // red
  'not-played': '#94a3b8', // slate
};

const STATUS_LABEL_KEY: Record<OpeningLineStatus, string> = {
  mastered: 'openingTrainer.tree.status.mastered',
  due: 'openingTrainer.tree.status.due',
  learning: 'openingTrainer.tree.status.learning',
  wrong: 'openingTrainer.tree.status.wrong',
  'not-played': 'openingTrainer.tree.status.notPlayed',
};

/**
 * KS-3296. Хэш path-uci совпадает с backend'ом (KS-3286 §3.1):
 *   sha1(pathUci.join('|'))
 * Используем Web Crypto API. Возвращаем hex-строку как у бэка.
 *
 * Внимание: SubtleCrypto.digest async — поэтому строим карту lines
 * по pathHash, а сами edge-paths сравниваем по pathUci через
 * pre-computed lookup (бэк отдаёт pathUci в DTO — сравниваем напрямую).
 */
function makePathKey(pathUci: string[]): string {
  return pathUci.join('|');
}

/**
 * KS-3296. DFS по дереву от rootFen, накапливаем pathUci до каждого
 * edge'а. Возвращаем плоский массив EdgeRowInfo'в в порядке обхода
 * для вертикального рендера.
 *
 * Защита от циклов — set посещённых FEN'ов в текущей ветке.
 * Транспозиции: если childFen уже встречался — рисуем edge как
 * терминальный, без углубления (бэк уже схлопнул).
 */
function flattenTree(
  tree: RepertoireTree,
  linesByPath: Map<string, OpeningLineProgressDto>,
): EdgeRowInfo[] {
  const out: EdgeRowInfo[] = [];
  const seenInBranch = new Set<string>();

  function visit(fen: string, pathUci: string[], depth: number): void {
    const node = tree.nodes[fen];
    if (!node) return;
    if (seenInBranch.has(fen)) return;
    seenInBranch.add(fen);
    for (const edge of node.edges) {
      const nextPath = [...pathUci, edge.moveUci];
      const key = makePathKey(nextPath);
      const line = linesByPath.get(key) ?? null;
      // orphan'ы не рендерим — backend проставляет orphaned: true для
      // линий из старого PGN. M2 §2.5.
      if (line?.orphaned) continue;
      const status: OpeningLineStatus = line?.status ?? 'not-played';
      out.push({
        pathUci: nextPath,
        moveSan: edge.moveSan,
        childFen: edge.childFen,
        depth,
        status,
        progress: line,
      });
      visit(edge.childFen, nextPath, depth + 1);
    }
    seenInBranch.delete(fen);
  }
  visit(tree.rootFen, [], 0);
  return out;
}

export function RepertoireTreeView({ tree, lines }: Props) {
  const { t } = useTranslation();
  const [openedPathKey, setOpenedPathKey] = useState<string | null>(null);

  // KS-3296. Карта pathUci.join('|') → progress, для O(1) lookup'а
  // при DFS. Backend гарантирует тот же separator.
  const linesByPath = useMemo(() => {
    const m = new Map<string, OpeningLineProgressDto>();
    for (const l of lines) {
      m.set(makePathKey(l.pathUci), l);
    }
    return m;
  }, [lines]);

  const rows = useMemo(
    () => flattenTree(tree, linesByPath),
    [tree, linesByPath],
  );

  if (rows.length === 0) {
    return (
      <div
        className="opening-trainer-tree opening-trainer-tree--empty"
        data-testid="opening-trainer-tree-empty"
      >
        {t(
          'openingTrainer.tree.empty',
          'No moves in this repertoire yet.',
        )}
      </div>
    );
  }

  return (
    <ol
      className="opening-trainer-tree"
      data-testid="opening-trainer-tree"
      aria-label={t('openingTrainer.tree.aria', 'Repertoire tree')}
    >
      {rows.map((row, idx) => {
        const key = makePathKey(row.pathUci);
        const opened = openedPathKey === key;
        const color = STATUS_COLOR[row.status];
        const statusLabel = t(STATUS_LABEL_KEY[row.status], row.status);
        const moveNumber = Math.floor(row.pathUci.length / 2) + 1;
        const isWhite = row.pathUci.length % 2 === 1;
        const prefix = isWhite
          ? `${moveNumber}.`
          : `${moveNumber}…`;
        return (
          <li
            key={`${key}-${idx}`}
            className="opening-trainer-tree__row"
            data-testid={`opening-trainer-tree-row-${row.status}`}
            style={{ paddingLeft: `${row.depth * 12}px` }}
          >
            <button
              type="button"
              className="opening-trainer-tree__edge"
              onClick={() => setOpenedPathKey(opened ? null : key)}
              data-status={row.status}
              data-uci={row.pathUci[row.pathUci.length - 1]}
              aria-expanded={opened}
            >
              <span
                className="opening-trainer-tree__chip"
                style={{ background: color }}
                aria-hidden="true"
                title={statusLabel}
              />
              <span className="opening-trainer-tree__move">
                {prefix} {row.moveSan}
              </span>
              <span className="opening-trainer-tree__status">{statusLabel}</span>
            </button>
            {opened && (
              <div
                className="opening-trainer-tree__tooltip"
                role="tooltip"
                data-testid="opening-trainer-tree-tooltip"
              >
                {row.progress ? (
                  <>
                    <div>
                      {t('openingTrainer.tree.tooltip.correct', 'Correct: {{count}}', {
                        count: row.progress.correctCount,
                      })}
                    </div>
                    <div>
                      {t('openingTrainer.tree.tooltip.wrong', 'Wrong: {{count}}', {
                        count: row.progress.wrongCount,
                      })}
                    </div>
                    {row.progress.masteredAt == null && (
                      <div>
                        {t(
                          'openingTrainer.tree.tooltip.toMastery',
                          '{{count}} more in a row to master',
                          {
                            count: Math.max(
                              0,
                              OPENING_LINE_MASTERY_THRESHOLD -
                                row.progress.consecutiveCorrect,
                            ),
                          },
                        )}
                      </div>
                    )}
                    {row.progress.sm2DueAt && (
                      <div>
                        {t(
                          'openingTrainer.tree.tooltip.dueAt',
                          'Next review: {{date}}',
                          {
                            date: new Date(row.progress.sm2DueAt).toLocaleString(),
                          },
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div>
                    {t(
                      'openingTrainer.tree.tooltip.notPlayed',
                      'You haven’t played this line yet.',
                    )}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
