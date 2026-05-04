import { useCallback, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TacticDrillType,
  TacticDrillDto,
  TacticDrillAttemptRequest,
  TacticDrillAttemptResponse,
} from '@kingside/shared';

import { api } from '../api';
import { DrillRunner, type DrillRunnerSubmitInput } from '../components/drills';

/**
 * KS-2233 / KS-2249 — основная страница drill `/drills/:type`.
 *
 * После KS-2249 — обёртка над `<DrillRunner>` (вынесенная state-machine,
 * см. `apps/web/src/components/drills/DrillRunner.tsx`). Сама страница
 * отвечает только за:
 *   - чтение `:type` из URL и валидацию (невалидный → редирект на /drills);
 *   - проводка loader'а на `/tactic-drill/next?type=` и submitter'а на
 *     `/tactic-drill/attempt` с `mode='drill'`;
 *   - бесконечный режим (`count=Infinity` в DrillRunner) — нет finish-step'а.
 *
 * # Контракт DOM
 *
 * Снаружи остаётся стабильный `[data-testid="drill-page"]`-контейнер
 * (для совместимости со старыми e2e). DrillRunner внутри имеет свой
 * testid `drill-runner` — новые тесты привязываются к нему.
 */

// KS-2394: тип `find-mate-in-one-square` удалён из v1 (решение
// пользователя). Прямой переход `/drills/find-mate-in-one-square`
// больше не валиден — `isValidType` вернёт false и DrillPage сделает
// редирект на `/drills`. Когда backend (KS-2393) очистит из shared
// `TacticDrillType` — удалим и упоминания из shared-типов.
const ALL_TYPES: TacticDrillType[] = [
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'count-attackers',
  'find-all-checks',
  'find-undefended-attack',
];

function isValidType(s: string | undefined): s is TacticDrillType {
  return !!s && (ALL_TYPES as string[]).includes(s);
}

export function DrillPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { type } = useParams<{ type: string }>();

  useEffect(() => {
    if (!isValidType(type)) {
      navigate('/drills', { replace: true });
    }
  }, [type, navigate]);

  const drillType = isValidType(type) ? type : null;

  const loadDrill = useCallback(async (): Promise<TacticDrillDto> => {
    if (!drillType) throw new Error('invalid drill type');
    return api.get<TacticDrillDto>(
      `/tactic-drill/next?type=${encodeURIComponent(drillType)}`,
    );
  }, [drillType]);

  const submitAnswer = useCallback(
    async (input: DrillRunnerSubmitInput): Promise<TacticDrillAttemptResponse> => {
      const req: TacticDrillAttemptRequest = {
        drillId: input.drillId,
        userAnswer: input.userAnswer,
        timeMs: input.timeMs,
        mode: 'drill',
      };
      return api.post<TacticDrillAttemptResponse>('/tactic-drill/attempt', req);
    },
    [],
  );

  if (!drillType) {
    // Редирект уже стартанул в useEffect — рендерим пустой stub.
    return (
      <div
        className="drill-page drill-page--loading"
        data-testid="drill-page"
        data-state="loading"
        data-type=""
      >
        <p>{t('drills.loading', 'Loading drills…')}</p>
      </div>
    );
  }

  return (
    <div
      className="drill-page"
      data-testid="drill-page"
      data-type={drillType}
    >
      <DrillRunner
        loadDrill={loadDrill}
        submitAnswer={submitAnswer}
        // Бесконечный sprint-style режим. После каждого drill'а
        // юзер сам нажимает «Next» — DrillRunner подхватит fetchNext.
        count={Infinity}
        headerSlot={
          <header className="drill-page__header">
            <Link
              to="/drills"
              className="drill-page__back"
              data-testid="drill-page-back"
            >
              ← {t('drills.buttons.backToLobby', 'Back to drills')}
            </Link>
          </header>
        }
      />
    </div>
  );
}
