import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { GuessSide } from '@kingside/shared';

import { GuessSessionRunner } from '../components/guess';

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
 * KS-3498 (ADR-091 F1) — state, который может прийти на /guess:
 *   - `pgn`/`side`/`title` — старый путь (открытие из ArchiveGamePage
 *     одной партии или ручной переход с PGN);
 *   - `archiveGameId` + `pgn`/`white`/`black`/`event` — новый путь
 *     «выбрать из архива» (KS-3499 F2). Если есть `archiveGameId`,
 *     submit идёт с `gameSource='archive'`, иначе `pgn`.
 */
interface GuessLandingState {
  pgn?: string;
  side?: GuessSide;
  title?: string;
  archiveGameId?: string;
  white?: string;
  black?: string;
  event?: string;
}

const ARCHIVE_RETURN_TO = '/guess';

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

export function GuessLandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const initial = (location.state as GuessLandingState | null) ?? null;

  const [pgn, setPgn] = useState<string>(initial?.pgn ?? '');
  const [side, setSide] = useState<GuessSide>(initial?.side ?? 'white');
  const [started, setStarted] = useState(false);
  // KS-3498: «выбран из архива» — превью + сохранение id для submit.
  // Если пользователь вручную правит PGN после возврата из архива,
  // мы НЕ сбрасываем archiveGameId (на стороне backend gameRef важнее
  // pgn для gameSource='archive', а pgn используется только для рендера
  // textarea и UI-валидации). Сбрасывается только кнопкой «Изменить
  // выбор» (она снова уводит в /archive) — после reset очистим.
  const [archiveGameId, setArchiveGameId] = useState<string | null>(
    initial?.archiveGameId ?? null,
  );
  const [archivePreview, setArchivePreview] = useState<
    Pick<GuessLandingState, 'white' | 'black' | 'event'> | null
  >(
    initial?.archiveGameId
      ? {
          white: initial.white,
          black: initial.black,
          event: initial.event,
        }
      : null,
  );

  const pgnValid = useMemo(() => isPlayablePgn(pgn), [pgn]);

  const goPickFromArchive = useCallback(() => {
    navigate('/archive', {
      state: {
        returnTo: ARCHIVE_RETURN_TO,
        returnLabel: t('guess.setup.title', 'Guess the move'),
      },
    });
  }, [navigate, t]);

  const clearArchivePick = useCallback(() => {
    setArchiveGameId(null);
    setArchivePreview(null);
  }, []);

  // KS-3498: при выбранной из архива партии локальная PGN-валидация
  // не блокирует Start — backend подтянет PGN по `gameRef`.
  const canStart = pgnValid || archiveGameId !== null;

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
          gameSource={archiveGameId ? 'archive' : 'pgn'}
          gameRef={archiveGameId}
        />
      </div>
    );
  }

  return (
    <div className="guess-page" data-testid="guess-page" data-state="setup">
      <h1>{t('guess.setup.title', 'Guess the move')}</h1>
      <p className="guess-page__intro">
        {t(
          'guess.setup.intro',
          'Play through a real game and try to guess the moves of one side. Each guess is compared to what was actually played.',
        )}
      </p>

      {/* KS-3498 F1: выбор партии из архива. Превью + «Изменить» —
          когда archiveGameId уже выбран; кнопка-вход — когда нет. */}
      {archivePreview && archiveGameId ? (
        <div
          className="guess-page__archive-preview"
          data-testid="guess-archive-preview"
          data-archive-id={archiveGameId}
        >
          <span
            className="guess-page__archive-preview-label"
            data-testid="guess-archive-preview-label"
          >
            {t('guess.setup.archivePreviewLabel', 'Selected game')}
          </span>
          <span
            className="guess-page__archive-preview-main"
            data-testid="guess-archive-preview-main"
          >
            {t('guess.setup.archivePreview', '{{white}} vs {{black}}', {
              white: archivePreview.white ?? '—',
              black: archivePreview.black ?? '—',
            })}
          </span>
          {archivePreview.event && (
            <span
              className="guess-page__archive-preview-event"
              data-testid="guess-archive-preview-event"
            >
              {t('guess.setup.archivePreviewEvent', '{{event}}', {
                event: archivePreview.event,
              })}
            </span>
          )}
          <button
            type="button"
            className="guess-page__archive-change"
            data-testid="guess-archive-change"
            onClick={() => {
              clearArchivePick();
              goPickFromArchive();
            }}
          >
            {t('guess.setup.changePick', 'Change selection')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="guess-page__archive-pick"
          data-testid="guess-archive-pick"
          onClick={goPickFromArchive}
        >
          {t('guess.setup.pickFromArchive', '🔍 Pick from archive →')}
        </button>
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
