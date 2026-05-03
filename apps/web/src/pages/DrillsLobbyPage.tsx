import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TacticDrillType,
  TacticDrillSkillLayer,
  AnswerShape,
} from '@kingside/shared';

import { api } from '../api';
import { DrillTypeCard } from '../components/drills';

/**
 * KS-2232 (ADR-035 §7, E3) — лобби тренажёров `/drills`.
 *
 * Загружает каталог из `GET /tactic-drill/types`, группирует drill-типы
 * по навыковому слою (overview / pattern / calculation — methodology §2)
 * и рендерит сетку `<DrillTypeCard>`. Клик по карточке ведёт на
 * `/drills/<drillType>` (страница drill'а — KS-2233, не входит в этот
 * commit). Заблокированные типы (`unlocked=false`) показываются
 * disabled с бейджем `drills.lobby.lockedHint` — переход недоступен.
 *
 * # Контракт ответа /tactic-drill/types
 *
 *   { types: [{ id, layer, answerShape, promptKey, unlocked }, …] }
 *
 * `id` приходит kebab-case (`find-hanging-piece`), а ключи i18n —
 * camelCase (`findHangingPiece`); локальный `kebabToCamel` разруливает
 * без расширения shared'а.
 *
 * # Контракт DOM
 *
 *   <div class="drills-lobby" data-testid="drills-lobby">
 *     <header class="drills-lobby__header">…</header>
 *     <section class="drills-lobby__layer drills-lobby__layer--<layer>"
 *              data-layer="<layer>">
 *       <h2 class="drills-lobby__layer-title">…</h2>
 *       <div class="drills-lobby__grid">
 *         <DrillTypeCard … />
 *         …
 *       </div>
 *     </section>
 *     …
 *   </div>
 *
 * Гейтинг через `useFeatureFlag('drillsEnabled')` живёт в App.tsx —
 * сама страница его не проверяет, чтобы тесты страницы не зависели
 * от FeatureFlagsContext.
 */

interface TacticDrillTypeListItem {
  id: TacticDrillType;
  layer: TacticDrillSkillLayer;
  answerShape: AnswerShape;
  promptKey: string;
  unlocked: boolean;
}

interface TacticDrillTypesResponse {
  types: TacticDrillTypeListItem[];
}

const LAYER_ORDER: TacticDrillSkillLayer[] = [
  'overview',
  'pattern',
  'calculation',
];

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function DrillsLobbyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [types, setTypes] = useState<TacticDrillTypeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<TacticDrillTypesResponse>('/tactic-drill/types')
      .then((r) => {
        if (!cancelled) setTypes(r.types);
      })
      .catch(() => {
        if (!cancelled) setError('loadFailed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byLayer = useMemo(() => {
    if (!types) return null;
    const out: Record<TacticDrillSkillLayer, TacticDrillTypeListItem[]> = {
      overview: [],
      pattern: [],
      calculation: [],
    };
    for (const item of types) out[item.layer].push(item);
    return out;
  }, [types]);

  if (error) {
    return (
      <div
        className="drills-lobby drills-lobby--error"
        data-testid="drills-lobby-error"
      >
        {t('drills.errors.loadFailed', 'Could not load drills.')}
      </div>
    );
  }
  if (!types || !byLayer) {
    return (
      <div
        className="drills-lobby drills-lobby--loading"
        data-testid="drills-lobby-loading"
      >
        {t('drills.loading', 'Loading drills…')}
      </div>
    );
  }

  return (
    <div className="drills-lobby" data-testid="drills-lobby">
      <header className="drills-lobby__header">
        <h1 className="drills-lobby__title">
          {t('drills.lobbyHeading', 'Pick a drill')}
        </h1>
        <p className="drills-lobby__subtitle">
          {t(
            'drills.lobbySubheading',
            'Short pattern-recognition exercises. One position — one question.',
          )}
        </p>
      </header>
      {LAYER_ORDER.map((layer) => {
        const items = byLayer[layer];
        if (items.length === 0) return null;
        return (
          <section
            key={layer}
            className={`drills-lobby__layer drills-lobby__layer--${layer}`}
            data-layer={layer}
            data-testid={`drills-lobby-layer-${layer}`}
          >
            <h2 className="drills-lobby__layer-title">
              {t(`drills.layers.${layer}`)}
            </h2>
            <div className="drills-lobby__grid">
              {items.map((item) => {
                const key = kebabToCamel(item.id);
                const title = t(`drills.types.${key}`);
                const description = t(`drills.typeDescriptions.${key}`);
                return (
                  <DrillTypeCard
                    key={item.id}
                    title={title}
                    description={description}
                    disabled={!item.unlocked}
                    badge={
                      !item.unlocked
                        ? t('drills.lobby.lockedHint', 'Locked')
                        : undefined
                    }
                    onClick={() => navigate(`/drills/${item.id}`)}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
