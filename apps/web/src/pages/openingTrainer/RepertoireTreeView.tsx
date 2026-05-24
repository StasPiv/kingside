/**
 * KS-3296 (M2 F2) + KS-3304 (rewrite). RepertoireTreeView — nested
 * tree-структура с visual hierarchy.
 *
 * Прошлая реализация (KS-3296) была плоским DFS-списком с indent по
 * depth — пользователь видел «простыню» сверху вниз и не понимал где
 * развилки.
 *
 * Теперь — настоящий tree: каждый node репертуара рендерится с
 * ВСЕМИ его edges как siblings (если у позиции 3 ответа, видим 3
 * строки рядом, не лесенкой). Главная линия (первый edge) выделена
 * жирнее; альтернативы менее яркие. Под каждым edge'ом рекурсивно
 * нестится поддерево достижимой позиции.
 *
 * Каждый edge раскрашен по статусу пути от root до childFen:
 *   mastered (зелёный) / due (синий) / learning (жёлтый) /
 *   wrong (красный) / not-played (серый).
 *
 * Orphan-линии (M2 §2.5) не рендерятся. Транспозиции (тот же FEN из
 * разных путей) — schenken visited-set по веткам, чтобы не зациклиться.
 *
 * Клик по edge — раскрывает inline-tooltip с counters: correctCount,
 * wrongCount, оставшихся подряд до мастеринга, sm2DueAt.
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

function pathKey(pathUci: string[]): string {
  return pathUci.join('|');
}

function moveLabel(pathLength: number, san: string): string {
  // KS-3304. Полуход pathLength (1-based for white, 2-based for black, …).
  // 1 → 1.   2 → 1…   3 → 2.   4 → 2…
  const moveNumber = Math.floor((pathLength - 1) / 2) + 1;
  const isWhite = pathLength % 2 === 1;
  return isWhite ? `${moveNumber}.${san}` : `${moveNumber}…${san}`;
}

interface EdgeNodeProps {
  tree: RepertoireTree;
  linesByPath: Map<string, OpeningLineProgressDto>;
  childFen: string;
  pathUci: string[];
  moveSan: string;
  /** Зрительный приоритет: первый edge родителя — главная линия. */
  isMainLine: boolean;
  /** Set посещённых FEN'ов в текущей ветке (защита от циклов). */
  seenInBranch: Set<string>;
  openedPathKey: string | null;
  setOpenedPathKey: (key: string | null) => void;
}

function EdgeNode({
  tree,
  linesByPath,
  childFen,
  pathUci,
  moveSan,
  isMainLine,
  seenInBranch,
  openedPathKey,
  setOpenedPathKey,
}: EdgeNodeProps) {
  const { t } = useTranslation();
  const key = pathKey(pathUci);
  const line = linesByPath.get(key) ?? null;
  const status: OpeningLineStatus = line?.status ?? 'not-played';
  const color = STATUS_COLOR[status];
  const statusLabel = t(STATUS_LABEL_KEY[status], status);
  const opened = openedPathKey === key;
  const label = moveLabel(pathUci.length, moveSan);

  // KS-3304. Рендерим children — все edges из childFen. На развилках
  // они видны как соседние строки одного уровня, не как лесенка.
  const childNode = tree.nodes[childFen];
  const cycle = seenInBranch.has(childFen);
  const nextSeen = useMemo(() => {
    const s = new Set(seenInBranch);
    s.add(childFen);
    return s;
  }, [seenInBranch, childFen]);
  const visibleEdges = useMemo(() => {
    if (!childNode || cycle) return [];
    return childNode.edges.filter((edge) => {
      const childKey = pathKey([...pathUci, edge.moveUci]);
      const childLine = linesByPath.get(childKey);
      return !childLine?.orphaned;
    });
  }, [childNode, cycle, pathUci, linesByPath]);

  return (
    <li
      className="opening-trainer-tree__node"
      data-testid={`opening-trainer-tree-row-${status}`}
      data-main-line={isMainLine ? 'true' : 'false'}
    >
      <button
        type="button"
        className="opening-trainer-tree__edge"
        onClick={() => setOpenedPathKey(opened ? null : key)}
        data-status={status}
        data-uci={pathUci[pathUci.length - 1]}
        aria-expanded={opened}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 6px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          fontWeight: isMainLine ? 600 : 400,
          opacity: isMainLine ? 1 : 0.78,
        }}
      >
        <span
          className="opening-trainer-tree__chip"
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
          }}
          aria-hidden="true"
          title={statusLabel}
        />
        <span className="opening-trainer-tree__move">{label}</span>
      </button>
      {opened && (
        <div
          className="opening-trainer-tree__tooltip"
          role="tooltip"
          data-testid="opening-trainer-tree-tooltip"
          style={{
            margin: '4px 0 4px 16px',
            padding: '8px 10px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            fontSize: 12,
          }}
        >
          <div>
            <strong>{statusLabel}</strong>
          </div>
          {line ? (
            <>
              <div>
                {t('openingTrainer.tree.tooltip.correct', 'Correct: {{count}}', {
                  count: line.correctCount,
                })}
              </div>
              <div>
                {t('openingTrainer.tree.tooltip.wrong', 'Wrong: {{count}}', {
                  count: line.wrongCount,
                })}
              </div>
              {line.masteredAt == null && (
                <div>
                  {t(
                    'openingTrainer.tree.tooltip.toMastery',
                    '{{count}} more in a row to master',
                    {
                      count: Math.max(
                        0,
                        OPENING_LINE_MASTERY_THRESHOLD - line.consecutiveCorrect,
                      ),
                    },
                  )}
                </div>
              )}
              {line.sm2DueAt && (
                <div>
                  {t('openingTrainer.tree.tooltip.dueAt', 'Next review: {{date}}', {
                    date: new Date(line.sm2DueAt).toLocaleString(),
                  })}
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
      {/* KS-3304. Дочерние edges (siblings'ы на развилках) — nested
          <ul>, indent через padding-left. Без CSS они всё равно
          стекают вертикально (block) и сохраняют отступ. */}
      {visibleEdges.length > 0 && (
        <ul
          className="opening-trainer-tree__children"
          style={{
            margin: 0,
            paddingLeft: 16,
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            listStyle: 'none',
          }}
        >
          {visibleEdges.map((edge, idx) => (
            <EdgeNode
              key={pathKey([...pathUci, edge.moveUci])}
              tree={tree}
              linesByPath={linesByPath}
              childFen={edge.childFen}
              pathUci={[...pathUci, edge.moveUci]}
              moveSan={edge.moveSan}
              isMainLine={isMainLine && idx === 0}
              seenInBranch={nextSeen}
              openedPathKey={openedPathKey}
              setOpenedPathKey={setOpenedPathKey}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function RepertoireTreeView({ tree, lines }: Props) {
  const { t } = useTranslation();
  const [openedPathKey, setOpenedPathKey] = useState<string | null>(null);

  // KS-3296. pathUci.join('|') → progress, для O(1) lookup'а.
  const linesByPath = useMemo(() => {
    const m = new Map<string, OpeningLineProgressDto>();
    for (const l of lines) {
      m.set(pathKey(l.pathUci), l);
    }
    return m;
  }, [lines]);

  const rootNode = tree.nodes[tree.rootFen];
  const rootEdges = useMemo(() => {
    if (!rootNode) return [];
    return rootNode.edges.filter((edge) => {
      const childKey = pathKey([edge.moveUci]);
      const childLine = linesByPath.get(childKey);
      return !childLine?.orphaned;
    });
  }, [rootNode, linesByPath]);

  if (rootEdges.length === 0) {
    return (
      <div
        className="opening-trainer-tree opening-trainer-tree--empty"
        data-testid="opening-trainer-tree-empty"
      >
        {t('openingTrainer.tree.empty', 'No moves in this repertoire yet.')}
      </div>
    );
  }

  return (
    <ul
      className="opening-trainer-tree"
      data-testid="opening-trainer-tree"
      aria-label={t('openingTrainer.tree.aria', 'Repertoire tree')}
      style={{ margin: 0, padding: 0, listStyle: 'none' }}
    >
      {rootEdges.map((edge, idx) => (
        <EdgeNode
          key={edge.moveUci}
          tree={tree}
          linesByPath={linesByPath}
          childFen={edge.childFen}
          pathUci={[edge.moveUci]}
          moveSan={edge.moveSan}
          isMainLine={idx === 0}
          seenInBranch={new Set([tree.rootFen])}
          openedPathKey={openedPathKey}
          setOpenedPathKey={setOpenedPathKey}
        />
      ))}
    </ul>
  );
}
