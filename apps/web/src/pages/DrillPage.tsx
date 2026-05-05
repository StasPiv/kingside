import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TacticDrillType,
  TacticDrillDto,
  TacticDrillAttemptRequest,
  TacticDrillAttemptResponse,
} from '@kingside/shared';

import { api } from '../api';
import { DrillRunner, DrillTypeInfoModal, type DrillRunnerSubmitInput } from '../components/drills';
import {
  hasSeenDrillOnboarding,
  markDrillOnboardingSeen,
} from '../utils/drillOnboarding';

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
 * KS-2418: страница также управляет:
 *   - первым автопоказом онбординг-модала (короткое объяснение типа);
 *   - кнопкой «?» в шапке drill — открывает help-модал с расширенным
 *     описанием. Help/онбординг — единый компонент DrillTypeInfoModal
 *     с разными `variant`.
 *
 * # Контракт DOM
 *
 * Снаружи остаётся стабильный `[data-testid="drill-page"]`-контейнер
 * (для совместимости со старыми e2e). DrillRunner внутри имеет свой
 * testid `drill-runner` — новые тесты привязываются к нему.
 */

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

type ModalState = { variant: 'onboarding' | 'help' } | null;

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

  // KS-2418: модал онбординга/help. На первом рендере страницы при
  // валидном drill-типе — если онбординг ещё не видели, показываем
  // его автоматически. Help-модал (через «?») открывается вручную.
  const [modal, setModal] = useState<ModalState>(null);

  useEffect(() => {
    if (!drillType) return;
    if (!hasSeenDrillOnboarding(drillType)) {
      setModal({ variant: 'onboarding' });
    }
  }, [drillType]);

  const handleHelpClick = useCallback(() => {
    setModal({ variant: 'help' });
  }, []);

  const handleModalClose = useCallback(() => {
    if (drillType && modal?.variant === 'onboarding') {
      markDrillOnboardingSeen(drillType);
    }
    setModal(null);
  }, [drillType, modal]);

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
            {/* KS-2418: кнопка «?» — открывает help-модал с описанием
                текущего drill-типа. Не на весь экран; sprint-таймер не
                страдает (мы здесь не в sprint'е, но контракт держим). */}
            <button
              type="button"
              className="drill-page__help"
              data-testid="drill-page-help"
              aria-label={t(
                'drills.runner.helpAriaLabel',
                'Open drill description',
              )}
              title={t('drills.runner.help', "What's this drill?")}
              onClick={handleHelpClick}
            >
              ?
            </button>
          </header>
        }
      />
      {modal && (
        <DrillTypeInfoModal
          drillType={drillType}
          variant={modal.variant}
          onClose={handleModalClose}
        />
      )}
    </div>
  );
}
