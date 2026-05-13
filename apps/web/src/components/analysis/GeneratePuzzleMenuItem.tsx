import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { api } from '../../api';
import {
  generatePuzzlesFromPgn,
  DEFAULT_PUZZLE_GEN_SETTINGS,
  type GeneratedPuzzleData,
} from '../../utils/puzzleGenerator';
import type { BrowsePuzzleDto } from '../../hooks/useInfinitePuzzles';

/**
 * KS-2958: пункт overflow-меню «Сгенерировать пазл» прямо из окна анализа.
 *
 * Использует тот же путь, что и precision-генератор (`puzzleGenerator.ts`,
 * см. KS-2955): SF18 WASM с дефолтными параметрами `DEFAULT_PUZZLE_GEN_SETTINGS`
 * (depth=18 + movetime=1000) — gen-time и run-time оценка выровнены, нет
 * расхождений между генерацией и последующей игрой.
 *
 * Шаги:
 *   1. `generatePuzzlesFromPgn(pgn)` → массив `GeneratedPuzzleData[]`.
 *   2. Если пусто — toast «нет подходящих позиций», пункт остаётся активным.
 *   3. POST `/puzzles/batch { puzzles }` — backend сохраняет как `is_public=false`
 *      (см. `GeneratedPuzzleData.isPublic: false`). `/puzzles/batch` возвращает
 *      только `{ count }`, без id'ов — поэтому...
 *   4. GET `/puzzles/browse?mine=true&visibility=draft&source=precision&limit=20`
 *      → ищем созданный draft по `fen` первого сгенерированного пазла.
 *   5. Найден id — navigate `/puzzle/<id>?source=precision&mine=true&visibility=draft`.
 *      Не найден (теоретически race с другим тэбом) — fallback на список
 *      `/precision?mine=true&visibility=draft`.
 *
 * Видимость пункта (kind === 'analysis' | 'review') решается на стороне
 * AnalysisPage — компонент не знает про kind. Для kind === 'study' | 'puzzle'
 * родитель просто не рендерит этот пункт.
 */
export interface GeneratePuzzleMenuItemProps {
  /** Текущий PGN партии (см. `buildAnalysisPgn` в AnalysisPage). */
  getPgn: () => string | null;
  /** Закрыть overflow-меню после клика. */
  onClose: () => void;
  /** Disabled извне (например, history.length === 0). */
  disabled?: boolean;
}

type State = 'idle' | 'generating' | 'saving' | 'error' | 'success';

export function GeneratePuzzleMenuItem({
  getPgn,
  onClose,
  disabled = false,
}: GeneratePuzzleMenuItemProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    if (state === 'generating' || state === 'saving') return;
    const pgn = getPgn();
    if (!pgn) {
      setErrorMsg(
        t(
          'analysis.generatePuzzleEmptyPgn',
          'Open or play a game first — there is no PGN to generate a puzzle from.',
        ),
      );
      setState('error');
      return;
    }

    setState('generating');
    setErrorMsg(null);
    let puzzles: GeneratedPuzzleData[];
    try {
      puzzles = await generatePuzzlesFromPgn(pgn, () => {
        // Inline-прогресс в menu-item не показываем (overflow-меню узкое);
        // на длинных партиях SF18 WASM работает ~минуту — UX-приемлемо
        // с дизейблом + статус-текстом «Генерация…».
      }, { ...DEFAULT_PUZZLE_GEN_SETTINGS });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err) || 'generate-failed';
      console.error('[GeneratePuzzle] generation failed:', err);
      setErrorMsg(
        t(
          'analysis.generatePuzzleError',
          'Could not generate puzzle: {{msg}}',
          { msg },
        ),
      );
      setState('error');
      return;
    }

    if (puzzles.length === 0) {
      setErrorMsg(
        t(
          'analysis.generatePuzzleEmpty',
          'No suitable positions for a puzzle in this game.',
        ),
      );
      setState('error');
      return;
    }

    setState('saving');
    try {
      await api.post('/puzzles/batch', { puzzles });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err) || 'save-failed';
      console.error('[GeneratePuzzle] save failed:', err);
      setErrorMsg(
        t(
          'analysis.generatePuzzleSaveError',
          'Generated, but failed to save: {{msg}}',
          { msg },
        ),
      );
      setState('error');
      return;
    }

    // KS-2958: `/puzzles/batch` не возвращает id'ы (см. `BatchPuzzlesResponse`
    // в shared) — после сохранения тянем последние свои draft'ы и ищем
    // только что созданный по fen первого сгенерированного пазла.
    const firstFen = puzzles[0].fen;
    try {
      const browse = await api.get<{ data: BrowsePuzzleDto[] }>(
        '/puzzles/browse?mine=true&visibility=draft&source=precision&limit=20',
      );
      const match = browse.data?.find((p) => p.fen === firstFen);
      onClose();
      if (match) {
        navigate(
          `/puzzle/${match.id}?source=precision&mine=true&visibility=draft`,
        );
      } else {
        // Race / backend-фильтр не подхватил новый draft — fallback на
        // список drafts, юзер сам кликнет.
        navigate('/precision?mine=true&visibility=draft');
      }
      setState('success');
    } catch (err) {
      console.error('[GeneratePuzzle] browse failed:', err);
      // Пазл уже сохранён — переводим на список, чтобы юзер его нашёл.
      onClose();
      navigate('/precision?mine=true&visibility=draft');
      setState('success');
    }
  }, [state, getPgn, t, onClose, navigate]);

  const isBusy = state === 'generating' || state === 'saving';
  const label =
    state === 'generating'
      ? t('analysis.generatingPuzzle', 'Generating…')
      : state === 'saving'
        ? t('analysis.savingPuzzle', 'Saving…')
        : t('analysis.generatePuzzle', 'Generate puzzle');

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || isBusy}
        data-testid="analysis-generate-puzzle"
        data-state={state}
      >
        {label}
      </button>
      {state === 'error' && errorMsg && (
        <p
          className="analysis-generate-puzzle__error"
          role="alert"
          data-testid="analysis-generate-puzzle-error"
        >
          {errorMsg}
        </p>
      )}
    </>
  );
}
