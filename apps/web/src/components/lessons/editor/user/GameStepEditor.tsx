import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  AnalysisListItem,
  GameStepMeta,
  GameStepPayload,
} from '@kingside/shared';

import { api } from '../../../../api';

/**
 * KS-3181 / ADR-072 §7 F1 — редактор шага «Партия» для пользовательских
 * курсов. Поддерживает два источника:
 *
 *   1. `sourceType='pgn'` — автор вставляет PGN вручную. Клиент валидирует
 *      через `chess.js#loadPgn` (быстрый фидбек). Backend дублирует
 *      валидацию + лимит 200 КБ (KS-3180).
 *   2. `sourceType='workshop_analysis'` — автор выбирает один из своих
 *      сохранённых анализов из workshop'а (`GET /analyses`). На submit
 *      отправляется ТОЛЬКО `analysisId`; backend сам читает `Analysis`,
 *      проверяет owner и кладёт snapshot `pgn`/`meta` в payload (см.
 *      KS-3180). Клиент не передаёт PGN-текст в этом режиме — backend
 *      перезапишет любое значение `pgn` snapshot'ом.
 *
 * Дизайн-решения:
 *  - Радио-сегмент сверху переключает источник. При переключении
 *    `pgn → workshop_analysis` мы НЕ стираем PGN-текст из локального
 *    state (только из payload), чтобы переключиться обратно и не
 *    потерять введённое. Симметрично — при выборе анализа сохраняем
 *    `analysisId` независимо от вида в PGN-textarea.
 *  - Список анализов грузится одним запросом (limit=100), для F1 этого
 *    хватает: типичный автор курса вряд ли держит >100 разборов. Поиск
 *    клиентский: фильтр по `title`/`white`/`black`/`event`. Lazy-load
 *    /pagination оставлен на следующую итерацию (если потребуется).
 *  - Валидация PGN — `new Chess().loadPgn()` в try/catch. PGN с
 *    отсутствующими тегами `[White]/[Black]` валиден (chess.js не
 *    требует тегов); пустая строка — не валидируется как «ошибка»,
 *    просто disabled submit-сигнал родителю (через payload без pgn).
 *  - `meta` (white/black/result/…) парсится из PGN-заголовка для UI-
 *    превью; на submit `meta` НЕ отправляется — backend сам соберёт
 *    из PGN при сохранении (см. KS-3180). Это снимает дублирование
 *    источника истины: при изменении тегов в PGN backend перепишет
 *    `meta` атомарно.
 */

interface GameStepEditorProps {
  payload: GameStepPayload;
  onChange: (next: GameStepPayload) => void;
}

interface PgnValidation {
  ok: boolean;
  /** Локализованный ключ ошибки. Пусто если PGN валиден или пуст. */
  errorKey: string | null;
}

function validatePgn(pgn: string): PgnValidation {
  const trimmed = pgn.trim();
  if (!trimmed) {
    return { ok: false, errorKey: null }; // пусто — disabled submit, но не ошибка
  }
  try {
    const chess = new Chess();
    chess.loadPgn(trimmed);
    return { ok: true, errorKey: null };
  } catch {
    return { ok: false, errorKey: 'lessons.my.editor.game.pgn.invalid' };
  }
}

function parsePgnMeta(pgn: string): GameStepMeta {
  const meta: GameStepMeta = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    const tag = m[1];
    const value = m[2];
    switch (tag) {
      case 'White':
        meta.white = value;
        break;
      case 'Black':
        meta.black = value;
        break;
      case 'Result':
        meta.result = value;
        break;
      case 'Date':
        meta.date = value;
        break;
      case 'Event':
        meta.event = value;
        break;
      case 'Site':
        meta.site = value;
        break;
      case 'Round':
        meta.round = value;
        break;
      default:
        break;
    }
  }
  return meta;
}

const MAX_PGN_BYTES = 200 * 1024; // ADR-072 §7 B1 / KS-3180

export function GameStepEditor({ payload, onChange }: GameStepEditorProps) {
  const { t } = useTranslation();

  // KS-3181: локальный буфер PGN. Хранится отдельно, чтобы переключение
  // sourceType не теряло набранный текст. На каждое реальное изменение
  // прокидываем в родительский payload только когда оно валидно (для
  // backend'а — иначе он отбросит 400; pre-validation в UserCourseEditor
  // дополнительно фильтрует пустой PGN, см. ниже).
  const [pgnDraft, setPgnDraft] = useState<string>(payload.pgn ?? '');

  // Если из родителя пришёл другой payload (sourceType переключился извне
  // или загружен другой шаг) — синхронизируем буфер.
  useEffect(() => {
    setPgnDraft(payload.pgn ?? '');
  }, [payload.pgn]);

  const validation = useMemo(() => validatePgn(pgnDraft), [pgnDraft]);
  const pgnByteLen = useMemo(
    () => new Blob([pgnDraft]).size,
    [pgnDraft],
  );
  const overLimit = pgnByteLen > MAX_PGN_BYTES;

  const onSourceTypeChange = useCallback(
    (next: 'pgn' | 'workshop_analysis') => {
      if (next === payload.sourceType) return;
      if (next === 'pgn') {
        onChange({
          type: 'game',
          sourceType: 'pgn',
          pgn: pgnDraft,
          meta: parsePgnMeta(pgnDraft),
        });
      } else {
        onChange({
          type: 'game',
          sourceType: 'workshop_analysis',
          // analysisId выберется отдельно; до выбора submit будет disabled.
        });
      }
    },
    [onChange, payload.sourceType, pgnDraft],
  );

  const onPgnTextareaChange = useCallback(
    (next: string) => {
      setPgnDraft(next);
      if (payload.sourceType !== 'pgn') return;
      // KS-3181: пушим в payload каждое изменение — родитель сам
      // решает, отправлять ли PATCH (isStepPayloadAutoSavable отсечёт
      // пустой/невалидный PGN). Это даёт мгновенный preview карточки
      // и автосейв после успешной валидации.
      onChange({
        type: 'game',
        sourceType: 'pgn',
        pgn: next,
        meta: parsePgnMeta(next),
      });
    },
    [onChange, payload.sourceType],
  );

  // ── workshop_analysis: список анализов ─────────────────────────────
  const [analyses, setAnalyses] = useState<AnalysisListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (payload.sourceType !== 'workshop_analysis') return;
    if (analyses !== null) return; // уже загружено
    let cancelled = false;
    api
      .get<AnalysisListItem[]>('/analyses?limit=100&offset=0')
      .then((res) => {
        if (cancelled) return;
        setAnalyses(res);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : String(err ?? 'unknown'),
        );
        setAnalyses([]);
      });
    return () => {
      cancelled = true;
    };
  }, [payload.sourceType, analyses]);

  const filteredAnalyses = useMemo(() => {
    if (!analyses) return null;
    const q = search.trim().toLowerCase();
    if (!q) return analyses;
    return analyses.filter((a) => {
      const haystack = [
        a.title,
        a.white,
        a.black,
        a.event,
        a.opening,
        a.headline,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [analyses, search]);

  const onPickAnalysis = useCallback(
    (analysis: AnalysisListItem) => {
      onChange({
        type: 'game',
        sourceType: 'workshop_analysis',
        analysisId: analysis.id,
        // KS-3181: PGN не присылаем — backend сделает snapshot
        // самостоятельно (см. KS-3180). UI до апдейта от backend
        // показывает meta из элемента списка для мгновенной обратной
        // связи. На следующем GET шаг придёт уже с заполненным `pgn`.
        meta: {
          white: analysis.white ?? undefined,
          black: analysis.black ?? undefined,
          result: analysis.result ?? undefined,
          event: analysis.event ?? undefined,
        },
      });
    },
    [onChange],
  );

  // ── Рендер ─────────────────────────────────────────────────────────
  return (
    <div
      className="game-step-editor"
      data-testid="game-step-editor"
      data-source-type={payload.sourceType}
    >
      <div
        className="game-step-editor__source-tabs"
        role="radiogroup"
        aria-label={t(
          'lessons.my.editor.game.sourceTabs.label',
          'Game source',
        )}
      >
        <button
          type="button"
          role="radio"
          aria-checked={payload.sourceType === 'pgn'}
          className={`game-step-editor__tab${payload.sourceType === 'pgn' ? ' game-step-editor__tab--active' : ''}`}
          data-testid="game-step-editor-tab-pgn"
          onClick={() => onSourceTypeChange('pgn')}
        >
          {t('lessons.my.editor.game.sourceTabs.pgn', 'PGN')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={payload.sourceType === 'workshop_analysis'}
          className={`game-step-editor__tab${payload.sourceType === 'workshop_analysis' ? ' game-step-editor__tab--active' : ''}`}
          data-testid="game-step-editor-tab-workshop"
          onClick={() => onSourceTypeChange('workshop_analysis')}
        >
          {t(
            'lessons.my.editor.game.sourceTabs.workshop',
            'From my analyses',
          )}
        </button>
      </div>

      {payload.sourceType === 'pgn' && (
        <div className="game-step-editor__pgn">
          <label
            htmlFor="game-step-editor-pgn-textarea"
            className="game-step-editor__label"
          >
            {t('lessons.my.editor.game.pgn.label', 'PGN')}
          </label>
          <textarea
            id="game-step-editor-pgn-textarea"
            data-testid="game-step-editor-pgn-textarea"
            className="game-step-editor__textarea"
            value={pgnDraft}
            onChange={(e) => onPgnTextareaChange(e.target.value)}
            rows={10}
            placeholder={t(
              'lessons.my.editor.game.pgn.placeholder',
              '[Event "..."]\n[White "..."]\n[Black "..."]\n\n1. e4 e5 2. Nf3 Nc6 ...',
            )}
            aria-invalid={validation.errorKey !== null || overLimit}
            data-invalid={
              validation.errorKey !== null || overLimit ? 'true' : 'false'
            }
          />
          {validation.errorKey && (
            <p
              className="game-step-editor__error"
              data-testid="game-step-editor-pgn-error"
              role="alert"
            >
              {t(
                validation.errorKey,
                'PGN is invalid — chess.js cannot parse it.',
              )}
            </p>
          )}
          {overLimit && (
            <p
              className="game-step-editor__error"
              data-testid="game-step-editor-pgn-over-limit"
              role="alert"
            >
              {t('lessons.my.editor.game.pgn.overLimit', {
                defaultValue:
                  'PGN exceeds 200 KB limit (current: {{kb}} KB).',
                kb: (pgnByteLen / 1024).toFixed(1),
              })}
            </p>
          )}
          {!validation.errorKey && pgnDraft.trim() && !overLimit && (
            <p
              className="game-step-editor__hint"
              data-testid="game-step-editor-pgn-ok"
            >
              {t('lessons.my.editor.game.pgn.ok', 'PGN parsed successfully.')}
            </p>
          )}
        </div>
      )}

      {payload.sourceType === 'workshop_analysis' && (
        <div className="game-step-editor__workshop">
          <label
            htmlFor="game-step-editor-search"
            className="game-step-editor__label"
          >
            {t(
              'lessons.my.editor.game.workshop.search',
              'Search analyses',
            )}
          </label>
          <input
            id="game-step-editor-search"
            data-testid="game-step-editor-workshop-search"
            className="game-step-editor__search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(
              'lessons.my.editor.game.workshop.searchPlaceholder',
              'White / Black / event / title',
            )}
          />

          {analyses === null && !loadError && (
            <p
              className="game-step-editor__hint"
              data-testid="game-step-editor-workshop-loading"
            >
              {t('common.loading', 'Loading…')}
            </p>
          )}

          {loadError && (
            <p
              className="game-step-editor__error"
              data-testid="game-step-editor-workshop-error"
              role="alert"
            >
              {t(
                'lessons.my.editor.game.workshop.loadError',
                'Could not load saved analyses.',
              )}
            </p>
          )}

          {analyses && analyses.length === 0 && !loadError && (
            <p
              className="game-step-editor__hint"
              data-testid="game-step-editor-workshop-empty"
            >
              {t(
                'lessons.my.editor.game.workshop.empty',
                'You have no saved analyses yet — open Workshop, save a game, then come back.',
              )}
            </p>
          )}

          {filteredAnalyses && filteredAnalyses.length > 0 && (
            <ul
              className="game-step-editor__analyses-list"
              data-testid="game-step-editor-workshop-list"
            >
              {filteredAnalyses.map((a) => {
                const selected = payload.analysisId === a.id;
                const subtitle = [a.white, a.black]
                  .filter(Boolean)
                  .join(' — ');
                return (
                  <li
                    key={a.id}
                    className={`game-step-editor__analysis-row${selected ? ' game-step-editor__analysis-row--selected' : ''}`}
                    data-testid={`game-step-editor-workshop-item-${a.id}`}
                    data-selected={selected ? 'true' : 'false'}
                  >
                    <button
                      type="button"
                      className="game-step-editor__analysis-btn"
                      onClick={() => onPickAnalysis(a)}
                    >
                      <span className="game-step-editor__analysis-title">
                        {a.title}
                      </span>
                      {subtitle && (
                        <span className="game-step-editor__analysis-subtitle">
                          {subtitle}
                          {a.result ? ` (${a.result})` : ''}
                        </span>
                      )}
                      {a.event && (
                        <span className="game-step-editor__analysis-event">
                          {a.event}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {filteredAnalyses &&
            filteredAnalyses.length === 0 &&
            analyses &&
            analyses.length > 0 && (
              <p
                className="game-step-editor__hint"
                data-testid="game-step-editor-workshop-search-empty"
              >
                {t(
                  'lessons.my.editor.game.workshop.searchEmpty',
                  'No analyses match the search.',
                )}
              </p>
            )}

          {!payload.analysisId && (
            <p
              className="game-step-editor__warn"
              data-testid="game-step-editor-workshop-no-selection"
            >
              {t(
                'lessons.my.editor.game.workshop.noSelection',
                'Pick an analysis to attach to this step.',
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
