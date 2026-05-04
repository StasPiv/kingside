import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TacticDrillSprintStartRequest,
  TacticDrillSprintStartResponse,
  TacticDrillType,
} from '@kingside/shared';

import { api } from '../api';
import { ApiError } from '../ApiError';

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
  // KS-2350: 409 ConflictException от backend = у пользователя уже
  // активная sprint-сессия. Отдельный режим UI: «Продолжить» / «Начать
  // новый» (последнее — POST с `force=true`, backend сам прервёт старую).
  const [conflict, setConflict] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // KS-2351: страховочный watchdog. axios/fetch таймаут в api.ts
  // должен сработать раньше (15с), но если что-то проскочит мимо
  // (например, кастомный interceptor забыл прокинуть signal) — этот
  // таймер на 20с гарантирует, что UI не повиснет навсегда. При
  // успешном завершении/ошибке он чистится, чтобы не сработать
  // ложно после navigate.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);
  useEffect(() => clearWatchdog, [clearWatchdog]);

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

  // KS-2350: общий вызов POST /sprint/start. force=true → backend
  // прерывает существующую активную сессию (forceFinish + delete) и
  // создаёт новую. Без force и при наличии активной сессии — 409.
  const start = useCallback(
    async (force = false) => {
      if (submitting) return;
      setError(null);
      setResumeError(null);
      setSubmitting(true);
      // KS-2351: watchdog 20с — на случай если api-таймаут (15с) не
      // сработал. Чистим в успешной/ошибочной ветках ниже.
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        setError('timeout');
        setSubmitting(false);
        watchdogRef.current = null;
      }, 20_000);
      try {
        const req: TacticDrillSprintStartRequest & { force?: boolean } = {
          durationMs: duration,
          // Пустой Set трактуется backend как «все 8» — отправляем [].
          types: Array.from(selected),
          ...(force ? { force: true } : {}),
        };
        const resp = await api.post<TacticDrillSprintStartResponse>(
          '/tactic-drill/sprint/start',
          req,
        );
        clearWatchdog();
        setConflict(false);
        navigate('/drills/sprint/play', { state: { session: resp } });
      } catch (e) {
        clearWatchdog();
        // KS-2350: 409 = активная сессия. Показываем выбор «Продолжить /
        // Начать новый», generic-плашку «не удалось» НЕ ставим.
        if (e instanceof ApiError && e.status === 409) {
          setConflict(true);
        } else if (
          // KS-2351: timeout / network — отдельное человеческое
          // сообщение, чтобы пользователь понимал, что это не его 4xx.
          e instanceof ApiError &&
          (e.errorCode === 'REQUEST_TIMEOUT' ||
            e.errorCode === 'NETWORK_ERROR')
        ) {
          setError('timeout');
        } else {
          setError('loadFailed');
        }
        setSubmitting(false);
      }
    },
    [duration, selected, submitting, navigate, clearWatchdog],
  );

  // KS-2350: «Продолжить активный спринт». Backend GET-endpoint для
  // подгрузки активной сессии пока не существует (см. сопровождающий
  // комментарий координатору) — пробуем `/tactic-drill/sprint/active`,
  // если 200 — переходим на PlayPage со state, если 404 — показываем
  // подсказку, что подгрузка пока недоступна, и пользователь может
  // нажать «Начать новый». Когда backend добавит endpoint — этот код
  // продолжит работать без изменений.
  const resume = useCallback(async () => {
    if (submitting) return;
    setResumeError(null);
    setSubmitting(true);
    try {
      const session = await api.get<TacticDrillSprintStartResponse>(
        '/tactic-drill/sprint/active',
      );
      setConflict(false);
      navigate('/drills/sprint/play', { state: { session } });
    } catch (e) {
      // 404 = endpoint ещё не реализован, показываем дружелюбную
      // подсказку. Любая другая — generic. KS-2351: timeout/network
      // → отдельный текст «Сервер не отвечает».
      if (e instanceof ApiError && e.status === 404) {
        setResumeError('notSupported');
      } else if (
        e instanceof ApiError &&
        (e.errorCode === 'REQUEST_TIMEOUT' || e.errorCode === 'NETWORK_ERROR')
      ) {
        setResumeError('timeout');
      } else {
        setResumeError('loadFailed');
      }
      setSubmitting(false);
    }
  }, [submitting, navigate]);

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
          data-error={error}
          role="alert"
        >
          {error === 'timeout'
            ? t(
                'drills.sprint.setup.timeoutFailed',
                'Server did not respond. Please try again.',
              )
            : t('drills.sprint.setup.loadFailed', 'Could not start sprint.')}
        </div>
      )}

      {/* KS-2350: 409 → диалог выбора «Продолжить / Начать новый».
          Replaces the regular Start button to не плодить лишние состояния. */}
      {conflict ? (
        <div
          className="drill-sprint-setup__conflict"
          data-testid="drill-sprint-setup-conflict"
          role="alert"
        >
          <p className="drill-sprint-setup__conflict-message">
            {t(
              'drills.sprint.setup.conflictMessage',
              'You already have an active sprint. Resume it or start a new one — the previous run will be ended.',
            )}
          </p>
          <div className="drill-sprint-setup__conflict-actions">
            <button
              type="button"
              className="drill-sprint-setup__resume"
              data-testid="drill-sprint-setup-resume"
              disabled={submitting}
              onClick={() => void resume()}
            >
              {t('drills.sprint.setup.resume', 'Resume sprint')}
            </button>
            <button
              type="button"
              className="drill-sprint-setup__force-start"
              data-testid="drill-sprint-setup-force-start"
              disabled={submitting}
              onClick={() => void start(true)}
            >
              {t('drills.sprint.setup.forceStart', 'Start a new one')}
            </button>
            <button
              type="button"
              className="drill-sprint-setup__cancel"
              data-testid="drill-sprint-setup-cancel"
              disabled={submitting}
              onClick={() => {
                setConflict(false);
                setResumeError(null);
              }}
            >
              {t('drills.sprint.setup.cancel', 'Cancel')}
            </button>
          </div>
          {resumeError && (
            <div
              className="drill-sprint-setup__conflict-hint"
              data-testid="drill-sprint-setup-resume-error"
              data-resume-error={resumeError}
            >
              {resumeError === 'notSupported'
                ? t(
                    'drills.sprint.setup.resumeNotSupported',
                    'Resuming an active sprint is not supported yet. Use “Start a new one” instead.',
                  )
                : resumeError === 'timeout'
                  ? t(
                      'drills.sprint.setup.timeoutFailed',
                      'Server did not respond. Please try again.',
                    )
                  : t(
                      'drills.sprint.setup.loadFailed',
                      'Could not start sprint.',
                    )}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="drill-sprint-setup__start"
          data-testid="drill-sprint-setup-start"
          disabled={submitting}
          onClick={() => void start()}
        >
          {t('drills.sprint.setup.start', 'Start sprint')}
        </button>
      )}
    </div>
  );
}
