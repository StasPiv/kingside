/**
 * KS-3305 (rewrite). `RepertoireTreeView` теперь использует
 * `ReviewMoveList` из `apps/web/src/components/ReviewMoveList.tsx` —
 * тот же inline-PGN-renderer что в мастерской AnalysisPage.
 *
 * Прошлые итерации (KS-3296 плоский DFS-список, KS-3304 nested indented
 * tree) страдали от «лесенки» — главная линия 10+ ходов уезжала за
 * край экрана из-за depth-индентации. Переход на ReviewMoveList даёт:
 *   - inline-flow `1.c4 e6 2.g3 d5 3.Bg2 dxc4 4.Nf3 …` без horizontal
 *     accumulation для главной линии,
 *   - альтернативы в круглых скобках inline,
 *   - готовый scroll-into-view, click-on-move.
 *
 * Поверх ReviewMoveList навешиваем status-покраску через
 * `getMoveExtra` prop (KS-3305): по pathUci.join('|') ищем
 * `OpeningLineProgressDto` и кладём `data-status` + класс
 * `repertoire-move--<status>`. CSS в opening-trainer.css раскрашивает
 * background через эти селекторы (layout-agent сможет добавить).
 *
 * Кликабельность пока чисто визуальная (no-op onMoveClick) —
 * следующий шаг (если потребуется) — навигировать к подмножеству
 * репертуара или к review-сессии конкретной линии.
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  OpeningLineProgressDto,
  OpeningLineStatus,
  OpeningRepertoireDetailDto,
} from '@kingside/shared';
import type { GameMove } from '../../hooks/useChessGame';
import { ReviewMoveList } from '../../components/ReviewMoveList';
import { pathKey, repertoireTreeToGameMoves } from './repertoireTreeAdapter';

interface Props {
  tree: OpeningRepertoireDetailDto['tree'];
  /** Per-line прогресс из GET /repertoires/:id/progress (KS-3292). */
  lines: OpeningLineProgressDto[];
}

const STATUS_COLOR: Record<OpeningLineStatus, string> = {
  mastered: '#22c55e',
  due: '#3b82f6',
  learning: '#eab308',
  wrong: '#ef4444',
  'not-played': '#94a3b8',
};

/**
 * KS-3305. Конвертируем GameMove → pathUci. ReviewMoveList отдаёт нам
 * сам move-объект, но pathUci там нет (это конструкция репертуара).
 * Восстанавливаем путь, идя по `previous` ссылкам, или по позиции в
 * main-history массиве + variation-родителях.
 *
 * Простейшее решение — в адаптере уже знаем pathUci для каждого move
 * (его globalIndex однозначно идентифицирует), поэтому строим
 * Map<globalIndex, pathUci[]> один раз и lookup при `getMoveExtra`.
 */
function buildPathByGlobalIndex(
  moves: GameMove[],
  prefix: string[],
  out: Map<number, string[]>,
): void {
  for (const m of moves) {
    const path = [...prefix, m.uci];
    out.set(m.globalIndex, path);
    for (const variation of m.variations) {
      // Variation начинается с alt-move'а — его prefix совпадает с
      // parent-prefix (тот же ply), потому что variation — альтернатива
      // ходу, а не его продолжение.
      buildPathByGlobalIndex(variation, prefix, out);
    }
    prefix = path;
  }
}

export function RepertoireTreeView({ tree, lines }: Props) {
  const { t } = useTranslation();

  const history: GameMove[] = useMemo(
    () => repertoireTreeToGameMoves(tree, lines),
    [tree, lines],
  );

  const pathsByIdx = useMemo(() => {
    const m = new Map<number, string[]>();
    buildPathByGlobalIndex(history, [], m);
    return m;
  }, [history]);

  const statusByPathKey = useMemo(() => {
    const m = new Map<string, OpeningLineStatus>();
    for (const l of lines) {
      if (l.orphaned) continue;
      m.set(pathKey(l.pathUci), l.status ?? 'not-played');
    }
    return m;
  }, [lines]);

  const getMoveExtra = useCallback(
    (move: GameMove) => {
      const path = pathsByIdx.get(move.globalIndex);
      const status: OpeningLineStatus = path
        ? statusByPathKey.get(pathKey(path)) ?? 'not-played'
        : 'not-played';
      return {
        className: `repertoire-move--${status}`,
        data: {
          'data-status': status,
        },
      };
    },
    [pathsByIdx, statusByPathKey],
  );

  if (history.length === 0) {
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
    <div
      className="opening-trainer-tree"
      data-testid="opening-trainer-tree"
      aria-label={t('openingTrainer.tree.aria', 'Repertoire tree')}
    >
      {/* KS-3305: легенда цветов. Inline-styled до завершения L1
          (KS-3300) — layout-agent навешает финальный дизайн потом. */}
      <div
        className="opening-trainer-tree__legend"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          fontSize: 11,
          opacity: 0.7,
          marginBottom: 8,
        }}
        aria-hidden="true"
      >
        {(Object.keys(STATUS_COLOR) as OpeningLineStatus[]).map((s) => (
          <span
            key={s}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: STATUS_COLOR[s],
              }}
            />
            {t(
              `openingTrainer.tree.status.${s === 'not-played' ? 'notPlayed' : s}`,
              s,
            )}
          </span>
        ))}
      </div>

      <ReviewMoveList
        history={history}
        currentMoveIndex={-1}
        currentMove={null}
        onMoveClick={() => {
          /* read-only — ходы кликабельны но без навигации в M2 */
        }}
        onPromoteVariation={() => {
          /* hideEditor=true — никогда не вызывается */
        }}
        onDeleteVariation={() => {
          /* hideEditor=true — никогда не вызывается */
        }}
        onTruncateRemaining={() => {
          /* hideEditor=true — никогда не вызывается */
        }}
        getMoveExtra={getMoveExtra}
        hideEditor
      />
    </div>
  );
}
