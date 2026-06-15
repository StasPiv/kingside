import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { GuessGameSource, GuessSide } from '@kingside/shared';

import { GuessSessionRunner } from '../components/guess';
import { GuessSubNav } from '../components/guess/GuessSubNav';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';

/**
 * KS-3412 (ADR-086 §9, F3) — точка входа «угадай ход».
 *
 * Маршрут `/guess`. Источник партии: PGN (вставка вручную или передан из
 * ArchiveGamePage через `location.state.pgn`) + выбор стороны, ходы которой
 * угадываем. По «Начать» — рендерим `<GuessRunner>` (F1).
 *
 * F2 (KS-3411) подключит сюда сессию (start/move/finish) + финал-экран;
 * пока — локальный прогон без бэкенд-сессии. Точка входа скрыта в проде
 * (гейт `GUESS_ENTRY_ENABLED`, см. config/guessFeature).
 */

/**
 * KS-3503 (ADR-092 F1-ext) — унифицированный shape `location.state`:
 *
 *   { source: 'archive'|'own'; refId: string; pgn: string;
 *     title?: string; white?: string; black?: string; event?: string }
 *
 * `source` решает, какой gameSource уйдёт на /guess/sessions backend'у:
 *   - 'archive' → партия из общего архива (ADR-091 F2, KS-3499);
 *   - 'own'     → пользовательский анализ из мастерской (ADR-092 F2, KS-3504).
 *
 * Обратная совместимость (legacy state, до KS-3503):
 *   - `pgn`/`side`/`title` — ручной переход с PGN (открытие из
 *     ArchiveGamePage конкретной партии);
 *   - `archiveGameId` — старое имя поля от KS-3499. Если приходит —
 *     нормализуем в `source='archive'` + `refId=archiveGameId`.
 */
interface GuessLandingState {
  pgn?: string;
  side?: GuessSide;
  title?: string;
  // KS-3503: новые унифицированные поля.
  source?: 'archive' | 'own';
  refId?: string;
  white?: string;
  black?: string;
  event?: string;
  // KS-3498/3499 legacy alias, мапится в source='archive'/refId.
  archiveGameId?: string;
}

const GUESS_RETURN_TO = '/guess';

function isPlayablePgn(pgn: string): boolean {
  if (!pgn || pgn.trim().length === 0) return false;
  try {
    const g = new Chess();
    g.loadPgn(pgn);
    return g.history().length > 0;
  } catch {
    return false;
  }
}

/**
 * KS-3503: нормализация incoming state в унифицированный shape.
 * legacy `archiveGameId` → `source='archive'` + `refId=archiveGameId`.
 * Если ничего из этого нет — возвращаем null (PGN-режим).
 */
interface PickPreview {
  source: 'archive' | 'own';
  refId: string;
  title?: string;
  white?: string;
  black?: string;
  event?: string;
}

function normalizePickFromState(
  s: GuessLandingState | null,
): PickPreview | null {
  if (!s) return null;
  if (s.source && s.refId) {
    return {
      source: s.source,
      refId: s.refId,
      title: s.title,
      white: s.white,
      black: s.black,
      event: s.event,
    };
  }
  // Legacy alias (KS-3498/3499): archiveGameId без source.
  if (s.archiveGameId) {
    return {
      source: 'archive',
      refId: s.archiveGameId,
      title: s.title,
      white: s.white,
      black: s.black,
      event: s.event,
    };
  }
  return null;
}

export function GuessLandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const isGuest = !user;
  const initial = (location.state as GuessLandingState | null) ?? null;

  const [pgn, setPgn] = useState<string>(initial?.pgn ?? '');
  const [side, setSide] = useState<GuessSide>(initial?.side ?? 'white');
  const [started, setStarted] = useState(false);
  // KS-3503: выбранная партия — унифицированный shape. Любой из двух
  // флоу (архив/мастерская) приводит сюда. Сброс — только кнопкой
  // «Change selection» (которая уводит обратно в источник).
  const [pick, setPick] = useState<PickPreview | null>(() =>
    normalizePickFromState(initial),
  );

  const pgnValid = useMemo(() => isPlayablePgn(pgn), [pgn]);

  const returnLabel = t('guess.setup.title', 'Guess the move');

  const goPickFromArchive = useCallback(() => {
    navigate('/archive', {
      state: { returnTo: GUESS_RETURN_TO, returnLabel },
    });
  }, [navigate, returnLabel]);

  const goPickFromWorkshop = useCallback(() => {
    if (isGuest) return;
    navigate('/workshop', {
      state: { returnTo: GUESS_RETURN_TO, returnLabel },
    });
  }, [navigate, returnLabel, isGuest]);

  const clearPick = useCallback(() => {
    setPick(null);
  }, []);

  // При выбранной из архива/мастерской партии локальная PGN-валидация
  // не блокирует Start — backend подтянет PGN по `gameRef`.
  const canStart = pgnValid || pick !== null;

  const handleStart = useCallback(() => {
    if (canStart) setStarted(true);
  }, [canStart]);

  const handleBackToSetup = useCallback(() => {
    setStarted(false);
  }, []);

  if (started) {
    return (
      <div className="guess-page" data-testid="guess-page" data-state="playing">
        <div className="guess-page__header">
          <button
            type="button"
            className="guess-page__back"
            data-testid="guess-page-back"
            onClick={handleBackToSetup}
          >
            ← {t('guess.setup.back', 'New game')}
          </button>
          {initial?.title && (
            <span className="guess-page__title" data-testid="guess-page-title">
              {initial.title}
            </span>
          )}
        </div>
        <GuessSessionRunner
          pgn={pgn}
          side={side}
          gameSource={
            pick ? (pick.source as GuessGameSource) : 'pgn'
          }
          gameRef={pick?.refId ?? null}
        />
      </div>
    );
  }

  return (
    <div className="guess-page" data-testid="guess-page" data-state="setup">
      <PageSeo ns="guess.list" path="/guess" />
      {/* KS-3510: общая sub-nav (Training / Progress / History). */}
      <GuessSubNav />
      <h1>{t('guess.setup.title', 'Guess the move')}</h1>
      <p className="guess-page__intro">
        {t(
          'guess.setup.intro',
          'Play through a real game and try to guess the moves of one side. Each guess is compared to what was actually played.',
        )}
      </p>

      {/* KS-3503 F1-ext: унифицированный выбор партии — мастерская
          ИЛИ архив. Своё (workshop) перед чужим (archive) — UX-логика
          «сначала смотри свои анализы, потом общую базу». Гостю
          мастерская disabled с подсказкой (требует логина для
          доступа к собственным анализам). */}
      {pick ? (
        <div
          className="guess-page__pick-preview"
          data-testid="guess-pick-preview"
          data-source={pick.source}
          data-ref-id={pick.refId}
        >
          <span
            className="guess-page__pick-preview-label"
            data-testid="guess-pick-preview-label"
          >
            {pick.source === 'own'
              ? t(
                  'guess.setup.ownPreviewLabel',
                  '📂 From workshop',
                )
              : t(
                  'guess.setup.archivePreviewLabel2',
                  '🔍 From archive',
                )}
          </span>
          <span
            className="guess-page__pick-preview-main"
            data-testid="guess-pick-preview-main"
          >
            {pick.source === 'own'
              ? (pick.title ?? '—')
              : t('guess.setup.archivePreview', '{{white}} vs {{black}}', {
                  white: pick.white ?? '—',
                  black: pick.black ?? '—',
                })}
          </span>
          {pick.source === 'archive' && pick.event && (
            <span
              className="guess-page__pick-preview-event"
              data-testid="guess-pick-preview-event"
            >
              {t('guess.setup.archivePreviewEvent', '{{event}}', {
                event: pick.event,
              })}
            </span>
          )}
          <button
            type="button"
            className="guess-page__pick-change"
            data-testid="guess-pick-change"
            onClick={() => {
              const goBack =
                pick.source === 'own' ? goPickFromWorkshop : goPickFromArchive;
              clearPick();
              goBack();
            }}
          >
            {t('guess.setup.changePick', 'Change selection')}
          </button>
        </div>
      ) : (
        <div
          className="guess-page__pick-buttons"
          data-testid="guess-pick-buttons"
        >
          {/* KS-3503: мастерская перед архивом (своё → чужое). */}
          <button
            type="button"
            className="guess-page__workshop-pick"
            data-testid="guess-workshop-pick"
            disabled={isGuest}
            aria-disabled={isGuest}
            title={
              isGuest
                ? t(
                    'guess.setup.workshopGuestHint',
                    'Sign in to access your own analyses',
                  )
                : ''
            }
            onClick={goPickFromWorkshop}
          >
            {t('guess.setup.pickFromWorkshop', '📂 Pick from workshop →')}
          </button>
          <button
            type="button"
            className="guess-page__archive-pick"
            data-testid="guess-archive-pick"
            onClick={goPickFromArchive}
          >
            {t('guess.setup.pickFromArchive', '🔍 Pick from archive →')}
          </button>
        </div>
      )}

      <label className="guess-page__label" htmlFor="guess-pgn">
        {t('guess.setup.pgnLabel', 'Game PGN')}
      </label>
      <textarea
        id="guess-pgn"
        className="guess-page__pgn"
        data-testid="guess-pgn-input"
        rows={8}
        value={pgn}
        onChange={(e) => setPgn(e.target.value)}
        placeholder={t('guess.setup.pgnPlaceholder', 'Paste a PGN here…')}
      />

      <div className="guess-page__side" data-testid="guess-side-picker">
        <span className="guess-page__side-label">
          {t('guess.setup.sideLabel', 'Guess for')}
        </span>
        <button
          type="button"
          className={`guess-page__side-btn${side === 'white' ? ' guess-page__side-btn--active' : ''}`}
          data-testid="guess-side-white"
          aria-pressed={side === 'white'}
          onClick={() => setSide('white')}
        >
          {t('guess.setup.white', 'White')}
        </button>
        <button
          type="button"
          className={`guess-page__side-btn${side === 'black' ? ' guess-page__side-btn--active' : ''}`}
          data-testid="guess-side-black"
          aria-pressed={side === 'black'}
          onClick={() => setSide('black')}
        >
          {t('guess.setup.black', 'Black')}
        </button>
      </div>

      {!pgnValid && pgn.trim().length > 0 && (
        <p className="guess-page__error" data-testid="guess-pgn-error">
          {t('guess.setup.invalidPgn', 'Could not read this PGN. Check the moves and try again.')}
        </p>
      )}

      <div className="guess-page__actions">
        <button
          type="button"
          className="play-btn"
          data-testid="guess-start"
          disabled={!canStart}
          onClick={handleStart}
        >
          {t('guess.setup.start', 'Start')}
        </button>
        <button
          type="button"
          className="play-btn play-btn--secondary"
          data-testid="guess-cancel"
          onClick={() => navigate(-1)}
        >
          {t('common.cancel', 'Cancel')}
        </button>
      </div>
    </div>
  );
}
