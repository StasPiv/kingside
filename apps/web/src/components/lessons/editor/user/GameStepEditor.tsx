import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  AnalysisListItem,
  GameStepMeta,
  GameStepPayload,
} from '@kingside/shared';

import { api } from '../../../../api';
import { useDebouncedValue } from '../../../../hooks/useDebouncedValue';

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

/**
 * KS-3184: placeholder PGN, который мы создаём при добавлении нового
 * шага «Партия» (`emptyStepPayload('game')` → `pgn: '*'`). Это валидный
 * PGN (chess.js принимает; `IsNotEmpty` тоже — 1 символ), но семантически
 * пустой. В редакторе показываем такой PGN как чистое поле — иначе
 * автор увидит загадочную звёздочку в textarea.
 */
const PGN_PLACEHOLDER = '*';
function isPgnPlaceholder(pgn: string): boolean {
  return pgn.trim() === PGN_PLACEHOLDER;
}

export function GameStepEditor({ payload, onChange }: GameStepEditorProps) {
  const { t } = useTranslation();

  // KS-3181: локальный буфер PGN. Хранится отдельно, чтобы переключение
  // sourceType не теряло набранный текст. На каждое реальное изменение
  // прокидываем в родительский payload только когда оно валидно (для
  // backend'а — иначе он отбросит 400; pre-validation в UserCourseEditor
  // дополнительно фильтрует пустой PGN, см. ниже).
  //
  // KS-3184: новый шаг приходит с placeholder pgn=`*` (см. `emptyStepPayload`).
  // В UI это значение скрываем — автор должен видеть пустое поле, а не
  // загадочную звёздочку. При вводе реального PGN autosave заменит
  // placeholder обычным путём.
  const [pgnDraft, setPgnDraft] = useState<string>(() =>
    isPgnPlaceholder(payload.pgn ?? '') ? '' : payload.pgn ?? '',
  );

  // Если из родителя пришёл другой payload (sourceType переключился извне
  // или загружен другой шаг) — синхронизируем буфер.
  useEffect(() => {
    setPgnDraft(
      isPgnPlaceholder(payload.pgn ?? '') ? '' : payload.pgn ?? '',
    );
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
  /**
   * KS-3202 (v2 after KS-3203): server-side поиск через
   * `GET /analyses?search={q}`. Backend (KS-3203, коммит dd163305)
   * делает ILIKE по 8 полям (`headline / title / opening / event /
   * white / black / site / tags`), AND между словами, OR между полями,
   * case-insensitive. Pagination loop из первой итерации KS-3202
   * полностью удалён — теперь сервер всегда возвращает релевантные
   * анализы внутри обычного limit/offset (top-100 совпадений).
   *
   * `search` (raw) обновляется при каждом keypress'е (для контролируемого
   * input'а); `debouncedSearch` (300ms) триггерит сетевой запрос —
   * чтобы каждое нажатие не дёргало backend.
   */
  const [analyses, setAnalyses] = useState<AnalysisListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  useEffect(() => {
    if (payload.sourceType !== 'workshop_analysis') return;
    let cancelled = false;
    const q = debouncedSearch.trim();
    const url =
      q.length > 0
        ? `/analyses?limit=100&offset=0&search=${encodeURIComponent(q)}`
        : `/analyses?limit=100&offset=0`;
    setLoading(true);
    api
      .get<AnalysisListItem[]>(url)
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
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payload.sourceType, debouncedSearch]);

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

          {analyses &&
            analyses.length === 0 &&
            !loadError &&
            debouncedSearch.trim() === '' && (
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

          {analyses && analyses.length > 0 && (
            <ul
              className="game-step-editor__analyses-list"
              data-testid="game-step-editor-workshop-list"
              data-loading={loading ? 'true' : 'false'}
            >
              {analyses.map((a) => {
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

          {/* KS-3202 (v2): empty-state при server-side поиске. Кнопка
              «Сбросить фильтр» очищает search → useEffect перезапросит
              `/analyses` без `?search=` (весь список, top-100). Под
              «total» теперь подразумеваем «совпадений сейчас» — backend
              не возвращает общее количество, и мы намеренно его не
              запрашиваем (KS-3203 контракт: search OR limit/offset, без
              total-count). */}
          {analyses &&
            analyses.length === 0 &&
            !loadError &&
            debouncedSearch.trim() !== '' && (
              <div
                className="game-step-editor__hint"
                data-testid="game-step-editor-workshop-search-empty"
              >
                <p style={{ margin: 0 }}>
                  {t(
                    'lessons.my.editor.game.workshop.searchEmpty',
                    'No analyses match the search.',
                  )}
                </p>
                <button
                  type="button"
                  className="game-step-editor__reset-filter"
                  data-testid="game-step-editor-workshop-reset-filter"
                  onClick={() => setSearch('')}
                  style={{ marginTop: 4 }}
                >
                  {t(
                    'lessons.my.editor.game.workshop.resetFilter',
                    'Reset filter',
                  )}
                </button>
              </div>
            )}

          {/* KS-3202 (v2): counter «N результатов» при активном поиске.
              Помогает автору понять «нашёл 7 совпадений» без ручного
              пересчёта. Когда поиск пуст — показываем «N анализов»
              (это top-100 первой страницы; реальное общее количество
              backend не возвращает, и для UX редактора курса этого
              достаточно — автор найдёт нужное через поиск). */}
          {analyses && analyses.length > 0 && (
            <p
              className="game-step-editor__total"
              data-testid="game-step-editor-workshop-total"
              style={{ fontSize: 12, opacity: 0.7, margin: '4px 0 0' }}
            >
              {debouncedSearch.trim() !== ''
                ? t('lessons.my.editor.game.workshop.matches', {
                    defaultValue: '{{count}} matches',
                    count: analyses.length,
                  })
                : t('lessons.my.editor.game.workshop.total', {
                    defaultValue: '{{total}} analyses',
                    total: analyses.length,
                  })}
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
