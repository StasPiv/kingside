import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TacticDrillSprintStartRequest,
  TacticDrillSprintStartResponse,
  TacticDrillType,
} from '@kingside/shared';

import { api } from '../api';

/**
 * KS-2241 (ADR-035 §5.5, Drills E4) — setup-страница sprint-режима.
 * Аналог `PuzzleRushPage` экрана `start`, но в виде отдельного route.
 *
 * Пользователь выбирает:
 *   - подмножество drill-типов (multi-select из 8) — пустой массив на
 *     backend = «все 8 типов» (методика §2.1);
 *   - длительность 3 мин (180000ms) или 5 мин (300000ms).
 *
 * Submit «Начать спринт» → POST /tactic-drill/sprint/start. На успех —
 * navigate в `/drills/sprint/play` через `state` с результатом
 * (sessionId + первый drill + durationMs + startedAt). PlayPage сам
 * подхватит state и не делает повторный /start.
 *
 * # Контракт DOM
 *
 *   <div class="drill-sprint-setup" data-testid="drill-sprint-setup">
 *     <h1>…</h1>
 *     <fieldset class="drill-sprint-setup__duration"
 *               data-testid="drill-sprint-setup-duration">
 *       <label><input type="radio" value="180000"></label> …
 *     </fieldset>
 *     <fieldset class="drill-sprint-setup__types"
 *               data-testid="drill-sprint-setup-types">
 *       <label><input type="checkbox" value="<id>"></label> …
 *     </fieldset>
 *     <button data-testid="drill-sprint-setup-select-all">…</button>
 *     <button data-testid="drill-sprint-setup-clear">…</button>
 *     <button data-testid="drill-sprint-setup-start"
 *             disabled?>…</button>
 *   </div>
 */

const ALL_TYPES: TacticDrillType[] = [
  'count-attackers',
  'find-loose-piece',
  'find-hanging-piece',
  'find-all-checks',
  'find-pin',
  'find-fork',
  'find-mate-in-one-square',
  'find-undefended-attack',
];

type DurationMs = 180000 | 300000;

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function DrillSprintSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [duration, setDuration] = useState<DurationMs>(180000);
  const [selected, setSelected] = useState<Set<TacticDrillType>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleType = useCallback((type: TacticDrillType) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(ALL_TYPES));
  }, []);

  const clearAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const start = useCallback(async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const req: TacticDrillSprintStartRequest = {
        durationMs: duration,
        // Пустой Set трактуется backend как «все 8» — отправляем [].
        types: Array.from(selected),
      };
      const resp = await api.post<TacticDrillSprintStartResponse>(
        '/tactic-drill/sprint/start',
        req,
      );
      navigate('/drills/sprint/play', { state: { session: resp } });
    } catch {
      setError('loadFailed');
      setSubmitting(false);
    }
  }, [duration, selected, submitting, navigate]);

  return (
    <div className="drill-sprint-setup" data-testid="drill-sprint-setup">
      <header className="drill-sprint-setup__header">
        <h1 className="drill-sprint-setup__title">
          {t('drills.sprint.setup.heading', 'Sprint setup')}
        </h1>
        <p className="drill-sprint-setup__subtitle">
          {t(
            'drills.sprint.setup.subheading',
            'Pick drill types and a duration. Solve as many as you can.',
          )}
        </p>
      </header>

      <fieldset
        className="drill-sprint-setup__duration"
        data-testid="drill-sprint-setup-duration"
      >
        <legend>{t('drills.sprint.setup.duration', 'Duration')}</legend>
        {([180000, 300000] as DurationMs[]).map((d) => (
          <label key={d} className="drill-sprint-setup__duration-option">
            <input
              type="radio"
              name="drill-sprint-duration"
              value={d}
              checked={duration === d}
              onChange={() => setDuration(d)}
              data-testid={`drill-sprint-setup-duration-${d}`}
            />{' '}
            {d === 180000
              ? t('drills.sprint.setup.duration3min', '3 minutes')
              : t('drills.sprint.setup.duration5min', '5 minutes')}
          </label>
        ))}
      </fieldset>

      <fieldset
        className="drill-sprint-setup__types"
        data-testid="drill-sprint-setup-types"
        data-selected-count={selected.size}
      >
        <legend>{t('drills.sprint.setup.types', 'Drill types')}</legend>
        <div className="drill-sprint-setup__types-actions">
          <button
            type="button"
            data-testid="drill-sprint-setup-select-all"
            onClick={selectAll}
          >
            {t('drills.sprint.setup.selectAll', 'All types')}
          </button>
          <button
            type="button"
            data-testid="drill-sprint-setup-clear"
            onClick={clearAll}
            disabled={selected.size === 0}
          >
            {t('drills.sprint.setup.clearTypes', 'Clear')}
          </button>
        </div>
        <div className="drill-sprint-setup__types-grid">
          {ALL_TYPES.map((type) => {
            const camel = kebabToCamel(type);
            const checked = selected.has(type);
            return (
              <label
                key={type}
                className={`drill-sprint-setup__type-option${
                  checked ? ' drill-sprint-setup__type-option--checked' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleType(type)}
                  data-testid={`drill-sprint-setup-type-${type}`}
                />{' '}
                {t(`drills.types.${camel}`)}
              </label>
            );
          })}
        </div>
      </fieldset>

      {error && (
        <div
          className="drill-sprint-setup__error"
          data-testid="drill-sprint-setup-error"
          role="alert"
        >
          {t('drills.sprint.setup.loadFailed', 'Could not start sprint.')}
        </div>
      )}

      <button
        type="button"
        className="drill-sprint-setup__start"
        data-testid="drill-sprint-setup-start"
        disabled={submitting}
        onClick={() => void start()}
      >
        {t('drills.sprint.setup.start', 'Start sprint')}
      </button>
    </div>
  );
}
